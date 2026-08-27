import { formatHex, parseHex } from "./codec";
import {
  compileCommandTemplate,
  renderCommandTemplate,
  type CompiledCommandTemplate,
} from "./commandTemplate";
import type { PreparedCommand } from "./commandWorkflow";
import { LINE_ENDINGS, type LineEnding } from "../types/serial";
import type {
  AutoResponderRule,
  AutoResponderSnapshot,
} from "../types/automation";
import type { TerminalTextEncoding } from "../types/workbench";
import { encodeText } from "./textEncoding";

export const MAX_AUTO_RESPONDER_RULES = 16;
export const MAX_AUTO_RESPONDER_NAME_LENGTH = 64;
export const MAX_AUTO_RESPONDER_TRIGGER_BYTES = 256;
export const MAX_AUTO_RESPONDER_TRIGGER_SOURCE_BYTES = 4 * 1024;
export const MAX_AUTO_RESPONDER_RESPONSE_TEMPLATE_BYTES = 4 * 1024;
export const MIN_AUTO_RESPONDER_COOLDOWN_MS = 20;
export const MAX_AUTO_RESPONDER_COOLDOWN_MS = 24 * 60 * 60 * 1_000;
export const MAX_AUTO_RESPONDER_QUEUE_SIZE = 32;
export const MAX_AUTO_RESPONDER_SESSION_RESPONSES = 1_000;
export const MAX_AUTO_RESPONDER_MATCHES_PER_BATCH = 64;
export const MAX_AUTO_RESPONDER_RX_BATCH_BYTES = 64 * 1024;

const AUTO_RESPONDER_RULE_KEYS = [
  "id",
  "name",
  "enabled",
  "triggerMode",
  "trigger",
  "responseMode",
  "response",
  "lineEnding",
  "cooldownMs",
] as const;
const AUTO_RESPONDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_COMMAND_WAITERS = 8;

export type AutoResponderStopReason =
  | "user"
  | "connection-change"
  | "connection-lost"
  | "source-change"
  | "protocol-change"
  | "workspace-change"
  | "replay-open"
  | "runtime-dispose"
  | "rule-change"
  | "stream-reset";

export interface AutoResponderDispatch {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly sequence: number;
  readonly receivedAt: number;
  readonly command: PreparedCommand;
}

export interface AutoResponderDependencies {
  now(): number;
  send(dispatch: AutoResponderDispatch, signal: AbortSignal): Promise<void>;
  onSnapshot(snapshot: AutoResponderSnapshot): void;
}

interface CompiledRule {
  readonly rule: AutoResponderRule;
  readonly triggerBytes: Uint8Array;
  readonly prefixTable: Uint16Array;
  readonly responseTemplate: CompiledCommandTemplate;
  matchLength: number;
  lastAcceptedAt: number;
}

interface PendingDispatch {
  readonly dispatch: AutoResponderDispatch;
}

export function createInitialAutoResponderSnapshot(): AutoResponderSnapshot {
  return {
    status: "off",
    sessionId: 0,
    enabledRuleCount: 0,
    matchCount: 0,
    acceptedCount: 0,
    queuedCount: 0,
    sentCount: 0,
    cooldownDropCount: 0,
    message: "自动应答未启用",
  };
}

export function isAutoResponderActive(snapshot: AutoResponderSnapshot): boolean {
  return snapshot.status === "armed" || snapshot.status === "sending" ||
    snapshot.status === "stopping";
}

export function cloneAutoResponderRules(
  rules: readonly AutoResponderRule[],
): AutoResponderRule[] {
  return rules.map((rule) => ({ ...rule }));
}

export function areAutoResponderRulesEqual(
  left: readonly AutoResponderRule[],
  right: readonly AutoResponderRule[],
): boolean {
  return left.length === right.length && left.every((rule, index) => {
    const candidate = right[index];
    return candidate !== undefined &&
      rule.id === candidate.id &&
      rule.name === candidate.name &&
      rule.enabled === candidate.enabled &&
      rule.triggerMode === candidate.triggerMode &&
      rule.trigger === candidate.trigger &&
      rule.responseMode === candidate.responseMode &&
      rule.response === candidate.response &&
      rule.lineEnding === candidate.lineEnding &&
      rule.cooldownMs === candidate.cooldownMs;
  });
}

