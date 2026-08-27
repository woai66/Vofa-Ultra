import { describe, expect, it, vi } from "vitest";
import type { AutoResponderRule, AutoResponderSnapshot } from "../types/automation";
import { LEGACY_LINE_ENDINGS } from "../types/serial";
import {
  AutoResponderRuntime,
  CommandSendArbiter,
  MAX_AUTO_RESPONDER_MATCHES_PER_BATCH,
  MAX_AUTO_RESPONDER_QUEUE_SIZE,
  MAX_AUTO_RESPONDER_SESSION_RESPONSES,
  createDefaultAutoResponderRule,
  parseAutoResponderRules,
  type AutoResponderDispatch,
} from "./autoResponder";
import { encodeText, loadTextEncoding } from "./textEncoding";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function rule(overrides: Partial<AutoResponderRule> = {}): AutoResponderRule {
  return {
    ...createDefaultAutoResponderRule("rule-1", "规则一"),
    cooldownMs: 20,
    ...overrides,
  };
}

function runtimeHarness(
  send: (dispatch: AutoResponderDispatch, signal: AbortSignal) => Promise<void> =
    async () => undefined,
) {
  const snapshots: AutoResponderSnapshot[] = [];
  const runtime = new AutoResponderRuntime({
    now: () => 1_000,
    send,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  return { runtime, snapshots };
}

describe("自动应答规则", () => {
  it("严格校验字段、字节上限和响应模板", () => {
    expect(parseAutoResponderRules([rule()])).toEqual([rule()]);
    expect(() => parseAutoResponderRules([{ ...rule(), script: "eval()" }])).toThrow(
      /未知字段/,
    );
    expect(() => parseAutoResponderRules([rule({ trigger: "" })])).toThrow(/触发内容不能为空/);
    expect(() => parseAutoResponderRules([rule({ triggerMode: "hex", trigger: "0" })])).toThrow(
      /完整字节/,
    );
    expect(() => parseAutoResponderRules([rule({ trigger: "41 ".repeat(257) })])).toThrow(
      /256 字节/,
    );
    expect(() => parseAutoResponderRules([rule({ response: "A".repeat(4_097) })])).toThrow(
      /4 KiB/,
    );
    expect(() => parseAutoResponderRules([rule({ response: "${device.secret}" })])).toThrow(
      /命令变量名称无效/,
    );
    expect(() =>
      parseAutoResponderRules([
        rule({ triggerMode: "hex", trigger: `00${" ".repeat(4 * 1024)}` }),
      ]),
    ).toThrow(/触发内容文本不能超过 4 KiB/);
    expect(
      parseAutoResponderRules([
        rule({ triggerMode: "hex", trigger: "0x01, 02-ff:7a" }),
      ])[0]?.trigger,
    ).toBe("01 02 FF 7A");
  });

  it("拒绝重复 ID 和越界冷却", () => {
    expect(() => parseAutoResponderRules([rule(), rule({ name: "规则二" })])).toThrow(
      /ID 重复/,
    );
    expect(() => parseAutoResponderRules([rule({ cooldownMs: 19 })])).toThrow(/冷却时间/);
  });

  it("保存时不以 UTF-8 误判文本触发长度，启动时按 RX 编码限制线上字节", async () => {
    const rules = parseAutoResponderRules([
      rule({ triggerMode: "text", trigger: "中".repeat(100) }),
    ]);
    const { runtime } = runtimeHarness();

    expect(() => runtime.start(rules, "utf-8")).toThrow(/256 字节/);
    await loadTextEncoding("gb18030");
    expect(() => runtime.start(rules, "gb18030")).not.toThrow();
  });

  it("只在当前格式接受 CR 响应行尾", () => {
    const crRule = rule({ lineEnding: "cr" });

    expect(parseAutoResponderRules([crRule])).toEqual([crRule]);
    expect(() => parseAutoResponderRules([crRule], LEGACY_LINE_ENDINGS)).toThrow(/行尾无效/);
  });
});

describe("AutoResponderRuntime", () => {
  it("分别使用 RX GB18030 匹配和 TX Windows-1252 响应", async () => {
    await Promise.all([
      loadTextEncoding("gb18030"),
      loadTextEncoding("windows-1252"),
    ]);
    const sent: AutoResponderDispatch[] = [];
    const { runtime } = runtimeHarness(async (dispatch) => {
      sent.push(dispatch);
    });
    runtime.start(
      [
        rule({
          triggerMode: "text",
          trigger: "中文",
          responseMode: "text",
          response: "Café €",
        }),
      ],
      "gb18030",
      "windows-1252",
    );

    runtime.ingest(encodeText("中文", "gb18030"), 1_000);
    await flushPromises();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.command.textEncoding).toBe("windows-1252");
    expect(Array.from(sent[0]?.command.bytes ?? [])).toEqual([
      0x43,
      0x61,
      0x66,
      0xe9,
      0x20,
      0x80,
    ]);
  });

  it("按字节匹配跨 chunk、重叠模式和 NUL", async () => {
    const sent: AutoResponderDispatch[] = [];
    const { runtime } = runtimeHarness(async (dispatch) => {
      sent.push(dispatch);
    });
    runtime.start([
      rule({ triggerMode: "text", trigger: "ABAB", response: "TEXT" }),
      rule({
        id: "rule-2",
        name: "二进制规则",
        triggerMode: "hex",
        trigger: "00 FF",
        responseMode: "hex",
        response: "A5 ${seq:u8}",
      }),
    ]);

    runtime.ingest(Uint8Array.from([0x41, 0x42, 0x41]), 1_000);
    runtime.ingest(Uint8Array.from([0x42]), 1_020);
    runtime.ingest(Uint8Array.from([0x41, 0x42, 0x00]), 1_040);
    runtime.ingest(Uint8Array.from([0xff]), 1_060);
    await flushPromises();

    expect(sent.map((item) => item.ruleId)).toEqual(["rule-1", "rule-1", "rule-2"]);
    expect(Array.from(sent[2]?.command.bytes ?? [])).toEqual([0xa5, 0x03]);
    expect(runtime.getSnapshot()).toMatchObject({
      status: "armed",
      matchCount: 3,
      acceptedCount: 3,
      sentCount: 3,
    });
  });

  it("同一偏移按规则顺序入队并按每条规则独立冷却", async () => {
    const sent: AutoResponderDispatch[] = [];
    const { runtime } = runtimeHarness(async (dispatch) => {
      sent.push(dispatch);
    });
    runtime.start([
      rule({ response: "FIRST" }),
      rule({ id: "rule-2", name: "规则二", response: "SECOND", cooldownMs: 40 }),
    ]);

    runtime.ingest(Uint8Array.from([0x0a]), 1_000);
    runtime.ingest(Uint8Array.from([0x0a]), 1_020);
    runtime.ingest(Uint8Array.from([0x0a]), 1_040);
    await flushPromises();

    expect(sent.map((item) => item.ruleId)).toEqual([
      "rule-1",
      "rule-2",
      "rule-1",
      "rule-1",
      "rule-2",
    ]);
    expect(runtime.getSnapshot()).toMatchObject({
      matchCount: 6,
      acceptedCount: 5,
      cooldownDropCount: 1,
    });
  });

  it("队列溢出时清空待发送项并明确停机", async () => {
    const firstSend = deferred<void>();
    const send = vi.fn(() => firstSend.promise);
    const { runtime } = runtimeHarness(send);
    runtime.start([rule()]);

    for (let index = 0; index <= MAX_AUTO_RESPONDER_QUEUE_SIZE; index += 1) {
      runtime.ingest(Uint8Array.from([0x0a]), 1_000 + index * 20);
    }

    expect(send).toHaveBeenCalledOnce();
    expect(runtime.getSnapshot()).toMatchObject({ status: "error", queuedCount: 0 });
    expect(runtime.getSnapshot().message).toContain("队列达到 32 条");
    firstSend.resolve();
    await flushPromises();
    expect(runtime.getSnapshot().status).toBe("error");
  });

  it("超过单批匹配预算时停机", () => {
    const { runtime } = runtimeHarness();
    runtime.start([rule({ triggerMode: "text", trigger: "A" })]);

    runtime.ingest(
      new Uint8Array(MAX_AUTO_RESPONDER_MATCHES_PER_BATCH + 1).fill(0x41),
      1_000,
    );

    expect(runtime.getSnapshot()).toMatchObject({ status: "error", queuedCount: 0 });
    expect(runtime.getSnapshot().message).toContain("单批匹配超过 64 次");
  });

  it("发送满会话预算后完成第 1000 次响应并自动停机", async () => {
    const send = vi.fn(async () => undefined);
    const { runtime } = runtimeHarness(send);
    runtime.start([rule()]);

    for (let index = 0; index < MAX_AUTO_RESPONDER_SESSION_RESPONSES; index += 1) {
      runtime.ingest(Uint8Array.from([0x0a]), 1_000 + index * 20);
      await flushPromises();
    }

    expect(send).toHaveBeenCalledTimes(MAX_AUTO_RESPONDER_SESSION_RESPONSES);
    expect(runtime.getSnapshot()).toMatchObject({
      status: "stopped",
      acceptedCount: MAX_AUTO_RESPONDER_SESSION_RESPONSES,
      sentCount: MAX_AUTO_RESPONDER_SESSION_RESPONSES,
      queuedCount: 0,
    });
    expect(runtime.getSnapshot().message).toContain("已达到会话上限");

    runtime.ingest(Uint8Array.from([0x0a]), 21_000);
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(MAX_AUTO_RESPONDER_SESSION_RESPONSES);
  });

  it("会话上限优先于队列保护且安全边界可以中断排空", async () => {
    const blockedSend = deferred<void>();
    const send = vi.fn((dispatch: AutoResponderDispatch) =>
      dispatch.sequence === 969 ? blockedSend.promise : Promise.resolve(),
    );
    const { runtime } = runtimeHarness(send);
    runtime.start(
      Array.from({ length: 16 }, (_, index) =>
        rule({
          id: `rule-${index + 1}`,
          name: `规则 ${index + 1}`,
          triggerMode: "text",
          trigger: index < 8 ? "A" : "B",
        }),
      ),
    );

    for (let index = 0; index < 60; index += 1) {
      runtime.ingest(Uint8Array.from([0x41, 0x42]), 1_000 + index * 20);
      for (let step = 0; step < 20; step += 1) {
        await Promise.resolve();
      }
    }
    runtime.ingest(Uint8Array.from([0x41]), 2_200);
    for (let step = 0; step < 10; step += 1) {
      await Promise.resolve();
    }
    expect(runtime.getSnapshot()).toMatchObject({ acceptedCount: 968, sentCount: 968 });

    runtime.ingest(Uint8Array.from([0x42]), 2_220);
    runtime.ingest(Uint8Array.from([0x41]), 2_240);
    runtime.ingest(Uint8Array.from([0x42]), 2_260);
    runtime.ingest(Uint8Array.from([0x41, 0x42]), 2_280);

    expect(runtime.getSnapshot()).toMatchObject({
      status: "stopping",
      acceptedCount: MAX_AUTO_RESPONDER_SESSION_RESPONSES,
      queuedCount: 31,
    });
    expect(runtime.getSnapshot().message).toContain("会话上限");
    expect(runtime.stop("workspace-change")).toBe(true);
    expect(runtime.getSnapshot()).toMatchObject({ status: "stopping", queuedCount: 0 });

    blockedSend.resolve();
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(969);
    expect(runtime.getSnapshot()).toMatchObject({ status: "stopped", sentCount: 969 });
    expect(runtime.getSnapshot().message).toContain("工作区已切换");
  });

  it("发送失败后停机且不继续 drain", async () => {
    const send = vi.fn(async () => {
      throw new Error("设备拒绝写入");
    });
    const { runtime } = runtimeHarness(send);
    runtime.start([rule()]);
    runtime.ingest(Uint8Array.from([0x0a]), 1_000);
    runtime.ingest(Uint8Array.from([0x0a]), 1_020);
    await flushPromises();

    expect(send).toHaveBeenCalledOnce();
    expect(runtime.getSnapshot()).toMatchObject({
      status: "error",
      queuedCount: 0,
      sentCount: 0,
    });
    expect(runtime.getSnapshot().lastError).toContain("设备拒绝写入");
  });

  it("停止时取消等待项并允许已经落入物理层的发送收尾", async () => {
    const currentSend = deferred<void>();
    const { runtime } = runtimeHarness(() => currentSend.promise);
    runtime.start([rule()]);
    runtime.ingest(Uint8Array.from([0x0a]), 1_000);
    runtime.ingest(Uint8Array.from([0x0a]), 1_020);

    expect(runtime.stop("connection-lost")).toBe(true);
    expect(runtime.getSnapshot()).toMatchObject({ status: "stopping", queuedCount: 0 });
    currentSend.resolve();
    await flushPromises();

    expect(runtime.getSnapshot()).toMatchObject({ status: "stopped", sentCount: 1 });
    expect(runtime.getSnapshot().message).toContain("连接已中断");
  });
});

describe("CommandSendArbiter", () => {
  it("当前发送完成后让手动发送优先于待发送自动项", async () => {
    const arbiter = new CommandSendArbiter();
    const first = deferred<void>();
    const order: string[] = [];
    const firstRun = arbiter.run("auto-responder", undefined, async () => {
      order.push("auto-1");
      await first.promise;
    });
    const secondRun = arbiter.run("auto-responder", undefined, async () => {
      order.push("auto-2");
    });
    const manualRun = arbiter.run("manual", undefined, async () => {
      order.push("manual");
    });

    first.resolve();
    await Promise.all([firstRun, secondRun, manualRun]);
    expect(order).toEqual(["auto-1", "manual", "auto-2"]);
    expect(arbiter.isBusy()).toBe(false);
  });

  it("取消等待项但允许当前发送收尾", async () => {
    const arbiter = new CommandSendArbiter();
    const current = deferred<void>();
    const currentRun = arbiter.run("auto-responder", undefined, () => current.promise);
    const pendingRun = arbiter.run("manual", undefined, async () => undefined);
    const pendingRejection = expect(pendingRun).rejects.toThrow("发送上下文已变更");

    expect(arbiter.cancelPending()).toBe(1);
    await pendingRejection;
    expect(arbiter.getOrigin()).toBe("auto-responder");

    current.resolve();
    await currentRun;
    expect(arbiter.isBusy()).toBe(false);
  });

  it("移除已取消的自动等待项", async () => {
    const arbiter = new CommandSendArbiter();
    const first = deferred<void>();
    const controller = new AbortController();
    const firstRun = arbiter.run("manual", undefined, () => first.promise);
    const cancelledRun = arbiter.run("auto-responder", controller.signal, async () => undefined);

    controller.abort();
    await expect(cancelledRun).rejects.toThrow(/已取消/);
    first.resolve();
    await firstRun;
    expect(arbiter.isBusy()).toBe(false);
  });
});
