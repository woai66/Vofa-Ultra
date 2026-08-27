import type {
  ConnectionStatus,
  SerialConfig,
  SerialControlLine,
  SerialDiagnosticEvent,
  SerialDiagnosticsReport,
  SerialErrorCode,
  SerialPortInfo,
  SerialReconnectTarget,
  SerialRecoveryPhase,
  SerialRecoverySnapshot,
  SerialStatePayload,
} from "../types/serial";

export const SERIAL_RECOVERY_DELAYS_MS = [
  0,
  500,
  1_000,
  2_000,
  4_000,
  8_000,
  16_000,
  30_000,
  30_000,
  30_000,
] as const;

const MAX_DIAGNOSTIC_EVENTS = 256;
const MAX_DIAGNOSTIC_EXPORT_BYTES = 128 * 1024;

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export type SerialRecoveryCancellationReason =
  | "disabled"
  | "manual-connect"
  | "manual-disconnect"
  | "source-change"
  | "workspace-change"
  | "replay-open"
  | "runtime-dispose"
  | "user-cancelled";

export type SerialTargetMatch =
  | { status: "missing"; candidateCount: 0 }
  | { status: "matched"; candidateCount: 1; port: SerialPortInfo }
  | { status: "ambiguous"; candidateCount: number };

export interface SerialRecoveryDependencies {
  now(): number;
  setTimer(callback: () => void, delayMs: number): TimerHandle;
  clearTimer(timer: TimerHandle): void;
  listPorts(): Promise<SerialPortInfo[]>;
  connect(config: SerialConfig): Promise<SerialStatePayload>;
  cancelPendingConnection(): Promise<void>;
  prepareCaptureBoundary(): Promise<boolean>;
  applyBackendState(payload: SerialStatePayload): void;
  updatePorts(ports: SerialPortInfo[]): void;
  updatePortName(portName: string): void;
  resetStreamAfterReconnect(): void;
  onSnapshot(snapshot: SerialRecoverySnapshot): void;
}

interface DiagnosticInput {
  kind: string;
  attempt?: number;
  delayMs?: number;
  generation?: number;
  revision?: number;
  errorCode?: string;
  candidateCount?: number;
  outcome?: string;
}

interface DiagnosticsContext {
  appVersion: string;
  connectionStatus: ConnectionStatus;
  generation: number;
  revision: number;
  serialConfig: SerialConfig;
}

export class SerialReconnectCoordinator {
  private readonly dependencies: SerialRecoveryDependencies;
  private readonly diagnostics: SerialDiagnosticLog;
  private enabled = false;
  private phase: SerialRecoveryPhase = "off";
  private attempt = 0;
  private nextAttemptAt: number | undefined;
  private message = "自动重连未启用";
  private timer: TimerHandle | undefined;
  private epoch = 0;
  private settingsOperation = 0;
  private recovering = false;
  private target: SerialReconnectTarget | null = null;
  private config: SerialConfig | null = null;
  private manualConnectionPending = false;
  private armedGeneration: number | undefined;
  private lastConnectedRevision = -1;
  private lastFailureRevision = 0;
  private lastAttemptErrorCode: SerialErrorCode | undefined;

  constructor(dependencies: SerialRecoveryDependencies) {
    this.dependencies = dependencies;
    this.diagnostics = new SerialDiagnosticLog(dependencies.now);
  }

  getSnapshot(): SerialRecoverySnapshot {
    return {
      enabled: this.enabled,
      phase: this.phase,
      attempt: this.attempt,
      maxAttempts: SERIAL_RECOVERY_DELAYS_MS.length,
      nextAttemptAt: this.nextAttemptAt,
      message: this.message,
      diagnosticEventCount: this.diagnostics.size,
      diagnosticDroppedEvents: this.diagnostics.droppedEvents,
    };
  }

