import { describe, expect, it } from "vitest";
import {
  createIdleSerialRxObservability,
  observeSerialRxData,
  observeSerialRxState,
} from "./serialRxObservability";
import type { SerialDataPayload, SerialStatePayload } from "../types/serial";

function serialState(
  status: SerialStatePayload["status"],
  overrides: Partial<SerialStatePayload> = {},
): SerialStatePayload {
  return {
    status,
    portName: "COM3",
    generation: 1,
    revision: 1,
    backendRxBytes: 0,
    backendRxEvents: 0,
    ...overrides,
  };
}

function serialData(
  sequence: number,
  streamOffset: number,
  byteCount: number,
  overrides: Partial<SerialDataPayload> = {},
): SerialDataPayload {
  return {
    data: "",
    receivedAt: 1_000 + sequence,
    receivedAtMonotonicUs: 100 + sequence,
    generation: 1,
    sequence,
    streamOffset,
    byteCount,
    backendRxBytes: streamOffset + byteCount,
    backendRxEvents: sequence + 1,
    ...overrides,
  };
}

describe("serialRxObservability", () => {
  it("连续事件在连接结束时得到完整性确认", () => {
    let snapshot = observeSerialRxState(
      createIdleSerialRxObservability(),
      serialState("connected"),
    );
    let observed = observeSerialRxData(snapshot, serialData(0, 0, 3), 3);
    expect(observed.accept).toBe(true);
    snapshot = observed.snapshot;
    observed = observeSerialRxData(snapshot, serialData(1, 3, 2), 2);
    expect(observed.accept).toBe(true);

    snapshot = observeSerialRxState(
      observed.snapshot,
      serialState("disconnected", {
        revision: 2,
        backendRxBytes: 5,
        backendRxEvents: 2,
      }),
    );

    expect(snapshot).toMatchObject({
      status: "verified",
      finalized: true,
      backendRxBytes: 5,
      backendRxEvents: 2,
      acceptedRxBytes: 5,
      acceptedRxEvents: 2,
      ipcGapBytes: 0,
      ipcGapEvents: 0,
    });
  });

  it("后续序号和流偏移能定位中间 IPC 缺口", () => {
    let snapshot = observeSerialRxState(
      createIdleSerialRxObservability(),
      serialState("connected"),
    );
    snapshot = observeSerialRxData(snapshot, serialData(0, 0, 3), 3).snapshot;
    const observed = observeSerialRxData(snapshot, serialData(2, 7, 2), 2);

    expect(observed.accept).toBe(true);
    expect(observed.snapshot).toMatchObject({
      status: "degraded",
      ipcGapEvents: 1,
      ipcGapBytes: 4,
      nextSequence: 3,
      nextStreamOffset: 9,
    });
  });

  it("最终后端计数能发现最后一个可见事件之后的缺口", () => {
    let snapshot = observeSerialRxState(
      createIdleSerialRxObservability(),
      serialState("connected"),
    );
    snapshot = observeSerialRxData(snapshot, serialData(0, 0, 3), 3).snapshot;
    snapshot = observeSerialRxState(
      snapshot,
      serialState("error", {
        revision: 2,
        backendRxBytes: 10,
        backendRxEvents: 3,
      }),
    );

    expect(snapshot).toMatchObject({
      status: "degraded",
      finalized: true,
      ipcGapEvents: 2,
      ipcGapBytes: 7,
    });

    snapshot = observeSerialRxState(
      snapshot,
      serialState("disconnected", {
        revision: 3,
        backendRxBytes: 10,
        backendRxEvents: 3,
      }),
    );
    expect(snapshot).toMatchObject({
      ipcGapEvents: 2,
      ipcGapBytes: 7,
    });
  });

  it("重复事件和乱序事件不会被再次交给协议解析器", () => {
    let snapshot = observeSerialRxState(
      createIdleSerialRxObservability(),
      serialState("connected"),
    );
    snapshot = observeSerialRxData(snapshot, serialData(0, 0, 3), 3).snapshot;

    const duplicate = observeSerialRxData(snapshot, serialData(0, 0, 3), 3);
    expect(duplicate.accept).toBe(false);
    expect(duplicate.snapshot.duplicateEvents).toBe(1);

    const outOfOrder = observeSerialRxData(
      duplicate.snapshot,
      serialData(0, 1, 2),
      2,
    );
    expect(outOfOrder.accept).toBe(false);
    expect(outOfOrder.snapshot.outOfOrderEvents).toBe(1);
    expect(outOfOrder.snapshot.acceptedRxEvents).toBe(1);
  });

  it("未收到终态就切换代次会保留诊断证据", () => {
    let snapshot = observeSerialRxState(
      createIdleSerialRxObservability(),
      serialState("connected"),
    );
    snapshot = observeSerialRxState(
      snapshot,
      serialState("connecting", { generation: 2, revision: 2 }),
    );
    const stale = observeSerialRxData(snapshot, serialData(0, 0, 1), 1);

    expect(stale.accept).toBe(false);
    expect(stale.snapshot).toMatchObject({
      generation: 2,
      status: "degraded",
      unfinalizedGenerations: 1,
      staleGenerationEvents: 1,
    });
  });

  it("字节数或单调时间契约异常会被明确记录", () => {
    let snapshot = observeSerialRxState(
      createIdleSerialRxObservability(),
      serialState("connected"),
    );
    const invalidSize = observeSerialRxData(snapshot, serialData(0, 0, 3), 2);
    expect(invalidSize.accept).toBe(false);
    expect(invalidSize.snapshot.contractViolations).toBe(1);

    snapshot = observeSerialRxData(
      invalidSize.snapshot,
      serialData(0, 0, 3, { receivedAtMonotonicUs: 200 }),
      3,
    ).snapshot;
    const regressed = observeSerialRxData(
      snapshot,
      serialData(1, 3, 2, { receivedAtMonotonicUs: 100 }),
      2,
    );
    expect(regressed.accept).toBe(true);
    expect(regressed.snapshot.contractViolations).toBe(2);
  });
});
