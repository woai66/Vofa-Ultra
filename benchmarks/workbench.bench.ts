// @vitest-environment jsdom

import { bench, describe, vi } from "vitest";
import { encodeJustFloatFrame } from "../src/core/protocols";
import { useWorkbenchStore } from "../src/store/workbenchStore";
import type { ReplayCaptureHeader, ReplayStatePayload } from "../src/types/replay";

vi.mock("../src/services/replayClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/replayClient")>();
  return {
    ...actual,
    ackReplayBatch: async () => undefined,
  };
});

const CHANNEL_COUNT = 4;
const MAX_POINTS_PER_CHANNEL = 2_000;
const LIVE_FRAME_COUNT = 820;
const LIVE_GENERATION = 17;
const REPLAY_RECORD_COUNT = 64;
const REPLAY_FRAMES_PER_RECORD = 3;
const REPLAY_FRAME_COUNT = REPLAY_RECORD_COUNT * REPLAY_FRAMES_PER_RECORD;
const BENCHMARK_OPTIONS = {
  time: 1_000,
  iterations: 15,
  warmupTime: 300,
  warmupIterations: 5,
} as const;
const storeValues = Array.from({ length: CHANNEL_COUNT }, (_, index) => index + 0.5);
const storeFrame = encodeJustFloatFrame(storeValues);
const saturatedBytes = repeatFrame(storeFrame, MAX_POINTS_PER_CHANNEL);
const liveBytes = repeatFrame(storeFrame, LIVE_FRAME_COUNT);
const liveData = Buffer.from(liveBytes).toString("base64");
const replayRecordBytes = repeatFrame(storeFrame, REPLAY_FRAMES_PER_RECORD);
const replayRecordData = Array.from(replayRecordBytes);
const replayRecords = Array.from({ length: REPLAY_RECORD_COUNT }, (_, index) => ({
  direction: "rx" as const,
  timestampUs: index * 100,
  data: replayRecordData,
}));
let replayRevision = 0;
let replayTimelineRevision = 0;
let replayGeneration = 0;
let replaySequence = 2;
let liveTimestamp = 2_000;

describe("工作台数据平面", () => {
  bench(
    "已饱和实时链路摄入 16 KiB JustFloat",
    () => {
      const before = useWorkbenchStore.getState();
      liveTimestamp += 1;
      before.handleSerialData({
        data: liveData,
        receivedAt: liveTimestamp,
        generation: LIVE_GENERATION,
      });
      assertWorkbenchResult(
        "protocolHealth",
        before.stats.rxFrames,
        before.stats.rxBytes,
        LIVE_FRAME_COUNT,
        liveBytes.length,
      );
    },
    { ...BENCHMARK_OPTIONS, setup: prepareLiveBenchmark },
  );

  bench(
    "已饱和回放链路摄入 64 条记录",
    async () => {
      const before = useWorkbenchStore.getState();
      const sequence = replaySequence;
      replaySequence += 1;
      before.handleReplayBatch({
        sessionId: 7,
        generation: before.replayGeneration,
        sequence,
        startUs: sequence * 10_000,
        endUs: sequence * 10_000 + REPLAY_RECORD_COUNT * 100,
        dataBytes: replayRecordBytes.length * REPLAY_RECORD_COUNT,
        records: replayRecords,
      });
      await Promise.resolve();
      assertWorkbenchResult(
        "replayProtocolHealth",
        before.stats.rxFrames,
        before.stats.rxBytes,
        REPLAY_FRAME_COUNT,
        replayRecordBytes.length * REPLAY_RECORD_COUNT,
      );
    },
    { ...BENCHMARK_OPTIONS, setup: prepareReplayBenchmark },
  );
});

function prepareLiveBenchmark(): void {
  resetBenchmarkState();
  const state = useWorkbenchStore.getState();
  state.setProtocol("justfloat");
  state.setProcessingGraph({ enabled: false, nodes: [] });
  state.ingestBytes(saturatedBytes, 1_000);
  state.clearTerminal();
  state.resetStats();
  state.clearProtocolHealth();
  useWorkbenchStore.setState({
    source: "serial",
    connectionStatus: "connected",
    serialGeneration: LIVE_GENERATION,
  });
  liveTimestamp = 2_000;
  assertSaturatedState("protocolHealth");
}