  async setEnabled(
    enabled: boolean,
    context: {
      status: ConnectionStatus;
      generation: number;
      config: SerialConfig;
      port?: SerialPortInfo;
    },
  ): Promise<void> {
    const operation = ++this.settingsOperation;
    if (!enabled) {
      this.enabled = false;
      const cancellation = this.cancel("disabled", true);
      this.target = null;
      this.config = null;
      this.armedGeneration = undefined;
      this.lastConnectedRevision = -1;
      this.lastFailureRevision = 0;
      this.phase = "off";
      this.message = "自动重连未启用";
      await cancellation;
      if (operation !== this.settingsOperation) {
        return;
      }
      this.record({ kind: "recovery_disabled", generation: context.generation });
      return;
    }

    this.enabled = true;
    this.config = { ...context.config };
    this.target = createSerialReconnectTarget(context.port);
    if (context.status === "connected") {
      this.armOrBlock(context.generation);
    } else {
      this.phase = "idle";
      this.message = "自动重连将在手动连接成功后待命";
      this.record({ kind: "recovery_enabled", generation: context.generation });
    }
    this.notify();
  }

  prepareManualConnection(config: SerialConfig, port?: SerialPortInfo): void {
    this.bumpEpoch();
    this.recovering = false;
    this.attempt = 0;
    this.nextAttemptAt = undefined;
    this.armedGeneration = undefined;
    this.manualConnectionPending = true;
    this.config = { ...config };
    this.target = createSerialReconnectTarget(port);
    this.phase = this.enabled ? "idle" : "off";
    this.message = this.enabled ? "正在建立手动连接" : "自动重连未启用";
    this.notify();
  }

  updateConfig(config: SerialConfig): void {
    if (this.config) {
      this.config = { ...config };
    }
  }

  recordControlLineFailure(
    line: SerialControlLine,
    generation: number,
    errorCode: string,
  ): void {
    this.record({
      kind: "control_line_failed",
      generation,
      errorCode,
      outcome: line,
    });
  }

  recordManualConnectionFailure(input: {
    generation?: number;
    revision?: number;
    errorCode?: string;
  }): void {
    if (!this.manualConnectionPending || this.recovering) {
      return;
    }
    this.manualConnectionPending = false;
    if (input.revision !== undefined) {
      this.lastFailureRevision = Math.max(this.lastFailureRevision, input.revision);
    }
    this.record({ kind: "manual_connect_failed", ...input });
  }

  observeState(payload: SerialStatePayload, previousStatus: ConnectionStatus): boolean {
    if (payload.status === "disconnected") {
      this.bumpEpoch();
      this.recovering = false;
      this.attempt = 0;
      this.nextAttemptAt = undefined;
      this.armedGeneration = undefined;
      this.manualConnectionPending = false;
      this.lastAttemptErrorCode = undefined;
      this.phase = this.enabled ? "idle" : "off";
      this.message = this.enabled ? "自动重连将在手动连接成功后待命" : "自动重连未启用";
      this.notify();
      return false;
    }

    if (payload.status === "connected") {
      if (payload.revision <= this.lastConnectedRevision) {
        return false;
      }
      this.lastConnectedRevision = payload.revision;
      this.handleConnected(payload);
      return false;
    }

    if (payload.status === "error" && this.phase === "connecting") {
      this.lastAttemptErrorCode = payload.errorCode;
    }

    if (
      payload.status === "error" &&
      this.manualConnectionPending &&
      !this.recovering &&
      previousStatus !== "connected"
    ) {
      this.recordManualConnectionFailure({
        generation: payload.generation,
        revision: payload.revision,
        errorCode: payload.errorCode,
      });
      return false;
    }

    if (
      payload.status === "error" &&
      previousStatus === "connected" &&
      payload.revision > this.lastFailureRevision
    ) {
      this.lastFailureRevision = payload.revision;
      this.record({
        kind: "connection_lost",
        generation: payload.generation,
        revision: payload.revision,
        errorCode: payload.errorCode,
      });
      if (payload.generation === this.armedGeneration) {
        return this.startRecovery();
      }
    }
    return false;
  }