export function parseAutoResponderRules(
  value: unknown,
  allowedLineEndings: readonly LineEnding[] = LINE_ENDINGS,
): AutoResponderRule[] {
  if (!Array.isArray(value)) {
    throw new Error("自动应答规则必须是数组");
  }
  if (value.length > MAX_AUTO_RESPONDER_RULES) {
    throw new Error(`自动应答最多包含 ${MAX_AUTO_RESPONDER_RULES} 条规则`);
  }

  const rules = value.map((rule) => parseAutoResponderRule(rule, allowedLineEndings));
  const usedIds = new Set<string>();
  for (const rule of rules) {
    if (usedIds.has(rule.id)) {
      throw new Error(`自动应答规则 ID 重复：${rule.id}`);
    }
    usedIds.add(rule.id);
  }
  return rules;
}

export function createDefaultAutoResponderRule(
  id: string,
  name = "新建规则",
): AutoResponderRule {
  return parseAutoResponderRule(
    {
      id,
      name,
      enabled: true,
      triggerMode: "hex",
      trigger: "0A",
      responseMode: "text",
      response: "ACK",
      lineEnding: "none",
      cooldownMs: 1_000,
    },
    LINE_ENDINGS,
  );
}

export class AutoResponderRuntime {
  private operation = 0;
  private snapshot = createInitialAutoResponderSnapshot();
  private compiledRules: CompiledRule[] = [];
  private queue: PendingDispatch[] = [];
  private abortController = new AbortController();
  private pumping = false;
  private inFlight = false;
  private stopAfterDrain = false;
  private pendingStopReason: AutoResponderStopReason = "user";
  private lastReceivedAt = 0;

  constructor(private readonly dependencies: AutoResponderDependencies) {}

  getSnapshot(): AutoResponderSnapshot {
    return { ...this.snapshot };
  }

  isActive(): boolean {
    return isAutoResponderActive(this.snapshot);
  }

  start(
    rules: readonly AutoResponderRule[],
    rxTextEncoding: TerminalTextEncoding = "utf-8",
    txTextEncoding: TerminalTextEncoding = "utf-8",
  ): void {
    if (this.isActive() || this.pumping) {
      throw new Error("自动应答仍在运行或停止中");
    }
    const parsedRules = parseAutoResponderRules(rules);
    const compiledRules = parsedRules
      .filter((rule) => rule.enabled)
      .map((rule) => compileRule(rule, rxTextEncoding, txTextEncoding));
    if (compiledRules.length === 0) {
      throw new Error("至少需要启用一条自动应答规则");
    }

    const startedAt = this.dependencies.now();
    this.operation += 1;
    this.compiledRules = compiledRules;
    this.queue = [];
    this.abortController = new AbortController();
    this.stopAfterDrain = false;
    this.lastReceivedAt = startedAt;
    this.updateSnapshot({
      status: "armed",
      sessionId: this.snapshot.sessionId + 1,
      enabledRuleCount: compiledRules.length,
      matchCount: 0,
      acceptedCount: 0,
      queuedCount: 0,
      sentCount: 0,
      cooldownDropCount: 0,
      message: `自动应答已启用，共 ${compiledRules.length} 条规则`,
      startedAt,
      finishedAt: undefined,
      lastRuleId: undefined,
      lastRuleName: undefined,
      lastError: undefined,
    });
  }

  stop(reason: AutoResponderStopReason = "user"): boolean {
    if (!this.isActive()) {
      return false;
    }
    if (this.snapshot.status === "stopping" && !this.stopAfterDrain) {
      return false;
    }
    this.operation += 1;
    this.pendingStopReason = reason;
    this.stopAfterDrain = false;
    this.queue = [];
    this.abortController.abort();
    this.compiledRules = [];
    if (this.inFlight || this.pumping) {
      this.updateSnapshot({
        ...this.snapshot,
        status: "stopping",
        queuedCount: 0,
        message: "正在停止，等待当前自动发送完成",
      });
    } else {
      this.finishStopped();
    }
    return true;
  }