async function prepareReplayBenchmark(): Promise<void> {
  resetBenchmarkState();
  const state = useWorkbenchStore.getState();
  state.setProtocol("justfloat");
  state.setProcessingGraph({ enabled: false, nodes: [] });
  const generation = ++replayGeneration;
  const timelineRevision = ++replayTimelineRevision;
  const header: ReplayCaptureHeader = {
    source: "simulator",
    protocol: "justfloat",
    serialConfig: state.serialConfig,
    startedAtUnixMs: 1_000,
    timeUnit: "microseconds",
  };
  state.handleReplayState(replayState("playing", generation, timelineRevision, header));
  useWorkbenchStore.getState().handleReplayBatch({
    sessionId: 7,
    generation,
    sequence: 1,
    startUs: 0,
    endUs: 1_000,
    dataBytes: saturatedBytes.length,
    records: [{ direction: "rx", timestampUs: 1_000, data: Array.from(saturatedBytes) }],
  });
  await Promise.resolve();
  const prepared = useWorkbenchStore.getState();
  prepared.clearTerminal();
  prepared.resetStats();
  prepared.clearProtocolHealth();
  replaySequence = prepared.replayNextSequence;
  assertSaturatedState("replayProtocolHealth");
}

function resetBenchmarkState(): void {
  useWorkbenchStore.setState({
    source: "simulator",
    connectionStatus: "disconnected",
    workspaceTransitionStatus: "idle",
    runtimeTransitionStatus: "idle",
    captureStatus: "idle",
    numericLogStatus: "idle",
    replayStatus: "idle",
    replaySessionId: 0,
    replayHeader: undefined,
    replayNextSequence: 1,
    terminalPaused: false,
    chartPaused: false,
  });
}

function replayState(
  status: "playing",
  generation: number,
  timelineRevision: number,
  header: ReplayCaptureHeader,
): ReplayStatePayload {
  replayRevision += 1;
  return {
    status,
    sessionId: 7,
    generation,
    timelineRevision,
    revision: replayRevision,
    path: "benchmark.vucap",
    header,
    formatVersion: 2,
    complete: true,
    speed: 1,
    positionUs: 0,
    durationUs: 1_000_000,
    dataBytes: saturatedBytes.length,
    recordCount: REPLAY_RECORD_COUNT,
    markerCount: 0,
  };
}

function assertWorkbenchResult(
  healthKey: "protocolHealth" | "replayProtocolHealth",
  previousFrames: number,
  previousBytes: number,
  addedFrames: number,
  addedBytes: number,
): void {
  const state = useWorkbenchStore.getState();
  const lastTerminalEntry = state.terminalEntries.at(-1);
  const expectedTerminalBytes =
    healthKey === "protocolHealth" ? addedBytes : replayRecordBytes.length;
  if (
    state.channels.length !== CHANNEL_COUNT ||
    state.channels.some((channel) => channel.points.length !== MAX_POINTS_PER_CHANNEL) ||
    state.stats.rxFrames !== previousFrames + addedFrames ||
    state.stats.rxBytes !== previousBytes + addedBytes ||
    state[healthKey].acceptedFrames !== previousFrames + addedFrames ||
    !lastTerminalEntry ||
    lastTerminalEntry.byteCount !== expectedTerminalBytes
  ) {
    throw new Error("工作台基准结果不符合通道、终端或统计边界");
  }
}

function assertSaturatedState(
  healthKey: "protocolHealth" | "replayProtocolHealth",
): void {
  const state = useWorkbenchStore.getState();
  if (
    state.channels.length !== CHANNEL_COUNT ||
    state.channels.some((channel) => channel.points.length !== MAX_POINTS_PER_CHANNEL) ||
    state.processedChannels.length !== 0 ||
    state.terminalEntries.length !== 0 ||
    state.stats.rxFrames !== 0 ||
    state[healthKey].acceptedFrames !== 0
  ) {
    throw new Error("工作台基准无法建立饱和缓冲前置条件");
  }
}

function repeatFrame(frame: Uint8Array, count: number): Uint8Array {
  const result = new Uint8Array(frame.length * count);
  for (let index = 0; index < count; index += 1) {
    result.set(frame, index * frame.length);
  }
  return result;
}