  async cancel(
    reason: SerialRecoveryCancellationReason,
    cancelBackend: boolean,
  ): Promise<void> {
    const wasConnecting = this.phase === "connecting";
    const wasActive = this.recovering || isRecoveryActivePhase(this.phase);
    this.bumpEpoch();
    this.recovering = false;
    this.attempt = 0;
    this.nextAttemptAt = undefined;
    this.armedGeneration = undefined;
    this.manualConnectionPending = false;
    this.lastAttemptErrorCode = undefined;
    this.phase = this.enabled ? "idle" : "off";
    this.message = this.enabled ? "自动重连已取消" : "自动重连未启用";
    if (wasActive) {
      this.record({ kind: "recovery_cancelled", outcome: reason });
    } else {
      this.notify();
    }

    if (cancelBackend && wasConnecting) {
      await this.dependencies.cancelPendingConnection();
    }
  }

  clearDiagnostics(): void {
    this.diagnostics.clear();
    this.notify();
  }

  exportDiagnostics(context: DiagnosticsContext): SerialDiagnosticsReport {
    return this.diagnostics.export({
      ...context,
      recoveryPhase: this.phase,
      attempt: this.attempt,
      target: this.target,
    });
  }

  private handleConnected(payload: SerialStatePayload): void {
    const wasRecovering = this.recovering;
    this.bumpEpoch();
    this.recovering = false;
    this.attempt = 0;
    this.nextAttemptAt = undefined;
    this.manualConnectionPending = false;
    this.lastAttemptErrorCode = undefined;
    if (wasRecovering) {
      this.dependencies.resetStreamAfterReconnect();
      this.record({
        kind: "recovery_connected",
        generation: payload.generation,
        revision: payload.revision,
        outcome: "connected",
      });
    } else {
      this.record({
        kind: "manual_connected",
        generation: payload.generation,
        revision: payload.revision,
      });
    }

    if (this.enabled) {
      this.armOrBlock(payload.generation);
    } else {
      this.phase = "off";
      this.message = "自动重连未启用";
      this.notify();
    }
  }

  private armOrBlock(generation: number): void {
    if (this.target && this.config) {
      this.armedGeneration = generation;
      this.phase = "armed";
      this.message = "自动重连已待命";
      this.record({ kind: "recovery_armed", generation });
      return;
    }
    this.armedGeneration = undefined;
    this.phase = "blocked";
    this.message = "设备缺少唯一 USB 序列号，自动重连已暂停";
    this.record({ kind: "recovery_identity_unavailable", generation, outcome: "blocked" });
  }

  private startRecovery(): boolean {
    if (!this.enabled) {
      return false;
    }
    if (this.recovering || isRecoveryActivePhase(this.phase)) {
      return false;
    }

    this.bumpEpoch();
    const epoch = this.epoch;
    this.recovering = true;
    this.attempt = 0;
    this.nextAttemptAt = undefined;
    void this.prepareAndSchedule(epoch);
    return true;
  }

  private async prepareAndSchedule(epoch: number): Promise<void> {
    const captureReady = await this.dependencies.prepareCaptureBoundary();
    if (!this.isCurrent(epoch)) {
      return;
    }
    if (!captureReady) {
      this.recovering = false;
      this.phase = "blocked";
      this.message = "录制收尾失败，自动重连已停止";
      this.record({ kind: "capture_finalize_failed", outcome: "blocked" });
      return;
    }
    if (!this.target || !this.config) {
      this.recovering = false;
      this.phase = "blocked";
      this.message = "设备身份不完整，未自动选择串口";
      this.record({ kind: "recovery_identity_unavailable", outcome: "blocked" });
      return;
    }
    this.schedule(epoch, SERIAL_RECOVERY_DELAYS_MS[0]);
  }

  private schedule(epoch: number, delayMs: number): void {
    if (!this.isCurrent(epoch)) {
      return;
    }
    this.clearTimer();
    this.phase = "waiting";
    this.nextAttemptAt = this.dependencies.now() + delayMs;
    this.message =
      delayMs === 0
        ? "正在准备自动重连"
        : `第 ${this.attempt + 1} 次重连将在 ${formatDelay(delayMs)} 后开始`;
    this.record({
      kind: "recovery_scheduled",
      attempt: this.attempt + 1,
      delayMs,
    });
    this.timer = this.dependencies.setTimer(() => {
      this.timer = undefined;
      void this.runAttempt(epoch);
    }, delayMs);
  }