  ingest(bytes: Uint8Array, receivedAt: number): void {
    if (this.snapshot.status !== "armed" && this.snapshot.status !== "sending") {
      return;
    }
    if (bytes.length > MAX_AUTO_RESPONDER_RX_BATCH_BYTES) {
      this.fail(`单批 RX 超过 ${MAX_AUTO_RESPONDER_RX_BATCH_BYTES / 1024} KiB 安全上限`);
      return;
    }

    const safeReceivedAt = Number.isFinite(receivedAt)
      ? Math.max(this.lastReceivedAt, Math.trunc(receivedAt))
      : Math.max(this.lastReceivedAt, this.dependencies.now());
    this.lastReceivedAt = safeReceivedAt;
    let batchMatches = 0;

    for (const byte of bytes) {
      for (const compiled of this.compiledRules) {
        while (
          compiled.matchLength > 0 &&
          compiled.triggerBytes[compiled.matchLength] !== byte
        ) {
          compiled.matchLength = compiled.prefixTable[compiled.matchLength - 1] ?? 0;
        }
        if (compiled.triggerBytes[compiled.matchLength] === byte) {
          compiled.matchLength += 1;
        }
        if (compiled.matchLength !== compiled.triggerBytes.length) {
          continue;
        }

        compiled.matchLength = compiled.prefixTable[compiled.matchLength - 1] ?? 0;
        batchMatches += 1;
        this.snapshot.matchCount += 1;
        if (batchMatches > MAX_AUTO_RESPONDER_MATCHES_PER_BATCH) {
          this.fail(
            `单批匹配超过 ${MAX_AUTO_RESPONDER_MATCHES_PER_BATCH} 次，自动应答已停机`,
          );
          return;
        }
        if (safeReceivedAt - compiled.lastAcceptedAt < compiled.rule.cooldownMs) {
          this.snapshot.cooldownDropCount += 1;
          continue;
        }
        if (!this.enqueue(compiled, safeReceivedAt)) {
          return;
        }
        if (this.stopAfterDrain) {
          this.publishQueueState();
          void this.pump(this.operation);
          return;
        }
      }
    }

    this.publishQueueState();
    void this.pump(this.operation);
  }

  private enqueue(compiled: CompiledRule, receivedAt: number): boolean {
    if (this.snapshot.acceptedCount >= MAX_AUTO_RESPONDER_SESSION_RESPONSES) {
      this.beginSessionLimitStop();
      return false;
    }
    const outstanding = this.queue.length + (this.inFlight ? 1 : 0);
    if (outstanding >= MAX_AUTO_RESPONDER_QUEUE_SIZE) {
      this.fail(`自动应答队列达到 ${MAX_AUTO_RESPONDER_QUEUE_SIZE} 条，已清空并停机`);
      return false;
    }

    const sequence = this.snapshot.acceptedCount + 1;
    let command: PreparedCommand;
    try {
      const rendered = renderCommandTemplate(
        compiled.responseTemplate,
        {
          sequence,
          nowMs: receivedAt,
          taskStartedAtMs: this.snapshot.startedAt ?? receivedAt,
        },
        compiled.rule.lineEnding,
      );
      if (rendered.bytes.length === 0) {
        throw new Error("响应内容不能为空");
      }
      command = {
        value: compiled.responseTemplate.source,
        mode: compiled.responseTemplate.mode,
        lineEnding: compiled.rule.lineEnding,
        checksumMode: "none",
        textEncoding: compiled.responseTemplate.textEncoding,
        bytes: Uint8Array.from(rendered.bytes),
        variableCount: rendered.variableCount,
      };
    } catch (error) {
      this.fail(getErrorMessage(error));
      return false;
    }

    compiled.lastAcceptedAt = receivedAt;
    this.queue.push({
      dispatch: {
        ruleId: compiled.rule.id,
        ruleName: compiled.rule.name,
        sequence,
        receivedAt,
        command,
      },
    });
    this.snapshot.acceptedCount = sequence;
    this.snapshot.lastRuleId = compiled.rule.id;
    this.snapshot.lastRuleName = compiled.rule.name;
    if (sequence >= MAX_AUTO_RESPONDER_SESSION_RESPONSES) {
      this.beginSessionLimitStop();
    }
    return true;
  }

  private async pump(operation: number): Promise<void> {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    try {
      while (
        operation === this.operation &&
        this.queue.length > 0 &&
        (this.snapshot.status === "armed" ||
          this.snapshot.status === "sending" ||
          (this.snapshot.status === "stopping" && this.stopAfterDrain))
      ) {
        const pending = this.queue.shift();
        if (!pending) {
          break;
        }
        this.inFlight = true;
        if (!this.stopAfterDrain) {
          this.updateSnapshot({
            ...this.snapshot,
            status: "sending",
            queuedCount: this.queue.length,
            message: `正在发送规则“${pending.dispatch.ruleName}”`,
          });
        } else {
          this.publishQueueState();
        }

        let sent = false;
        try {
          await this.dependencies.send(pending.dispatch, this.abortController.signal);
          sent = true;
        } catch (error) {
          this.inFlight = false;
          if (operation !== this.operation) {
            this.finishAfterInterruptedPump();
            return;
          }
          this.fail(`发送失败：${getErrorMessage(error)}`);
          return;
        }
        this.inFlight = false;

        if (sent) {
          this.updateSnapshot({
            ...this.snapshot,
            sentCount: this.snapshot.sentCount + 1,
            queuedCount: this.queue.length,
          });
        }
        if (operation !== this.operation) {
          this.finishAfterInterruptedPump();
          return;
        }
      }

      if (operation !== this.operation) {
        this.finishAfterInterruptedPump();
      } else if (this.stopAfterDrain && this.queue.length === 0) {
        this.pendingStopReason = "user";
        this.updateSnapshot({
          ...this.snapshot,
          status: "stopped",
          queuedCount: 0,
          message: `已达到会话上限，成功发送 ${this.snapshot.sentCount} 次`,
          finishedAt: this.dependencies.now(),
        });
        this.compiledRules = [];
      } else if (this.snapshot.status !== "error") {
        this.updateSnapshot({
          ...this.snapshot,
          status: "armed",
          queuedCount: 0,
          message: `自动应答运行中，已发送 ${this.snapshot.sentCount} 次`,
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  private beginSessionLimitStop(): void {
    this.stopAfterDrain = true;
    this.updateSnapshot({
      ...this.snapshot,
      status: "stopping",
      queuedCount: this.queue.length,
      message: `已达到 ${MAX_AUTO_RESPONDER_SESSION_RESPONSES} 次会话上限，正在完成队列`,
    });
  }

  private fail(message: string): void {
    this.operation += 1;
    this.stopAfterDrain = false;
    this.queue = [];
    this.abortController.abort();
    this.compiledRules = [];
    this.updateSnapshot({
      ...this.snapshot,
      status: "error",
      queuedCount: 0,
      message,
      finishedAt: this.dependencies.now(),
      lastError: message,
    });
  }

  private finishAfterInterruptedPump(): void {
    if (this.snapshot.status === "stopping") {
      this.finishStopped();
    }
  }

  private finishStopped(): void {
    this.updateSnapshot({
      ...this.snapshot,
      status: "stopped",
      queuedCount: 0,
      message: stopMessage(this.pendingStopReason, this.snapshot.sentCount),
      finishedAt: this.dependencies.now(),
      lastError: undefined,
    });
  }

  private publishQueueState(): void {
    if (this.snapshot.status === "error") {
      return;
    }
    this.updateSnapshot({
      ...this.snapshot,
      queuedCount: this.queue.length,
    });
  }

  private updateSnapshot(snapshot: AutoResponderSnapshot): void {
    this.snapshot = snapshot;
    this.dependencies.onSnapshot({ ...snapshot });
  }
}

export type CommandSendOrigin = "manual" | "scheduler" | "auto-responder";

interface CommandWaiter {
  readonly origin: CommandSendOrigin;
  readonly signal?: AbortSignal;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  abortListener?: () => void;
}

export class CommandSendArbiter {
  private owner: CommandSendOrigin | null = null;
  private manualWaiters: CommandWaiter[] = [];
  private automaticWaiters: CommandWaiter[] = [];

  isBusy(): boolean {
    return this.owner !== null;
  }

  getOrigin(): CommandSendOrigin | null {
    return this.owner;
  }

  cancelPending(message = "发送上下文已变更"): number {
    const waiters = [...this.manualWaiters, ...this.automaticWaiters];
    this.manualWaiters = [];
    this.automaticWaiters = [];
    for (const waiter of waiters) {
      if (waiter.signal && waiter.abortListener) {
        waiter.signal.removeEventListener("abort", waiter.abortListener);
      }
      waiter.reject(new Error(message));
    }
    return waiters.length;
  }

  run<T>(
    origin: CommandSendOrigin,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(new Error("自动应答发送已取消"));
    }
    if (this.owner === null) {
      this.owner = origin;
      return this.executeOwned(signal, operation);
    }
    return this.waitForTurn(origin, signal).then(() => this.executeOwned(signal, operation));
  }

  private executeOwned<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      if (signal?.aborted) {
        this.release();
        return Promise.reject(new Error("自动应答发送已取消"));
      }
      return operation().finally(() => this.release());
    } catch (error) {
      this.release();
      return Promise.reject(error);
    }
  }

  private waitForTurn(origin: CommandSendOrigin, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new Error("自动应答发送已取消"));
    }
    if (origin === "scheduler") {
      return Promise.reject(new Error("上一次发送尚未完成"));
    }
    if (this.manualWaiters.length + this.automaticWaiters.length >= MAX_COMMAND_WAITERS) {
      return Promise.reject(new Error("发送等待队列已满"));
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: CommandWaiter = { origin, signal, resolve, reject };
      if (signal) {
        waiter.abortListener = () => {
          if (this.removeWaiter(waiter)) {
            reject(new Error("自动应答发送已取消"));
          }
        };
        signal.addEventListener("abort", waiter.abortListener, { once: true });
      }
      if (origin === "manual") {
        this.manualWaiters.push(waiter);
      } else {
        this.automaticWaiters.push(waiter);
      }
    });
  }

  private release(): void {
    const next = this.manualWaiters.shift() ?? this.automaticWaiters.shift();
    if (!next) {
      this.owner = null;
      return;
    }
    if (next.signal && next.abortListener) {
      next.signal.removeEventListener("abort", next.abortListener);
    }
    this.owner = next.origin;
    next.resolve();
  }

  private removeWaiter(waiter: CommandWaiter): boolean {
    const queue = waiter.origin === "manual" ? this.manualWaiters : this.automaticWaiters;
    const index = queue.indexOf(waiter);
    if (index < 0) {
      return false;
    }
    queue.splice(index, 1);
    if (waiter.signal && waiter.abortListener) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
    }
    return true;
  }
}