  private async runAttempt(epoch: number): Promise<void> {
    if (!this.isCurrent(epoch) || !this.target || !this.config) {
      return;
    }
    if (this.attempt >= SERIAL_RECOVERY_DELAYS_MS.length) {
      this.exhaust();
      return;
    }

    this.attempt += 1;
    this.phase = "scanning";
    this.nextAttemptAt = undefined;
    this.message = `正在查找原设备（${this.attempt}/${SERIAL_RECOVERY_DELAYS_MS.length}）`;
    this.record({ kind: "recovery_scan", attempt: this.attempt });

    let ports: SerialPortInfo[];
    try {
      ports = await this.dependencies.listPorts();
    } catch {
      if (this.isCurrent(epoch)) {
        this.record({ kind: "recovery_scan_failed", attempt: this.attempt, errorCode: "unknown" });
        this.scheduleAfterFailure(epoch);
      }
      return;
    }
    if (!this.isCurrent(epoch)) {
      return;
    }
    this.dependencies.updatePorts(ports);

    const match = matchSerialReconnectTarget(ports, this.target);
    if (match.status === "missing") {
      this.record({
        kind: "recovery_device_missing",
        attempt: this.attempt,
        candidateCount: 0,
      });
      this.scheduleAfterFailure(epoch);
      return;
    }
    if (match.status === "ambiguous") {
      this.recovering = false;
      this.phase = "blocked";
      this.message = "检测到多个相同身份的设备，已停止自动选择";
      this.record({
        kind: "recovery_device_ambiguous",
        attempt: this.attempt,
        candidateCount: match.candidateCount,
        outcome: "blocked",
      });
      return;
    }

    const config = { ...this.config, portName: match.port.name };
    this.config = config;
    this.dependencies.updatePortName(match.port.name);
    this.phase = "connecting";
    this.message = `正在重新连接原设备（${this.attempt}/${SERIAL_RECOVERY_DELAYS_MS.length}）`;
    this.lastAttemptErrorCode = undefined;
    this.record({
      kind: "recovery_connect",
      attempt: this.attempt,
      candidateCount: 1,
    });

    try {
      const payload = await this.dependencies.connect(config);
      if (!this.isCurrent(epoch)) {
        return;
      }
      this.dependencies.applyBackendState(payload);
      if (payload.status !== "connected" && this.isCurrent(epoch)) {
        this.record({
          kind: "recovery_connect_failed",
          attempt: this.attempt,
          errorCode: payload.errorCode ?? this.lastAttemptErrorCode ?? "unknown",
        });
        this.scheduleAfterFailure(epoch);
      }
    } catch {
      if (!this.isCurrent(epoch)) {
        return;
      }
      this.record({
        kind: "recovery_connect_failed",
        attempt: this.attempt,
        errorCode: this.lastAttemptErrorCode ?? "unknown",
      });
      this.scheduleAfterFailure(epoch);
    }
  }

  private scheduleAfterFailure(epoch: number): void {
    const delayMs = SERIAL_RECOVERY_DELAYS_MS[this.attempt];
    if (delayMs === undefined) {
      this.exhaust();
      return;
    }
    this.schedule(epoch, delayMs);
  }

  private exhaust(): void {
    this.recovering = false;
    this.phase = "exhausted";
    this.nextAttemptAt = undefined;
    this.message = `已完成 ${SERIAL_RECOVERY_DELAYS_MS.length} 次重连尝试`;
    this.record({
      kind: "recovery_exhausted",
      attempt: this.attempt,
      outcome: "exhausted",
    });
  }

  private bumpEpoch(): void {
    this.epoch += 1;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      this.dependencies.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  private isCurrent(epoch: number): boolean {
    return this.enabled && this.recovering && this.epoch === epoch;
  }

  private record(input: DiagnosticInput): void {
    this.diagnostics.record(input);
    this.notify();
  }

  private notify(): void {
    this.dependencies.onSnapshot(this.getSnapshot());
  }
}

export class SerialDiagnosticLog {
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly events: SerialDiagnosticEvent[] = [];
  private nextSequence = 1;
  droppedEvents = 0;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.startedAt = now();
  }