function parseAutoResponderRule(
  value: unknown,
  allowedLineEndings: readonly LineEnding[],
): AutoResponderRule {
  const record = requireRecord(value, "自动应答规则");
  assertExactKeys(record, AUTO_RESPONDER_RULE_KEYS, "自动应答规则");
  const id = requireString(record.id, "规则 ID");
  if (!AUTO_RESPONDER_ID_PATTERN.test(id)) {
    throw new Error("规则 ID 只能包含字母、数字、下划线和连字符，且不能超过 64 个字符");
  }
  const name = requireString(record.name, "规则名称").trim();
  if (!name || name.length > MAX_AUTO_RESPONDER_NAME_LENGTH || containsControlCharacter(name)) {
    throw new Error(`规则名称必须为 1 到 ${MAX_AUTO_RESPONDER_NAME_LENGTH} 个无控制字符文本`);
  }
  const triggerMode = requireEnum(record.triggerMode, ["text", "hex"], "触发格式");
  const triggerSource = requireString(record.trigger, "触发内容");
  if (new TextEncoder().encode(triggerSource).byteLength > MAX_AUTO_RESPONDER_TRIGGER_SOURCE_BYTES) {
    throw new Error(
      `触发内容文本不能超过 ${MAX_AUTO_RESPONDER_TRIGGER_SOURCE_BYTES / 1024} KiB`,
    );
  }
  if (triggerMode === "text" && triggerSource.length === 0) {
    throw new Error("触发内容不能为空");
  }
  const trigger =
    triggerMode === "hex" ? formatHex(compileTrigger(triggerSource, triggerMode)) : triggerSource;
  const responseMode = requireEnum(record.responseMode, ["text", "hex"], "响应格式");
  const response = requireString(record.response, "响应内容");
  if (new TextEncoder().encode(response).byteLength > MAX_AUTO_RESPONDER_RESPONSE_TEMPLATE_BYTES) {
    throw new Error(
      `响应模板不能超过 ${MAX_AUTO_RESPONDER_RESPONSE_TEMPLATE_BYTES / 1024} KiB`,
    );
  }
  const lineEnding = requireEnum(record.lineEnding, allowedLineEndings, "响应行尾");
  const responseTemplate = compileCommandTemplate(response, responseMode);
  if (
    renderCommandTemplate(
      responseTemplate,
      { sequence: 1, nowMs: 0, taskStartedAtMs: 0 },
      lineEnding,
    ).bytes.length === 0
  ) {
    throw new Error("响应内容不能为空");
  }
  const cooldownMs = requireInteger(record.cooldownMs, "冷却时间");
  if (
    cooldownMs < MIN_AUTO_RESPONDER_COOLDOWN_MS ||
    cooldownMs > MAX_AUTO_RESPONDER_COOLDOWN_MS
  ) {
    throw new Error(
      `冷却时间必须是 ${MIN_AUTO_RESPONDER_COOLDOWN_MS} 到 ` +
        `${MAX_AUTO_RESPONDER_COOLDOWN_MS} 毫秒的整数`,
    );
  }

  return {
    id,
    name,
    enabled: requireBoolean(record.enabled, "规则启用状态"),
    triggerMode,
    trigger,
    responseMode,
    response,
    lineEnding,
    cooldownMs,
  };
}

function compileRule(
  rule: AutoResponderRule,
  rxTextEncoding: TerminalTextEncoding,
  txTextEncoding: TerminalTextEncoding,
): CompiledRule {
  const triggerBytes = compileTrigger(rule.trigger, rule.triggerMode, rxTextEncoding);
  return {
    rule: { ...rule },
    triggerBytes,
    prefixTable: createPrefixTable(triggerBytes),
    responseTemplate: compileCommandTemplate(rule.response, rule.responseMode, txTextEncoding),
    matchLength: 0,
    lastAcceptedAt: Number.NEGATIVE_INFINITY,
  };
}

function compileTrigger(
  value: string,
  mode: AutoResponderRule["triggerMode"],
  textEncoding: TerminalTextEncoding = "utf-8",
): Uint8Array {
  const bytes = mode === "hex" ? parseHex(value) : encodeText(value, textEncoding);
  if (bytes.length === 0) {
    throw new Error("触发内容不能为空");
  }
  if (bytes.length > MAX_AUTO_RESPONDER_TRIGGER_BYTES) {
    throw new Error(`触发内容不能超过 ${MAX_AUTO_RESPONDER_TRIGGER_BYTES} 字节`);
  }
  return bytes;
}

function createPrefixTable(pattern: Uint8Array): Uint16Array {
  const prefixTable = new Uint16Array(pattern.length);
  let prefixLength = 0;
  for (let index = 1; index < pattern.length; index += 1) {
    while (prefixLength > 0 && pattern[index] !== pattern[prefixLength]) {
      prefixLength = prefixTable[prefixLength - 1] ?? 0;
    }
    if (pattern[index] === pattern[prefixLength]) {
      prefixLength += 1;
    }
    prefixTable[index] = prefixLength;
  }
  return prefixTable;
}

function stopMessage(reason: AutoResponderStopReason, sentCount: number): string {
  const messages: Record<AutoResponderStopReason, string> = {
    user: "已手动停止",
    "connection-change": "连接状态变更，自动应答已停止",
    "connection-lost": "连接已中断，自动应答已停止",
    "source-change": "数据源已切换，自动应答已停止",
    "protocol-change": "协议已切换，自动应答已停止",
    "workspace-change": "工作区已切换，自动应答已停止",
    "replay-open": "已进入回放流程，自动应答已停止",
    "runtime-dispose": "运行环境已卸载，自动应答已停止",
    "rule-change": "规则已变更，自动应答已停止",
    "stream-reset": "实时数据流已重置，自动应答已停止",
  };
  return `${messages[reason]}，成功发送 ${sentCount} 次`;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}必须是对象`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label}必须是字符串`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label}必须是布尔值`);
  }
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label}必须是安全整数`);
  }
  return value as number;
}

function requireEnum<const T>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (!allowed.some((candidate) => candidate === value)) {
    throw new Error(`${label}无效`);
  }
  return value as T;
}

function assertExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  const unknown = Object.keys(record).find((key) => !expected.has(key));
  const missing = keys.find((key) => !Object.hasOwn(record, key));
  if (unknown) {
    throw new Error(`${label}包含未知字段：${unknown}`);
  }
  if (missing) {
    throw new Error(`${label}缺少字段：${missing}`);
  }
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || (code >= 127 && code <= 159);
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