  get size(): number {
    return this.events.length;
  }

  record(input: DiagnosticInput): void {
    if (this.events.length >= MAX_DIAGNOSTIC_EVENTS) {
      this.events.shift();
      this.droppedEvents += 1;
    }
    this.events.push({
      sequence: this.nextSequence,
      elapsedMs: Math.max(0, this.now() - this.startedAt),
      ...input,
    });
    this.nextSequence += 1;
  }

  clear(): void {
    this.events.length = 0;
    this.droppedEvents = 0;
  }

  export(
    context: DiagnosticsContext & {
      recoveryPhase: SerialRecoveryPhase;
      attempt: number;
      target: SerialReconnectTarget | null;
    },
  ): SerialDiagnosticsReport {
    const events = this.events.map((event) => ({ ...event }));
    let removedForSize = 0;
    const generatedAt = this.now();
    let report = createDiagnosticsReport(
      context,
      events,
      this.droppedEvents,
      generatedAt,
    );
    while (encodedSize(report) > MAX_DIAGNOSTIC_EXPORT_BYTES && events.length > 0) {
      events.shift();
      removedForSize += 1;
      report = createDiagnosticsReport(
        context,
        events,
        this.droppedEvents + removedForSize,
        generatedAt,
      );
    }
    return report;
  }
}

export function createSerialReconnectTarget(
  port: SerialPortInfo | undefined,
): SerialReconnectTarget | null {
  const serialNumber = port?.serialNumber?.trim();
  if (
    port?.kind !== "usb" ||
    !serialNumber ||
    !Number.isInteger(port.vendorId) ||
    !Number.isInteger(port.productId)
  ) {
    return null;
  }
  return {
    kind: "usb",
    vendorId: Number(port.vendorId),
    productId: Number(port.productId),
    serialNumber,
  };
}

export function matchSerialReconnectTarget(
  ports: readonly SerialPortInfo[],
  target: SerialReconnectTarget,
): SerialTargetMatch {
  const matches = ports.filter(
    (port) =>
      port.kind === "usb" &&
      port.vendorId === target.vendorId &&
      port.productId === target.productId &&
      port.serialNumber?.trim() === target.serialNumber,
  );
  if (matches.length === 0) {
    return { status: "missing", candidateCount: 0 };
  }
  if (matches.length > 1) {
    return { status: "ambiguous", candidateCount: matches.length };
  }
  return { status: "matched", candidateCount: 1, port: matches[0] as SerialPortInfo };
}

export function isRecoveryActivePhase(phase: SerialRecoveryPhase): boolean {
  return phase === "waiting" || phase === "scanning" || phase === "connecting";
}

function createDiagnosticsReport(
  context: DiagnosticsContext & {
    recoveryPhase: SerialRecoveryPhase;
    attempt: number;
    target: SerialReconnectTarget | null;
  },
  events: SerialDiagnosticEvent[],
  droppedEvents: number,
  generatedAt: number,
): SerialDiagnosticsReport {
  const serial = {
    baudRate: context.serialConfig.baudRate,
    dataBits: context.serialConfig.dataBits,
    parity: context.serialConfig.parity,
    stopBits: context.serialConfig.stopBits,
    flowControl: context.serialConfig.flowControl,
    dtr: context.serialConfig.dtr,
    rts: context.serialConfig.rts,
  };
  return {
    format: "vofa-ultra.serial-diagnostics",
    schemaVersion: 1,
    generatedAt,
    appVersion: context.appVersion,
    connection: {
      status: context.connectionStatus,
      recoveryPhase: context.recoveryPhase,
      attempt: context.attempt,
      generation: context.generation,
      revision: context.revision,
    },
    serial,
    target: context.target
      ? {
          kind: "usb",
          vendorId: context.target.vendorId,
          productId: context.target.productId,
          serialPresent: true,
          matchPolicy: "usb-serial",
        }
      : undefined,
    eventCount: events.length,
    droppedEvents,
    events,
  };
}

function encodedSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function formatDelay(delayMs: number): string {
  if (delayMs < 1_000) {
    return `${delayMs} ms`;
  }
  return `${delayMs / 1_000} s`;
}
