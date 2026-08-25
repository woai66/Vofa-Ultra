import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import compatibilityPolicy from "../../compatibility-policy.json";
import { APP_VERSION } from "../core/appMetadata";
import {
  createDefaultAutoResponderRule,
  createInitialAutoResponderSnapshot,
} from "../core/autoResponder";
import { createInitialCommandTaskSnapshot } from "../core/commandWorkflow";
import {
  buildModbusRtuRequest,
  createInitialModbusRtuTransactionSnapshot,
  simulateModbusRtuResponse,
} from "../core/modbusRtu";
import { createEmptyProtocolHealth } from "../core/protocols";
import { createDefaultWorkspaceConfig, createWorkspaceProfile } from "../core/workspaces";
import {
  enqueueCaptureMarker,
  enqueueSimulatorCapture,
  resetSimulatorCaptureQueue,
  startCapture,
  stopCapture,
} from "../services/captureClient";
import {
  abortNumericLog,
  enqueueNumericLogSamples,
  resetNumericLogQueue,
  startNumericLog,
  stopNumericLog,
} from "../services/numericLogClient";
import {
  cancelCaptureExport,
  clearCaptureExport,
  selectCaptureExportDestinationPath,
  selectCaptureExportSourcePath,
  startCaptureExport,
} from "../services/captureExportClient";
import {
  ackReplayBatch,
  closeReplay,
  openReplay,
  pauseReplay,
  playReplay,
  selectReplayFilePath,
  seekReplay,
  setReplaySpeed,
  stopReplay,
} from "../services/replayClient";
import {
  cancelSerialFileSend,
  cancelSerialModbusTransaction,
  cancelSerialConnect,
  connectSerial,
  disconnectSerial,
  listSerialPorts,
  sendSerial,
  startSerialFileSend,
  startSerialModbusTransaction,
} from "../services/serialClient";
import type { CaptureStatePayload } from "../types/capture";
import type { NumericLogStatePayload } from "../types/numericLog";
import type {
  CaptureExportStatePayload,
  CaptureExportStatus,
} from "../types/captureExport";
import type {
  ReplayCaptureHeader,
  ReplayStatePayload,
  ReplayStatus,
} from "../types/replay";
import type {
  SerialFileSendPayload,
  SerialPortInfo,
  SerialStatePayload,
} from "../types/serial";
import type { QuickCommand } from "../types/workbench";
import {
  disposeWorkbenchRuntime,
  selectIsWorkspaceDirty,
  useWorkbenchStore,
  WORKBENCH_MIGRATABLE_STORAGE_VERSIONS,
  WORKBENCH_STORAGE_KEY,
  WORKBENCH_STORAGE_VERSION,
} from "./workbenchStore";

vi.mock("../services/serialClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/serialClient")>();
  return {
    ...actual,
    cancelSerialFileSend: vi.fn(),
    cancelSerialConnect: vi.fn(),
    cancelSerialModbusTransaction: vi.fn(),
    connectSerial: vi.fn(),
    disconnectSerial: vi.fn(),
    listSerialPorts: vi.fn(),
    sendSerial: vi.fn(),
    startSerialFileSend: vi.fn(),
    startSerialModbusTransaction: vi.fn(),
  };
});

vi.mock("../services/captureClient", () => ({
  abortCapture: vi.fn(),
  enqueueCaptureMarker: vi.fn(() => true),
  enqueueSimulatorCapture: vi.fn(() => true),
  resetSimulatorCaptureQueue: vi.fn(),
  startCapture: vi.fn(),
  stopCapture: vi.fn(),
}));

vi.mock("../services/captureExportClient", () => ({
  cancelCaptureExport: vi.fn(),
  clearCaptureExport: vi.fn(),
  selectCaptureExportDestinationPath: vi.fn(),
  selectCaptureExportSourcePath: vi.fn(),
  startCaptureExport: vi.fn(),
}));

vi.mock("../services/numericLogClient", () => ({
  abortNumericLog: vi.fn(),
  enqueueNumericLogSamples: vi.fn(() => true),
  resetNumericLogQueue: vi.fn(),
  startNumericLog: vi.fn(),
  stopNumericLog: vi.fn(),
}));

vi.mock("../services/replayClient", () => ({
  ackReplayBatch: vi.fn(),
  closeReplay: vi.fn(),
  openReplay: vi.fn(),
  pauseReplay: vi.fn(),
  playReplay: vi.fn(),
  selectReplayFilePath: vi.fn(),
  seekReplay: vi.fn(),
  setReplaySpeed: vi.fn(),
  stopReplay: vi.fn(),
}));

const cancelSerialFileSendMock = vi.mocked(cancelSerialFileSend);
const cancelSerialConnectMock = vi.mocked(cancelSerialConnect);
const cancelSerialModbusTransactionMock = vi.mocked(cancelSerialModbusTransaction);
const connectSerialMock = vi.mocked(connectSerial);
const disconnectSerialMock = vi.mocked(disconnectSerial);
const listSerialPortsMock = vi.mocked(listSerialPorts);
const sendSerialMock = vi.mocked(sendSerial);
const startSerialFileSendMock = vi.mocked(startSerialFileSend);
const startSerialModbusTransactionMock = vi.mocked(startSerialModbusTransaction);
const enqueueSimulatorCaptureMock = vi.mocked(enqueueSimulatorCapture);
const enqueueCaptureMarkerMock = vi.mocked(enqueueCaptureMarker);
const resetSimulatorCaptureQueueMock = vi.mocked(resetSimulatorCaptureQueue);
const startCaptureMock = vi.mocked(startCapture);
const stopCaptureMock = vi.mocked(stopCapture);
const abortNumericLogMock = vi.mocked(abortNumericLog);
const enqueueNumericLogSamplesMock = vi.mocked(enqueueNumericLogSamples);
const resetNumericLogQueueMock = vi.mocked(resetNumericLogQueue);
const startNumericLogMock = vi.mocked(startNumericLog);
const stopNumericLogMock = vi.mocked(stopNumericLog);
const cancelCaptureExportMock = vi.mocked(cancelCaptureExport);
const clearCaptureExportMock = vi.mocked(clearCaptureExport);
const selectCaptureExportDestinationPathMock = vi.mocked(
  selectCaptureExportDestinationPath,
);
const selectCaptureExportSourcePathMock = vi.mocked(selectCaptureExportSourcePath);
const startCaptureExportMock = vi.mocked(startCaptureExport);
const ackReplayBatchMock = vi.mocked(ackReplayBatch);
const closeReplayMock = vi.mocked(closeReplay);
const openReplayMock = vi.mocked(openReplay);
const pauseReplayMock = vi.mocked(pauseReplay);
const playReplayMock = vi.mocked(playReplay);
const selectReplayFilePathMock = vi.mocked(selectReplayFilePath);
const seekReplayMock = vi.mocked(seekReplay);
const setReplaySpeedMock = vi.mocked(setReplaySpeed);
const stopReplayMock = vi.mocked(stopReplay);

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
  await Promise.resolve();
}

const TEST_REPLAY_HEADER: ReplayCaptureHeader = {
  source: "simulator",
  protocol: "firewater",
  serialConfig: {
    portName: "",
    baudRate: 115_200,
    dataBits: 8,
    parity: "none",
    stopBits: 1,
    flowControl: "none",
    dtr: true,
    rts: true,
  },
  startedAtUnixMs: 1_000,
  timeUnit: "microseconds",
};

function quickCommand(overrides: Partial<QuickCommand> = {}): QuickCommand {
  return {
    id: "quick-1",
    name: "查询状态",
    template: "STATUS?",
    mode: "text",
    lineEnding: "crlf",
    ...overrides,
  };
}

function testBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

function serialFileSendState(
  status: SerialFileSendPayload["status"],
  overrides: Partial<SerialFileSendPayload> = {},
): SerialFileSendPayload {
  return {
    jobId: status === "idle" ? 0 : 21,
    revision: status === "idle" ? 0 : 1,
    generation: 7,
    status,
    fileName: status === "idle" ? "" : "firmware.bin",
    totalBytes: status === "idle" ? 0 : 4_096,
    transmittedBytes: 0,
    message: "",
    ...overrides,
  };
}

function replayState(
  status: ReplayStatus,
  overrides: Partial<ReplayStatePayload> = {},
): ReplayStatePayload {
  return {
    status,
    sessionId: 7,
    generation: 0,
    timelineRevision: 0,
    revision: 1,
    path: "C:\\captures\\session.vucap",
    header: TEST_REPLAY_HEADER,
    formatVersion: 2,
    complete: true,
    speed: 1,
    positionUs: 0,
    durationUs: 50_000,
    dataBytes: 32,
    recordCount: 4,
    markerCount: 0,
    ...overrides,
  };
}

function captureExportState(
  status: CaptureExportStatus,
  overrides: Partial<CaptureExportStatePayload> = {},
): CaptureExportStatePayload {
  return {
    status,
    phase: status === "running" ? "reading" : status === "idle" ? "idle" : "done",
    jobId: status === "idle" ? 0 : 7,
    revision: status === "idle" ? 0 : 1,
    sourcePath: status === "idle" ? "" : "C:\\captures\\session.vucap",
    destinationPath: status === "idle" ? "" : "C:\\captures\\session.csv",
    format: "csv",
    direction: "both",
    allowIncomplete: false,
    totalInputBytes: 4_096,
    processedInputBytes: status === "completed" ? 4_096 : 1_024,
    processedDataBytes: 512,
    processedRecords: 8,
    exportedDataBytes: 512,
    exportedRecords: 8,
    outputBytes: 1_024,
    sourceComplete: status === "completed",
    ...overrides,
  };
}

function numericLogState(
  status: NumericLogStatePayload["status"],
  overrides: Partial<NumericLogStatePayload> = {},
): NumericLogStatePayload {
  return {
    status,
    sessionId: status === "idle" ? 0 : 17,
    revision: status === "idle" ? 0 : 1,
    path: status === "idle" ? "" : "C:\\captures\\numeric.csv",
    outputBytes: 128,
    sampleCount: 0,
    ...overrides,
  };
}

describe("workbenchStore", () => {
  it("本地持久化版本与公开兼容性清单保持一致", () => {
    expect(compatibilityPolicy.localStorage).toEqual({
      key: WORKBENCH_STORAGE_KEY,
      writeVersion: WORKBENCH_STORAGE_VERSION,
      migrateFromVersions: [...WORKBENCH_MIGRATABLE_STORAGE_VERSIONS],
      futureVersionBehavior: "preserve-read-only",
    });
  });

  beforeEach(async () => {
    useWorkbenchStore.getState().stopPeriodicSend();
    useWorkbenchStore.getState().stopAutoResponder();
    await useWorkbenchStore.getState().cancelFileSend();
    await useWorkbenchStore.getState().cancelModbusTransaction();
    await useWorkbenchStore.getState().setSerialRecoveryEnabled(false);
    useWorkbenchStore.getState().clearSerialDiagnostics();
    cancelSerialFileSendMock.mockReset().mockResolvedValue(true);
    cancelSerialConnectMock.mockReset().mockResolvedValue({
      status: "disconnected",
      portName: "",
      generation: 0,
      revision: 0,
    });
    cancelSerialModbusTransactionMock.mockReset().mockResolvedValue(true);
    connectSerialMock.mockReset();
    disconnectSerialMock.mockReset().mockResolvedValue({
      status: "disconnected",
      portName: "",
      generation: 0,
      revision: 0,
    });
    listSerialPortsMock.mockReset();
    sendSerialMock.mockReset().mockResolvedValue(undefined);
    startSerialFileSendMock.mockReset();
    startSerialModbusTransactionMock.mockReset().mockResolvedValue(undefined);
    enqueueSimulatorCaptureMock.mockReset().mockReturnValue(true);
    enqueueCaptureMarkerMock.mockReset().mockReturnValue(true);
    resetSimulatorCaptureQueueMock.mockReset();
    startCaptureMock.mockReset();
    stopCaptureMock.mockReset();
    abortNumericLogMock.mockReset();
    enqueueNumericLogSamplesMock.mockReset().mockReturnValue(true);
    resetNumericLogQueueMock.mockReset();
    startNumericLogMock.mockReset();
    stopNumericLogMock.mockReset();
    cancelCaptureExportMock.mockReset();
    clearCaptureExportMock.mockReset();
    selectCaptureExportDestinationPathMock.mockReset();
    selectCaptureExportSourcePathMock.mockReset();
    startCaptureExportMock.mockReset();
    ackReplayBatchMock.mockReset().mockResolvedValue(undefined);
    closeReplayMock.mockReset();
    openReplayMock.mockReset();
    pauseReplayMock.mockReset();
    playReplayMock.mockReset();
    selectReplayFilePathMock.mockReset();
    seekReplayMock.mockReset();
    setReplaySpeedMock.mockReset();
    stopReplayMock.mockReset();
    localStorage.clear();
    useWorkbenchStore.persist.clearStorage();
    const config = createDefaultWorkspaceConfig("simulator");
    const workspace = createWorkspaceProfile("默认工作区", config, "default", 100);
    useWorkbenchStore.setState({
      isNativeRuntime: false,
      ...config,
      source: "simulator",
      connectionStatus: "disconnected",
      serialGeneration: 0,
      serialStateRevision: 0,
      statusMessage: "等待连接",
      ports: [],
      isRefreshingPorts: false,
      serialRecovery: {
        enabled: false,
        phase: "off",
        attempt: 0,
        maxAttempts: 10,
        message: "自动重连未启用",
        diagnosticEventCount: 0,
        diagnosticDroppedEvents: 0,
      },
      isCancellingSerialConnection: false,
      channels: [],
      processedChannels: [],
      attitudeSample: null,
      terminalEntries: [],
      commandHistory: [],
      commandTask: createInitialCommandTaskSnapshot(),
      autoResponderRules: [],
      autoResponder: createInitialAutoResponderSnapshot(),
      modbusTransaction: createInitialModbusRtuTransactionSnapshot(),
      modbusTransactions: [],
      serialFileSend: serialFileSendState("idle"),
      isSendingCommand: false,
      commandSendOrigin: null,
      terminalPaused: false,
      chartPaused: false,
      chartDataRevision: 0,
      stats: { rxBytes: 0, txBytes: 0, rxFrames: 0 },
      protocolHealth: createEmptyProtocolHealth(),
      replayProtocolHealth: createEmptyProtocolHealth(),
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
      workspaceTransitionStatus: "idle",
      runtimeTransitionStatus: "idle",
      workspaceStorageStatus: "writable",
      incompatibleStorageVersion: null,
      captureStatus: "idle",
      captureSessionId: 0,
      captureRevision: 0,
      captureFormatVersion: 2,
      capturePath: "",
      captureStartedAt: undefined,
      captureEndedAt: undefined,
      captureDataBytes: 0,
      captureRecordCount: 0,
      captureMarkerCount: 0,
      captureMessage: "",
      numericLogStatus: "idle",
      numericLogSessionId: 0,
      numericLogRevision: 0,
      numericLogPath: "",
      numericLogStartedAt: undefined,
      numericLogEndedAt: undefined,
      numericLogOutputBytes: 0,
      numericLogSampleCount: 0,
      numericLogMessage: "",
      captureExportStatus: "idle",
      captureExportPhase: "idle",
      captureExportJobId: 0,
      captureExportRevision: 0,
      captureExportSourcePath: "",
      captureExportDestinationPath: "",
      captureExportFormat: "csv",
      captureExportDirection: "both",
      captureExportAllowIncomplete: false,
      captureExportTotalInputBytes: 0,
      captureExportProcessedInputBytes: 0,
      captureExportProcessedDataBytes: 0,
      captureExportProcessedRecords: 0,
      captureExportExportedDataBytes: 0,
      captureExportExportedRecords: 0,
      captureExportOutputBytes: 0,
      captureExportSourceComplete: false,
      captureExportStartedAt: undefined,
      captureExportEndedAt: undefined,
      captureExportMessage: "",
      replayStatus: "idle",
      replaySessionId: 0,
      replayGeneration: 0,
      replayTimelineRevision: 0,
      replayRevision: 0,
      replayPath: "",
      replayHeader: undefined,
      replayFormatVersion: 0,
      replayComplete: false,
      replaySpeed: 1,
      replayPositionUs: 0,
      replayDurationUs: 0,
      replayDataBytes: 0,
      replayRecordCount: 0,
      replayMarkerCount: 0,
      replayMarkers: [],
      replayNextSequence: 1,
      replayMessage: "",
    });
    useWorkbenchStore.getState().setProtocol(config.protocol);
    useWorkbenchStore.getState().setProcessingGraph(config.processingGraph);
    useWorkbenchStore.getState().clearTerminal();
    useWorkbenchStore.getState().clearChart();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("诊断报告使用构建注入的应用版本", () => {
    expect(useWorkbenchStore.getState().getSerialDiagnostics().appVersion).toBe(APP_VERSION);
  });

  it("读取块模式保持每次 ingest 一条终端记录", () => {
    const encoder = new TextEncoder();

    useWorkbenchStore.getState().ingestBytes(encoder.encode("first"), 100);
    useWorkbenchStore.getState().ingestBytes(encoder.encode("second"), 200);

    expect(useWorkbenchStore.getState().terminalEntries).toMatchObject([
      { direction: "rx", timestamp: 100, text: "first", byteCount: 5 },
      { direction: "rx", timestamp: 200, text: "second", byteCount: 6 },
    ]);
  });

  it("文本行模式跨任意读取块恢复 UTF-8、空行和原始 CRLF", () => {
    const encoder = new TextEncoder();
    const first = encoder.encode("温度=23.5\r");
    useWorkbenchStore.getState().setTerminalRxRecordMode("line");
    useWorkbenchStore.getState().setTerminalRxLineEnding("crlf");

    useWorkbenchStore.getState().ingestBytes(first.slice(0, 2), 100);
    useWorkbenchStore.getState().ingestBytes(first.slice(2), 200);
    expect(useWorkbenchStore.getState().terminalEntries).toEqual([]);
    useWorkbenchStore.getState().ingestBytes(encoder.encode("\n\r\nnext\r\n"), 300);

    expect(useWorkbenchStore.getState().terminalEntries).toMatchObject([
      {
        direction: "rx",
        timestamp: 100,
        text: "温度=23.5\\r\\n",
        hex: "E6 B8 A9 E5 BA A6 3D 32 33 2E 35 0D 0A",
        byteCount: 13,
      },
      { direction: "rx", timestamp: 300, text: "\\r\\n", hex: "0D 0A", byteCount: 2 },
      {
        direction: "rx",
        timestamp: 300,
        text: "next\\r\\n",
        hex: "6E 65 78 74 0D 0A",
        byteCount: 6,
      },
    ]);
  });

  it("未结束行超限时分段，暂停时保留剩余残片", () => {
    useWorkbenchStore.getState().setTerminalRxRecordMode("line");
    useWorkbenchStore.getState().ingestBytes(new Uint8Array(2_050).fill(0x41), 100);

    expect(useWorkbenchStore.getState().terminalEntries).toMatchObject([
      { timestamp: 100, byteCount: 2_048, rxBoundary: "overflow" },
    ]);

    useWorkbenchStore.getState().setTerminalPaused(true);

    expect(useWorkbenchStore.getState().terminalEntries).toMatchObject([
      { byteCount: 2_048, rxBoundary: "overflow" },
      { timestamp: 100, text: "AA", byteCount: 2, rxBoundary: "unterminated" },
    ]);
  });

  it("暂停期间不缓存 RX，恢复后从新的文本行开始", () => {
    const encoder = new TextEncoder();
    useWorkbenchStore.getState().setTerminalRxRecordMode("line");
    useWorkbenchStore.getState().ingestBytes(encoder.encode("before"), 100);

    useWorkbenchStore.getState().setTerminalPaused(true);
    useWorkbenchStore.getState().ingestBytes(encoder.encode("ignored\n"), 200);
    useWorkbenchStore.getState().setTerminalPaused(false);
    useWorkbenchStore.getState().ingestBytes(encoder.encode("after\n"), 300);

    expect(useWorkbenchStore.getState().terminalEntries).toMatchObject([
      { text: "before", rxBoundary: "unterminated" },
      { text: "after\\n", timestamp: 300 },
    ]);
  });

  it("清空终端丢弃行残片，后续记录不混入清空前字节", () => {
    const encoder = new TextEncoder();
    useWorkbenchStore.getState().setTerminalRxRecordMode("line");
    useWorkbenchStore.getState().ingestBytes(encoder.encode("discarded"), 100);

    useWorkbenchStore.getState().clearTerminal();
    useWorkbenchStore.getState().ingestBytes(encoder.encode("kept\n"), 200);

    expect(useWorkbenchStore.getState().terminalEntries).toMatchObject([
      { timestamp: 200, text: "kept\\n", hex: "6B 65 70 74 0A", byteCount: 5 },
    ]);
  });

  it("模拟数据源断连时保留未结束行并重置下一会话", async () => {
    const encoder = new TextEncoder();
    useWorkbenchStore.setState({ source: "simulator", connectionStatus: "connected" });
    useWorkbenchStore.getState().setTerminalRxRecordMode("line");
    useWorkbenchStore.getState().ingestBytes(encoder.encode("session-one"), 100);

    await expect(useWorkbenchStore.getState().disconnect()).resolves.toBe(true);
    useWorkbenchStore.setState({ connectionStatus: "connected" });
    useWorkbenchStore.getState().ingestBytes(encoder.encode("session-two\n"), 200);

    expect(useWorkbenchStore.getState().terminalEntries).toMatchObject([
      { text: "session-one", rxBoundary: "unterminated" },
      { text: "session-two\\n", timestamp: 200 },
    ]);
  });

  it("仅在成功发送后记录会话历史并合并连续重复项", async () => {
    useWorkbenchStore.setState({
      source: "simulator",
      connectionStatus: "connected",
    });

    await useWorkbenchStore.getState().send("PING", "text", "lf");
    await useWorkbenchStore.getState().send("PING", "text", "lf");

    expect(useWorkbenchStore.getState().commandHistory).toEqual([
      expect.objectContaining({
        value: "PING",
        mode: "text",
        lineEnding: "lf",
        encodedBytes: 5,
        repeatCount: 2,
      }),
    ]);

    await useWorkbenchStore.getState().send("PING", "text", "none");
    expect(useWorkbenchStore.getState().commandHistory).toHaveLength(2);
  });

  it("手动发送以序号 1 展开变量并在历史中保留原始模板", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_123_456);
    useWorkbenchStore.setState({
      source: "simulator",
      connectionStatus: "connected",
    });
    const template = "seq=${seq} now=${unix_ms} start=${task_unix_ms}";

    await useWorkbenchStore.getState().send(template, "text", "lf");

    const txEntries = useWorkbenchStore
      .getState()
      .terminalEntries.filter((entry) => entry.direction === "tx");
    expect(txEntries.map((entry) => entry.text)).toEqual([
      "seq=1 now=1700000123456 start=1700000123456\\n",
    ]);
    expect(useWorkbenchStore.getState().commandHistory).toEqual([
      expect.objectContaining({
        value: template,
        encodedBytes: 44,
        variableCount: 3,
        repeatCount: 1,
      }),
    ]);
  });

  it("HEX 变量作为定宽字节进入 TX 链路", async () => {
    useWorkbenchStore.setState({
      source: "simulator",
      connectionStatus: "connected",
    });

    await useWorkbenchStore.getState().send("AA ${seq:u16le} 55", "hex", "none");

    const txEntry = useWorkbenchStore
      .getState()
      .terminalEntries.find((entry) => entry.direction === "tx");
    expect(txEntry?.hex).toBe("AA 01 00 55");
    expect(useWorkbenchStore.getState().commandHistory[0]).toMatchObject({
      value: "AA ${seq:u16le} 55",
      encodedBytes: 4,
      variableCount: 1,
    });
  });

  it("原始文件发送只保留 basename，并与其他 TX 工作流严格互斥", async () => {
    const queued = serialFileSendState("queued", { message: "等待发送" });
    startSerialFileSendMock.mockResolvedValue(queued);
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      connectionStatus: "connected",
      serialGeneration: 7,
    });

    await expect(
      useWorkbenchStore.getState().startFileSend("C:\\firmware\\firmware.bin"),
    ).resolves.toBe(true);
    expect(startSerialFileSendMock).toHaveBeenCalledWith("C:\\firmware\\firmware.bin");
    expect(useWorkbenchStore.getState().serialFileSend).toEqual(queued);
    expect(JSON.stringify(useWorkbenchStore.getState().serialFileSend)).not.toContain("firmware\\");

    useWorkbenchStore.getState().handleSerialFileSend(
      serialFileSendState("sending", {
        revision: 2,
        generation: 6,
        transmittedBytes: 1_024,
      }),
    );
    expect(useWorkbenchStore.getState().serialFileSend.status).toBe("queued");

    useWorkbenchStore.getState().handleSerialFileSend(
      serialFileSendState("sending", { revision: 2, transmittedBytes: 1_024 }),
    );
    await expect(useWorkbenchStore.getState().send("PING", "text", "none")).rejects.toThrow(
      "文件发送进行中",
    );
    expect(() =>
      useWorkbenchStore.getState().startPeriodicSend("PING", "text", "none", 20, 1),
    ).toThrow("文件发送进行中");
    expect(() => useWorkbenchStore.getState().startAutoResponder()).toThrow("文件发送进行中");
    await expect(
      useWorkbenchStore.getState().startModbusTransaction(
        {
          operation: "read-holding-registers",
          unitId: 1,
          address: 0,
          quantity: 1,
        },
        500,
      ),
    ).rejects.toThrow("文件发送进行中");

    await expect(useWorkbenchStore.getState().cancelFileSend()).resolves.toBe(true);
    expect(cancelSerialFileSendMock).toHaveBeenCalledWith(21);
    expect(useWorkbenchStore.getState().serialFileSend.status).toBe("cancelling");
    useWorkbenchStore.getState().handleSerialFileSend(
      serialFileSendState("cancelled", {
        revision: 3,
        transmittedBytes: 1_536,
        message: "文件发送已取消",
      }),
    );
    expect(useWorkbenchStore.getState().serialFileSend).toMatchObject({
      status: "cancelled",
      transmittedBytes: 1_536,
    });
  });

  it("取消 IPC 失败不会覆盖已经到达的文件发送终态", async () => {
    const backendCancellation = deferred<boolean>();
    cancelSerialFileSendMock.mockReturnValueOnce(backendCancellation.promise);
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      connectionStatus: "connected",
      serialGeneration: 7,
      serialFileSend: serialFileSendState("sending", {
        revision: 2,
        transmittedBytes: 1_024,
      }),
    });

    const cancellation = useWorkbenchStore.getState().cancelFileSend();
    expect(useWorkbenchStore.getState().serialFileSend.status).toBe("cancelling");

    useWorkbenchStore.getState().handleSerialFileSend(
      serialFileSendState("cancelled", {
        revision: 3,
        transmittedBytes: 1_536,
        errorCode: "cancelled",
        message: "文件发送已取消",
      }),
    );
    backendCancellation.reject(new Error("IPC 已断开"));

    await expect(cancellation).resolves.toBe(false);
    expect(useWorkbenchStore.getState().serialFileSend).toMatchObject({
      revision: 3,
      status: "cancelled",
      transmittedBytes: 1_536,
      message: "文件发送已取消",
    });
  });

  it("断开串口前请求取消活动文件发送", async () => {
    disconnectSerialMock.mockResolvedValue({
      status: "disconnected",
      portName: "COM3",
      generation: 7,
      revision: 1,
    });
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      connectionStatus: "connected",
      serialGeneration: 7,
      serialFileSend: serialFileSendState("sending", { revision: 2 }),
    });

    await expect(useWorkbenchStore.getState().disconnect()).resolves.toBe(true);

    expect(cancelSerialFileSendMock).toHaveBeenCalledWith(21);
    expect(disconnectSerialMock).toHaveBeenCalledOnce();
    expect(cancelSerialFileSendMock.mock.invocationCallOrder[0]).toBeLessThan(
      disconnectSerialMock.mock.invocationCallOrder[0]!,
    );
  });

  it("模拟器完成单次 Modbus 读事务并保留结构化结果但不写命令历史", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    useWorkbenchStore.setState({
      source: "simulator",
      connectionStatus: "connected",
    });
    const request = {
      operation: "read-holding-registers" as const,
      unitId: 1,
      address: 10,
      quantity: 2,
    };

    await expect(
      useWorkbenchStore.getState().startModbusTransaction(request, 1_000),
    ).resolves.toBe(true);
    expect(useWorkbenchStore.getState().modbusTransaction).toMatchObject({
      status: "waiting",
      request,
      startedAt: 1_700_000_000_000,
    });
    await expect(
      useWorkbenchStore.getState().send("PING", "text", "none"),
    ).rejects.toThrow("Modbus RTU 事务进行中");

    await vi.advanceTimersByTimeAsync(60);

    expect(useWorkbenchStore.getState().modbusTransaction.status).toBe("idle");
    expect(useWorkbenchStore.getState().modbusTransactions[0]).toMatchObject({
      status: "completed",
      request,
      result: { kind: "registers", values: [10, 11] },
      durationMs: 60,
    });
    expect(useWorkbenchStore.getState().commandHistory).toEqual([]);
    expect(
      useWorkbenchStore.getState().terminalEntries.map((entry) => entry.direction),
    ).toEqual(["tx", "rx"]);
    expect(useWorkbenchStore.getState().stats).toMatchObject({ txBytes: 8, rxBytes: 9 });
  });

  it("原生事务使用独立后端命令并按 generation 忽略迟到事件", async () => {
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      connectionStatus: "connected",
      serialGeneration: 7,
    });
    const request = {
      operation: "read-coils" as const,
      unitId: 2,
      address: 0,
      quantity: 9,
    };
    const response = simulateModbusRtuResponse(request);
    expect(response).not.toBeNull();

    await useWorkbenchStore.getState().startModbusTransaction(request, 750);
    const active = useWorkbenchStore.getState().modbusTransaction;
    expect(startSerialModbusTransactionMock).toHaveBeenCalledWith(
      active.transactionId,
      active.requestFrame,
      750,
    );
    useWorkbenchStore.getState().handleModbusTransaction({
      transactionId: active.transactionId,
      status: "completed",
      request: testBase64(active.requestFrame),
      response: testBase64(response!),
      startedAt: 1_000,
      endedAt: 1_010,
      durationMs: 10,
      generation: 6,
      message: "迟到响应",
    });
    expect(useWorkbenchStore.getState().modbusTransaction.status).toBe("queued");

    useWorkbenchStore.getState().handleModbusTransaction({
      transactionId: active.transactionId,
      status: "waiting",
      request: testBase64(active.requestFrame),
      startedAt: 1_000,
      durationMs: 0,
      generation: 7,
      message: "等待响应",
    });
    useWorkbenchStore.getState().handleModbusTransaction({
      transactionId: active.transactionId,
      status: "completed",
      request: testBase64(active.requestFrame),
      response: testBase64(response!),
      startedAt: 1_000,
      endedAt: 1_010,
      durationMs: 10,
      generation: 7,
      message: "事务完成",
    });

    expect(useWorkbenchStore.getState().modbusTransactions[0]).toMatchObject({
      status: "completed",
      generation: 7,
      result: {
        kind: "bits",
        values: [true, false, false, true, false, false, true, false, false],
      },
    });
  });

  it("取消原生事务后保持已发送写请求的风险提示", async () => {
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      connectionStatus: "connected",
      serialGeneration: 4,
    });
    const request = {
      operation: "write-single-register" as const,
      unitId: 1,
      address: 2,
      value: 9,
    };

    await useWorkbenchStore.getState().startModbusTransaction(request, 500);
    const active = useWorkbenchStore.getState().modbusTransaction;
    useWorkbenchStore.getState().handleModbusTransaction({
      transactionId: active.transactionId,
      status: "waiting",
      request: testBase64(active.requestFrame),
      startedAt: 1_000,
      durationMs: 0,
      generation: 4,
      message: "等待响应",
    });
    await expect(useWorkbenchStore.getState().cancelModbusTransaction()).resolves.toBe(true);
    expect(cancelSerialModbusTransactionMock).toHaveBeenCalledWith(active.transactionId);
    expect(useWorkbenchStore.getState().modbusTransaction.status).toBe("cancelling");

    useWorkbenchStore.getState().handleModbusTransaction({
      transactionId: active.transactionId,
      status: "cancelled",
      request: testBase64(active.requestFrame),
      startedAt: 1_000,
      endedAt: 1_020,
      durationMs: 20,
      generation: 4,
      errorCode: "cancelled-after-transmit",
      message: "事务已取消，但请求已经发出，写操作可能已被设备执行",
    });
    expect(useWorkbenchStore.getState().modbusTransactions[0]).toMatchObject({
      status: "cancelled",
      errorCode: "cancelled-after-transmit",
    });
  });

  it("运行环境卸载会在监听移除前本地终结原生事务", async () => {
    const backendCancellation = deferred<boolean>();
    cancelSerialModbusTransactionMock.mockReturnValueOnce(backendCancellation.promise);
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      connectionStatus: "connected",
      serialGeneration: 8,
    });
    const request = {
      operation: "write-single-register" as const,
      unitId: 1,
      address: 2,
      value: 9,
    };

    await useWorkbenchStore.getState().startModbusTransaction(request, 500);
    const active = useWorkbenchStore.getState().modbusTransaction;
    expect(active.status).toBe("queued");
    expect(active.startedAt).toBeUndefined();

    disposeWorkbenchRuntime();

    expect(cancelSerialModbusTransactionMock).toHaveBeenCalledWith(active.transactionId);
    expect(useWorkbenchStore.getState().modbusTransaction.status).toBe("idle");
    expect(useWorkbenchStore.getState().modbusTransactions[0]).toMatchObject({
      transactionId: active.transactionId,
      status: "cancelled",
      errorCode: "cancelled-after-transmit",
    });
    expect(useWorkbenchStore.getState().modbusTransactions[0]?.message).toContain(
      "写操作可能已被设备执行",
    );
    await expect(
      useWorkbenchStore.getState().send("NEXT", "text", "none"),
    ).resolves.toBeUndefined();
    expect(sendSerialMock).toHaveBeenCalledOnce();

    backendCancellation.resolve(true);
    await flushPromises();
    expect(useWorkbenchStore.getState().modbusTransaction.status).toBe("idle");
  });

  it("启动请求未返回时卸载会忽略迟到的原生终态", async () => {
    const backendStart = deferred<void>();
    const backendCancellation = deferred<boolean>();
    startSerialModbusTransactionMock.mockReturnValueOnce(backendStart.promise);
    cancelSerialModbusTransactionMock.mockReturnValueOnce(backendCancellation.promise);
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      connectionStatus: "connected",
      serialGeneration: 9,
    });
    const request = {
      operation: "write-single-register" as const,
      unitId: 1,
      address: 3,
      value: 10,
    };

    const startTransaction = useWorkbenchStore
      .getState()
      .startModbusTransaction(request, 500);
    const active = useWorkbenchStore.getState().modbusTransaction;
    expect(active.status).toBe("queued");

    disposeWorkbenchRuntime();
    const localRecord = useWorkbenchStore.getState().modbusTransactions[0];
    expect(localRecord).toMatchObject({
      transactionId: active.transactionId,
      status: "cancelled",
      errorCode: "cancelled-after-transmit",
    });

    backendStart.resolve(undefined);
    backendCancellation.resolve(true);
    await expect(startTransaction).resolves.toBe(true);
    await flushPromises();
    useWorkbenchStore.getState().handleModbusTransaction({
      transactionId: active.transactionId,
      status: "cancelled",
      request: testBase64(active.requestFrame),
      startedAt: 1_000,
      endedAt: 1_020,
      durationMs: 20,
      generation: active.generation,
      errorCode: "cancelled",
      message: "迟到的发送前取消结果",
    });

    expect(useWorkbenchStore.getState().modbusTransaction.status).toBe("idle");
    expect(useWorkbenchStore.getState().modbusTransactions).toEqual([localRecord]);
  });

  it("取消请求未返回时卸载会保留原生请求风险提示", async () => {
    const backendCancellation = deferred<boolean>();
    cancelSerialModbusTransactionMock.mockReturnValueOnce(backendCancellation.promise);
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      connectionStatus: "connected",
      serialGeneration: 10,
    });
    const request = {
      operation: "write-single-register" as const,
      unitId: 1,
      address: 4,
      value: 11,
    };

    await useWorkbenchStore.getState().startModbusTransaction(request, 500);
    const active = useWorkbenchStore.getState().modbusTransaction;
    const cancelTransaction = useWorkbenchStore.getState().cancelModbusTransaction();
    expect(useWorkbenchStore.getState().modbusTransaction.status).toBe("cancelling");

    disposeWorkbenchRuntime();
    const localRecord = useWorkbenchStore.getState().modbusTransactions[0];
    expect(cancelSerialModbusTransactionMock).toHaveBeenCalledTimes(2);
    expect(localRecord).toMatchObject({
      transactionId: active.transactionId,
      status: "cancelled",
      errorCode: "cancelled-after-transmit",
    });
    expect(localRecord?.message).toContain("写操作可能已被设备执行");

    backendCancellation.resolve(false);
    await expect(cancelTransaction).resolves.toBe(false);
    await flushPromises();
    useWorkbenchStore.getState().handleModbusTransaction({
      transactionId: active.transactionId,
      status: "cancelled",
      request: testBase64(active.requestFrame),
      startedAt: 1_000,
      endedAt: Date.now(),
      durationMs: 0,
      generation: active.generation,
      errorCode: "cancelled",
      message: "迟到的发送前取消结果",
    });

    expect(useWorkbenchStore.getState().modbusTransaction.status).toBe("idle");
    expect(useWorkbenchStore.getState().modbusTransactions).toEqual([localRecord]);
  });

  it("模拟器请求尚未发送时卸载会记录发送前取消", () => {
    const request = {
      operation: "write-single-register" as const,
      unitId: 1,
      address: 5,
      value: 12,
    };
    useWorkbenchStore.setState({
      isNativeRuntime: false,
      source: "simulator",
      connectionStatus: "connected",
      modbusTransaction: {
        transactionId: 101,
        generation: 0,
        status: "queued",
        request,
        requestFrame: buildModbusRtuRequest(request),
        timeoutMs: 500,
        queuedAt: Date.now(),
        message: "等待 Modbus RTU 总线静默",
      },
    });

    disposeWorkbenchRuntime();

    expect(cancelSerialModbusTransactionMock).not.toHaveBeenCalled();
    expect(useWorkbenchStore.getState().modbusTransaction.status).toBe("idle");
    expect(useWorkbenchStore.getState().modbusTransactions[0]).toMatchObject({
      transactionId: 101,
      status: "cancelled",
      errorCode: "cancelled",
    });
    expect(useWorkbenchStore.getState().modbusTransactions[0]?.message).toContain(
      "请求尚未发送",
    );
  });

  it("非法变量在发送前失败且不产生 TX、历史或任务", async () => {
    useWorkbenchStore.setState({
      source: "simulator",
      connectionStatus: "connected",
    });

    await expect(
      useWorkbenchStore.getState().send("${globalThis.process}", "text", "none"),
    ).rejects.toThrow("名称无效");
    expect(() =>
      useWorkbenchStore
        .getState()
        .startPeriodicSend("${seq + 1}", "text", "none", 20, 3),
    ).toThrow("名称无效");
    expect(useWorkbenchStore.getState()).toMatchObject({
      commandHistory: [],
      commandTask: { status: "idle", sentCount: 0 },
    });
    expect(
      useWorkbenchStore
        .getState()
        .terminalEntries.filter((entry) => entry.direction === "tx"),
    ).toEqual([]);
  });

  it("发送失败不写入历史且释放发送互斥状态", async () => {
    sendSerialMock.mockRejectedValueOnce(new Error("TX 队列已满"));
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      connectionStatus: "connected",
      serialGeneration: 1,
    });

    await expect(
      useWorkbenchStore.getState().send("PING", "text", "none"),
    ).rejects.toThrow("TX 队列已满");
    expect(useWorkbenchStore.getState()).toMatchObject({
      commandHistory: [],
      isSendingCommand: false,
    });

    await expect(
      useWorkbenchStore.getState().send("PING", "text", "none"),
    ).resolves.toBeUndefined();
    expect(useWorkbenchStore.getState().commandHistory).toHaveLength(1);
  });

  it("有限周期发送串行完成并把重复命令压缩为一条历史", async () => {
    vi.useFakeTimers();
    useWorkbenchStore.setState({
      source: "simulator",
      connectionStatus: "connected",
    });

    useWorkbenchStore.getState().startPeriodicSend("PING", "text", "none", 20, 3);
    await vi.advanceTimersByTimeAsync(40);

    expect(useWorkbenchStore.getState().commandTask).toMatchObject({
      status: "completed",
      sentCount: 3,
      repeatCount: 3,
    });
    expect(useWorkbenchStore.getState().commandHistory).toEqual([
      expect.objectContaining({ value: "PING", repeatCount: 3 }),
    ]);
    expect(
      useWorkbenchStore
        .getState()
        .terminalEntries.filter((entry) => entry.direction === "tx"),
    ).toHaveLength(3);
  });

  it("周期发送逐次展开序号和当前时间并冻结任务起始时间", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    useWorkbenchStore.setState({
      source: "simulator",
      connectionStatus: "connected",
    });
    const template = "${seq}:${unix_ms}:${task_unix_ms}";

    useWorkbenchStore.getState().startPeriodicSend(template, "text", "none", 20, 3);
    await vi.advanceTimersByTimeAsync(40);

    const txEntries = useWorkbenchStore
      .getState()
      .terminalEntries.filter((entry) => entry.direction === "tx");
    expect(txEntries.map((entry) => entry.text)).toEqual([
      "1:1000:1000",
      "2:1020:1000",
      "3:1040:1000",
    ]);
    expect(useWorkbenchStore.getState().commandHistory).toEqual([
      expect.objectContaining({
        value: template,
        variableCount: 3,
        repeatCount: 3,
      }),
    ]);
  });

  it("持续任务可立即停止且不会再产生定时发送", async () => {
    vi.useFakeTimers();
    useWorkbenchStore.setState({
      source: "simulator",
      connectionStatus: "connected",
    });

    useWorkbenchStore.getState().startPeriodicSend("PING", "text", "none", 20, null);
    await flushPromises();
    expect(useWorkbenchStore.getState().commandTask.sentCount).toBe(1);

    useWorkbenchStore.getState().stopPeriodicSend();
    const stoppedCount = useWorkbenchStore.getState().commandTask.sentCount;
    expect(useWorkbenchStore.getState().commandTask.status).toBe("stopped");
    await vi.advanceTimersByTimeAsync(200);
    expect(useWorkbenchStore.getState().commandTask.sentCount).toBe(stoppedCount);
  });

  it("断开数据源和串口故障都会停止持续任务", async () => {
    vi.useFakeTimers();
    useWorkbenchStore.setState({
      source: "simulator",
      connectionStatus: "connected",
    });
    useWorkbenchStore.getState().startPeriodicSend("SIM", "text", "none", 20, null);
    await flushPromises();

    await expect(useWorkbenchStore.getState().disconnect()).resolves.toBe(true);
    expect(useWorkbenchStore.getState().commandTask).toMatchObject({
      status: "stopped",
      sentCount: 1,
    });

    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      connectionStatus: "connected",
      serialGeneration: 4,
      serialStateRevision: 10,
      runtimeTransitionStatus: "idle",
    });
    useWorkbenchStore.getState().startPeriodicSend("SERIAL", "text", "none", 20, null);
    await flushPromises();
    useWorkbenchStore.getState().handleSerialState({
      status: "error",
      portName: "COM3",
      message: "设备已移除",
      errorCode: "read-failed",
      generation: 4,
      revision: 11,
    });

    expect(useWorkbenchStore.getState().commandTask.status).toBe("stopped");
    expect(useWorkbenchStore.getState().commandTask.message).toContain("连接已中断");
  });

  it("切换工作区、打开回放和运行时卸载都会停止任务", async () => {
    vi.useFakeTimers();
    const target = createWorkspaceProfile(
      "任务目标工作区",
      createDefaultWorkspaceConfig("simulator"),
      "command-target",
      200,
    );
    useWorkbenchStore.setState((state) => ({
      source: "simulator",
      connectionStatus: "connected",
      workspaces: [...state.workspaces, target],
    }));
    useWorkbenchStore.getState().startPeriodicSend("WORKSPACE", "text", "none", 20, null);
    await flushPromises();

    await expect(useWorkbenchStore.getState().switchWorkspace(target.id)).resolves.toBe(true);
    expect(useWorkbenchStore.getState().commandTask.message).toContain("工作区已切换");

    openReplayMock.mockResolvedValue(replayState("ready"));
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "simulator",
      connectionStatus: "connected",
      capturePath: "C:\\captures\\session.vucap",
      runtimeTransitionStatus: "idle",
    });
    useWorkbenchStore.getState().startPeriodicSend("REPLAY", "text", "none", 20, null);
    await flushPromises();
    await expect(useWorkbenchStore.getState().openRecentCapture()).resolves.toBe(true);
    expect(useWorkbenchStore.getState().commandTask.message).toContain("回放流程");

    useWorkbenchStore.setState({
      replayStatus: "idle",
      replaySessionId: 0,
      replayHeader: undefined,
      source: "simulator",
      connectionStatus: "connected",
      runtimeTransitionStatus: "idle",
    });
    useWorkbenchStore.getState().startPeriodicSend("DISPOSE", "text", "none", 20, null);
    await flushPromises();
    disposeWorkbenchRuntime();
    expect(useWorkbenchStore.getState().commandTask.message).toContain("运行环境已卸载");
  });

  it("实时 RX 触发带 CR 的自动应答且不写入手动命令历史", async () => {
    const now = Date.now();
    useWorkbenchStore.setState({
      source: "simulator",
      connectionStatus: "connected",
    });
    useWorkbenchStore.getState().setAutoResponderRules([
      {
        ...createDefaultAutoResponderRule("line-ready", "行结束"),
        response: "PONG ${seq}",
        lineEnding: "cr",
      },
    ]);

    useWorkbenchStore.getState().startAutoResponder();
    useWorkbenchStore.getState().ingestBytes(new TextEncoder().encode("1,2\n"), now);
    await flushPromises();

    const txEntries = useWorkbenchStore
      .getState()
      .terminalEntries.filter((entry) => entry.direction === "tx");
    expect(txEntries.map((entry) => entry.text)).toEqual(["PONG 1\\r"]);
    expect(txEntries.map((entry) => entry.hex)).toEqual(["50 4F 4E 47 20 31 0D"]);
    expect(useWorkbenchStore.getState()).toMatchObject({
      commandHistory: [],
      autoResponder: {
        status: "armed",
        matchCount: 1,
        acceptedCount: 1,
        sentCount: 1,
      },
      stats: { txBytes: 7 },
    });
  });

  it("手动发送在当前自动写入完成后优先于后续自动队列", async () => {
    const firstSend = deferred<void>();
    sendSerialMock
      .mockImplementationOnce(() => firstSend.promise)
      .mockResolvedValue(undefined);
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      connectionStatus: "connected",
      serialGeneration: 1,
    });
    useWorkbenchStore.getState().setAutoResponderRules([
      {
        ...createDefaultAutoResponderRule("line-ready", "行结束"),
        response: "AUTO",
        cooldownMs: 20,
      },
    ]);
    useWorkbenchStore.getState().startAutoResponder();
    const now = useWorkbenchStore.getState().autoResponder.startedAt!;
    useWorkbenchStore.getState().ingestBytes(Uint8Array.from([0x0a]), now);
    useWorkbenchStore.getState().ingestBytes(Uint8Array.from([0x0a]), now + 20);

    const manualSend = useWorkbenchStore.getState().send("MANUAL", "text", "none");
    expect(sendSerialMock).toHaveBeenCalledOnce();
    firstSend.resolve();
    await manualSend;
    await vi.waitFor(() => {
      expect(sendSerialMock).toHaveBeenCalledTimes(3);
    });

    expect(sendSerialMock.mock.calls.map(([bytes]) => new TextDecoder().decode(bytes))).toEqual([
      "AUTO",
      "MANUAL",
      "AUTO",
    ]);
    expect(useWorkbenchStore.getState().commandHistory).toEqual([
      expect.objectContaining({ value: "MANUAL" }),
    ]);
    expect(useWorkbenchStore.getState().autoResponder.sentCount).toBe(2);
  });

  it("连接边界取消排队的手动发送，避免发往重连后的设备", async () => {
    const firstSend = deferred<void>();
    sendSerialMock
      .mockImplementationOnce(() => firstSend.promise)
      .mockResolvedValue(undefined);
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      connectionStatus: "connected",
      serialGeneration: 1,
    });
    useWorkbenchStore.getState().setAutoResponderRules([
      {
        ...createDefaultAutoResponderRule("line-ready", "行结束"),
        response: "AUTO",
      },
    ]);
    useWorkbenchStore.getState().startAutoResponder();
    useWorkbenchStore.getState().ingestBytes(Uint8Array.from([0x0a]), Date.now());

    const manualSend = useWorkbenchStore.getState().send("MANUAL", "text", "none");
    const manualRejection = expect(manualSend).rejects.toThrow("发送上下文已变更");
    expect(sendSerialMock).toHaveBeenCalledOnce();

    await expect(useWorkbenchStore.getState().disconnect()).resolves.toBe(true);
    useWorkbenchStore.setState({ connectionStatus: "connected", serialGeneration: 2 });
    firstSend.resolve();
    await manualRejection;
    await flushPromises();

    expect(sendSerialMock).toHaveBeenCalledOnce();
    expect(useWorkbenchStore.getState().commandHistory).toEqual([]);
  });

  it("自动应答与周期发送互斥并在规则或协议变化时停机", async () => {
    useWorkbenchStore.setState({
      source: "simulator",
      connectionStatus: "connected",
    });
    const firstRule = createDefaultAutoResponderRule("rule-1");
    useWorkbenchStore.getState().setAutoResponderRules([firstRule]);
    useWorkbenchStore.getState().startAutoResponder();

    expect(() =>
      useWorkbenchStore.getState().startPeriodicSend("PING", "text", "none", 20, 1),
    ).toThrow(/自动应答运行中/);
    useWorkbenchStore.getState().setProtocol("raw");
    expect(useWorkbenchStore.getState().autoResponder).toMatchObject({ status: "stopped" });
    expect(useWorkbenchStore.getState().autoResponder.message).toContain("协议已切换");

    useWorkbenchStore.getState().startPeriodicSend("PING", "text", "none", 20, null);
    expect(() => useWorkbenchStore.getState().startAutoResponder()).toThrow(/周期发送运行中/);
    useWorkbenchStore.getState().stopPeriodicSend();
    await flushPromises();

    useWorkbenchStore.getState().startAutoResponder();
    useWorkbenchStore.getState().setAutoResponderRules([
      { ...firstRule, name: "已修改规则" },
    ]);
    expect(useWorkbenchStore.getState().autoResponder.message).toContain("规则已变更");
  });

  it("回放 RX 从结构上绕过自动应答入口", async () => {
    useWorkbenchStore.setState({
      source: "simulator",
      connectionStatus: "connected",
    });
    useWorkbenchStore.getState().setAutoResponderRules([
      createDefaultAutoResponderRule("line-ready"),
    ]);
    useWorkbenchStore.getState().startAutoResponder();
    useWorkbenchStore.setState({
      replayStatus: "playing",
      replaySessionId: 7,
      replayGeneration: 1,
      replayHeader: TEST_REPLAY_HEADER,
      replayNextSequence: 1,
    });

    useWorkbenchStore.getState().handleReplayBatch({
      sessionId: 7,
      generation: 1,
      sequence: 1,
      startUs: 1_000,
      endUs: 1_000,
      dataBytes: 2,
      records: [{ direction: "rx", timestampUs: 1_000, data: [0x31, 0x0a] }],
    });
    await flushPromises();

    expect(useWorkbenchStore.getState().autoResponder).toMatchObject({
      matchCount: 0,
      sentCount: 0,
    });
    expect(
      useWorkbenchStore.getState().terminalEntries.filter((entry) => entry.direction === "tx"),
    ).toEqual([]);
  });

  it("周期任务拒绝空草稿，即使配置了行尾", () => {
    useWorkbenchStore.setState({ connectionStatus: "connected" });

    expect(() =>
      useWorkbenchStore.getState().startPeriodicSend("", "text", "lf", 1_000, 1),
    ).toThrow("不能为空");
  });

  it("切换数据源时清空上一数据源的通道", async () => {
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      channels: [
        {
          id: "channel-0",
          name: "CH 1",
          color: "#46d89c",
          visible: true,
          points: [{ x: 1, y: 2 }],
          lastValue: 2,
        },
      ],
    });

    await useWorkbenchStore.getState().setSource("serial");

    expect(useWorkbenchStore.getState().source).toBe("serial");
    expect(useWorkbenchStore.getState().channels).toEqual([]);
  });

  it("视图暂停时仍诊断坏帧，清统计不会丢弃等待中的半帧", () => {
    useWorkbenchStore.getState().setTerminalPaused(true);
    useWorkbenchStore.getState().setChartPaused(true);

    useWorkbenchStore.getState().ingestBytes(
      new TextEncoder().encode("broken\n12"),
      1_000,
    );
    expect(useWorkbenchStore.getState()).toMatchObject({
      channels: [],
      terminalEntries: [],
      protocolHealth: {
        acceptedFrames: 0,
        droppedFrames: 1,
        lastDropReason: "non-finite-value",
        lastDropAt: 1_000,
      },
    });

    useWorkbenchStore.getState().clearProtocolHealth();
    expect(useWorkbenchStore.getState().protocolHealth).toMatchObject({
      acceptedFrames: 0,
      droppedFrames: 0,
      lastDropReason: null,
    });
    useWorkbenchStore.getState().ingestBytes(new TextEncoder().encode(",34\n"), 1_100);
    expect(useWorkbenchStore.getState()).toMatchObject({
      channels: [],
      terminalEntries: [],
      stats: { rxFrames: 1 },
      protocolHealth: {
        acceptedFrames: 1,
        droppedFrames: 0,
      },
    });

    useWorkbenchStore.getState().setProtocol("justfloat");
    expect(useWorkbenchStore.getState().protocolHealth).toMatchObject({
      acceptedFrames: 0,
      droppedFrames: 0,
      resyncCount: 0,
    });
  });

  it("运行环境降级时隔离旧串口半帧与诊断", () => {
    useWorkbenchStore.getState().setProtocol("firewater");
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      connectionStatus: "connected",
    });
    useWorkbenchStore.getState().ingestBytes(
      new TextEncoder().encode("bad\n1,"),
      1_000,
    );
    expect(useWorkbenchStore.getState().protocolHealth.droppedFrames).toBe(1);

    useWorkbenchStore.getState().setRuntimeAvailability(false);
    expect(useWorkbenchStore.getState()).toMatchObject({
      source: "simulator",
      protocolHealth: {
        acceptedFrames: 0,
        droppedFrames: 0,
        resyncCount: 0,
      },
    });

    useWorkbenchStore.getState().ingestBytes(new TextEncoder().encode("2,3\n"), 1_100);
    expect(useWorkbenchStore.getState().channels.map((channel) => channel.lastValue)).toEqual([
      2,
      3,
    ]);
    expect(useWorkbenchStore.getState().protocolHealth.acceptedFrames).toBe(1);
  });

  it("运行时释放时隔离旧半帧并清空实时诊断", () => {
    useWorkbenchStore.getState().setProtocol("firewater");
    useWorkbenchStore.getState().ingestBytes(
      new TextEncoder().encode("bad\n1,"),
      1_000,
    );

    disposeWorkbenchRuntime();
    expect(useWorkbenchStore.getState().protocolHealth).toEqual(createEmptyProtocolHealth());

    useWorkbenchStore.getState().ingestBytes(new TextEncoder().encode("2,3\n"), 1_100);
    expect(useWorkbenchStore.getState().channels.map((channel) => channel.lastValue)).toEqual([
      2,
      3,
    ]);
  });

  it("实时与回放诊断相互隔离，回放时间线切换只重置回放快照", () => {
    useWorkbenchStore.getState().ingestBytes(new TextEncoder().encode("bad\n"), 1_000);
    expect(useWorkbenchStore.getState().protocolHealth.droppedFrames).toBe(1);

    useWorkbenchStore.getState().handleReplayState(
      replayState("ready", { generation: 1, timelineRevision: 1, revision: 1 }),
    );
    useWorkbenchStore.getState().handleReplayState(
      replayState("playing", { generation: 1, timelineRevision: 1, revision: 2 }),
    );
    useWorkbenchStore.getState().handleReplayBatch({
      sessionId: 7,
      generation: 1,
      sequence: 1,
      startUs: 1_000,
      endUs: 2_000,
      dataBytes: 6,
      records: [
        {
          direction: "rx",
          timestampUs: 1_000,
          data: Array.from(new TextEncoder().encode("bad\n1\n")),
        },
      ],
    });

    expect(useWorkbenchStore.getState()).toMatchObject({
      protocolHealth: { droppedFrames: 1 },
      replayProtocolHealth: {
        acceptedFrames: 1,
        droppedFrames: 1,
        lastDropReason: "non-finite-value",
      },
    });
    useWorkbenchStore.getState().clearProtocolHealth();
    expect(useWorkbenchStore.getState()).toMatchObject({
      protocolHealth: { droppedFrames: 1 },
      replayProtocolHealth: { acceptedFrames: 0, droppedFrames: 0 },
    });

    useWorkbenchStore.getState().handleReplayState(
      replayState("paused", { generation: 2, timelineRevision: 2, revision: 3 }),
    );
    expect(useWorkbenchStore.getState()).toMatchObject({
      protocolHealth: { droppedFrames: 1 },
      replayProtocolHealth: { acceptedFrames: 0, droppedFrames: 0 },
    });
  });

  it("仅在波形数据语义边界推进修订号", async () => {
    const initialRevision = useWorkbenchStore.getState().chartDataRevision;
    useWorkbenchStore.getState().setChartPaused(true);
    useWorkbenchStore.getState().setChartWindowSeconds(30);
    useWorkbenchStore.getState().ingestBytes(new TextEncoder().encode("1\n"), 1_000);
    expect(useWorkbenchStore.getState().chartDataRevision).toBe(initialRevision);

    useWorkbenchStore.getState().clearChart();
    expect(useWorkbenchStore.getState().chartDataRevision).toBe(initialRevision + 1);
    useWorkbenchStore.getState().setProtocol("raw");
    expect(useWorkbenchStore.getState().chartDataRevision).toBe(initialRevision + 2);
    useWorkbenchStore.getState().retryProcessingGraph();
    expect(useWorkbenchStore.getState().chartDataRevision).toBe(initialRevision + 3);

    useWorkbenchStore.setState({
      replayStatus: "idle",
      replaySessionId: 0,
      replayTimelineRevision: 0,
      replayRevision: 0,
    });
    useWorkbenchStore.getState().handleReplayState(replayState("ready"));
    expect(useWorkbenchStore.getState().chartDataRevision).toBe(initialRevision + 4);

    useWorkbenchStore.getState().handleReplayState(
      replayState("paused", { timelineRevision: 1, revision: 2 }),
    );
    expect(useWorkbenchStore.getState().chartDataRevision).toBe(initialRevision + 5);

    useWorkbenchStore.getState().handleReplayState(
      replayState("paused", { timelineRevision: 1, revision: 3 }),
    );
    expect(useWorkbenchStore.getState().chartDataRevision).toBe(initialRevision + 5);
  });

  it("忽略迟到的串口状态事件", () => {
    useWorkbenchStore.setState({
      source: "serial",
      connectionStatus: "connected",
      serialStateRevision: 10,
    });

    useWorkbenchStore.getState().handleSerialState({
      status: "disconnected",
      portName: "COM3",
      generation: 2,
      revision: 9,
    });
    expect(useWorkbenchStore.getState().connectionStatus).toBe("connected");

    useWorkbenchStore.getState().handleSerialState({
      status: "error",
      portName: "COM3",
      message: "设备已移除",
      generation: 2,
      revision: 11,
    });
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "error",
      serialStateRevision: 11,
      statusMessage: "设备已移除",
    });
  });

  it("意外断线先完成录制，再按强身份跨端口恢复", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
    const captureStopped = deferred<CaptureStatePayload>();
    const originalPort: SerialPortInfo = {
      name: "COM3",
      kind: "usb",
      serialNumber: "DEVICE-001",
      vendorId: 0x1234,
      productId: 0x5678,
    };
    const reappearedPort = { ...originalPort, name: "COM19" };
    stopCaptureMock.mockReturnValue(captureStopped.promise);
    listSerialPortsMock.mockResolvedValue([reappearedPort]);
    connectSerialMock.mockResolvedValue({
      status: "connected",
      portName: "COM19",
      generation: 8,
      revision: 3,
    });
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      ports: [originalPort],
      serialConfig: {
        ...useWorkbenchStore.getState().serialConfig,
        portName: "COM3",
      },
      channels: [
        {
          id: "channel-0",
          name: "CH 1",
          color: "#46d89c",
          visible: true,
          points: [{ x: 1, y: 2 }],
          lastValue: 2,
        },
      ],
      terminalEntries: [
        {
          id: 1,
          direction: "rx",
          timestamp: 1_000,
          text: "old",
          hex: "6F 6C 64",
          byteCount: 3,
        },
      ],
      stats: { rxBytes: 256, txBytes: 32, rxFrames: 8, startedAt: 1_000 },
    });
    await useWorkbenchStore.getState().setSerialRecoveryEnabled(true);
    useWorkbenchStore.getState().handleSerialState({
      status: "connected",
      portName: "COM3",
      generation: 7,
      revision: 1,
    });
    useWorkbenchStore.setState({
      captureStatus: "recording",
      captureSessionId: 9,
      captureRevision: 1,
    });

    useWorkbenchStore.getState().handleSerialState({
      status: "error",
      portName: "COM3",
      message: "设备已移除",
      errorCode: "read-failed",
      generation: 7,
      revision: 2,
    });

    expect(stopCaptureMock).toHaveBeenCalledOnce();
    expect(listSerialPortsMock).not.toHaveBeenCalled();
    captureStopped.resolve({
      status: "idle",
      sessionId: 0,
      revision: 2,
      formatVersion: 2,
      path: "C:\\captures\\session.vucap",
      endedAtUnixMs: Date.now(),
      dataBytes: 256,
      recordCount: 8,
      markerCount: 0,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(listSerialPortsMock).toHaveBeenCalledOnce();
    expect(connectSerialMock).toHaveBeenCalledWith(
      expect.objectContaining({ portName: "COM19" }),
    );
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "connected",
      serialConfig: { portName: "COM19" },
      serialRecovery: { phase: "armed", attempt: 0 },
      channels: [{ id: "channel-0", points: [{ x: 1, y: 2 }] }],
      terminalEntries: [{ text: "old" }],
      stats: { rxBytes: 0, txBytes: 0, rxFrames: 0 },
    });
    expect(stopCaptureMock).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("恢复已启用但身份阻断时由 Store 完成故障录制收尾", async () => {
    const port: SerialPortInfo = {
      name: "COM3",
      kind: "usb",
      vendorId: 0x1234,
      productId: 0x5678,
    };
    stopCaptureMock.mockResolvedValue({
      status: "idle",
      sessionId: 0,
      revision: 2,
      formatVersion: 2,
      path: "C:\\captures\\blocked-device.vucap",
      endedAtUnixMs: Date.now(),
      dataBytes: 64,
      recordCount: 2,
      markerCount: 0,
    });
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      ports: [port],
      serialConfig: {
        ...useWorkbenchStore.getState().serialConfig,
        portName: "COM3",
      },
    });
    await useWorkbenchStore.getState().setSerialRecoveryEnabled(true);
    useWorkbenchStore.getState().handleSerialState({
      status: "connected",
      portName: "COM3",
      generation: 7,
      revision: 1,
    });
    expect(useWorkbenchStore.getState().serialRecovery.phase).toBe("blocked");
    useWorkbenchStore.setState({
      captureStatus: "recording",
      captureSessionId: 9,
      captureRevision: 1,
    });

    useWorkbenchStore.getState().handleSerialState({
      status: "error",
      portName: "COM3",
      message: "设备已移除",
      errorCode: "read-failed",
      generation: 7,
      revision: 2,
    });

    await vi.waitFor(() => {
      expect(useWorkbenchStore.getState().captureStatus).toBe("idle");
    });
    expect(stopCaptureMock).toHaveBeenCalledOnce();
    expect(listSerialPortsMock).not.toHaveBeenCalled();
    expect(connectSerialMock).not.toHaveBeenCalled();
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "error",
      serialRecovery: { enabled: true, phase: "blocked" },
      captureStatus: "idle",
      captureSessionId: 0,
    });
  });

  it("取消手动连接会立即释放界面事务并保持后端取消结果", async () => {
    const pendingConnection = deferred<SerialStatePayload>();
    const port: SerialPortInfo = {
      name: "COM3",
      kind: "usb",
      serialNumber: "DEVICE-001",
      vendorId: 0x1234,
      productId: 0x5678,
    };
    connectSerialMock.mockReturnValue(pendingConnection.promise);
    cancelSerialConnectMock.mockResolvedValue({
      status: "disconnected",
      portName: "COM3",
      generation: 2,
      revision: 2,
    });
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      ports: [port],
      serialConfig: { ...useWorkbenchStore.getState().serialConfig, portName: "COM3" },
    });

    const connecting = useWorkbenchStore.getState().connect();
    await vi.waitFor(() => {
      expect(useWorkbenchStore.getState()).toMatchObject({
        connectionStatus: "connecting",
        runtimeTransitionStatus: "connecting",
      });
    });

    const cancelling = useWorkbenchStore.getState().cancelSerialConnection();
    expect(useWorkbenchStore.getState().runtimeTransitionStatus).toBe("idle");
    await cancelling;
    expect(cancelSerialConnectMock).toHaveBeenCalledOnce();
    expect(useWorkbenchStore.getState().connectionStatus).toBe("disconnected");

    pendingConnection.resolve({
      status: "disconnected",
      portName: "COM3",
      generation: 2,
      revision: 2,
    });
    await connecting;
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "disconnected",
      runtimeTransitionStatus: "idle",
      isCancellingSerialConnection: false,
    });
  });

  it("后端尚未发布连接状态时用相同 revision 的取消快照纠正乐观状态", async () => {
    const pendingConnection = deferred<SerialStatePayload>();
    const port: SerialPortInfo = {
      name: "COM3",
      kind: "usb",
      serialNumber: "DEVICE-001",
      vendorId: 0x1234,
      productId: 0x5678,
    };
    connectSerialMock.mockReturnValue(pendingConnection.promise);
    cancelSerialConnectMock.mockResolvedValue({
      status: "disconnected",
      portName: "COM3",
      generation: 4,
      revision: 8,
    });
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      connectionStatus: "disconnected",
      serialGeneration: 4,
      serialStateRevision: 8,
      ports: [port],
      serialConfig: { ...useWorkbenchStore.getState().serialConfig, portName: "COM3" },
    });

    const connecting = useWorkbenchStore.getState().connect();
    await vi.waitFor(() => {
      expect(connectSerialMock).toHaveBeenCalledOnce();
      expect(useWorkbenchStore.getState()).toMatchObject({
        connectionStatus: "connecting",
        serialGeneration: 4,
        serialStateRevision: 8,
        runtimeTransitionStatus: "connecting",
      });
    });

    await useWorkbenchStore.getState().cancelSerialConnection();

    expect(disconnectSerialMock).not.toHaveBeenCalled();
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "disconnected",
      serialGeneration: 4,
      serialStateRevision: 8,
      runtimeTransitionStatus: "idle",
      isCancellingSerialConnection: false,
      serialRecovery: { phase: "off", attempt: 0 },
    });

    pendingConnection.reject(new Error("串口连接已取消"));
    await connecting;
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "disconnected",
      runtimeTransitionStatus: "idle",
    });
  });

  it("从错误稳态重连时用相同 revision 的取消快照恢复错误与兜底消息", async () => {
    const pendingConnection = deferred<SerialStatePayload>();
    const port: SerialPortInfo = {
      name: "COM3",
      kind: "usb",
      serialNumber: "DEVICE-001",
      vendorId: 0x1234,
      productId: 0x5678,
    };
    connectSerialMock.mockReturnValue(pendingConnection.promise);
    cancelSerialConnectMock.mockResolvedValue({
      status: "error",
      portName: "COM3",
      errorCode: "open-failed",
      generation: 4,
      revision: 8,
    });
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      connectionStatus: "error",
      serialGeneration: 4,
      serialStateRevision: 8,
      statusMessage: "上次连接失败",
      ports: [port],
      serialConfig: { ...useWorkbenchStore.getState().serialConfig, portName: "COM3" },
    });

    const connecting = useWorkbenchStore.getState().connect();
    await vi.waitFor(() => {
      expect(connectSerialMock).toHaveBeenCalledOnce();
      expect(useWorkbenchStore.getState()).toMatchObject({
        connectionStatus: "connecting",
        serialGeneration: 4,
        serialStateRevision: 8,
        runtimeTransitionStatus: "connecting",
      });
    });

    await useWorkbenchStore.getState().cancelSerialConnection();

    expect(disconnectSerialMock).not.toHaveBeenCalled();
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "error",
      serialGeneration: 4,
      serialStateRevision: 8,
      statusMessage: "串口发生未知错误",
      runtimeTransitionStatus: "idle",
      isCancellingSerialConnection: false,
      serialRecovery: { phase: "off", attempt: 0 },
    });

    pendingConnection.reject(new Error("串口连接已取消"));
    await connecting;
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "error",
      statusMessage: "串口发生未知错误",
      runtimeTransitionStatus: "idle",
    });
  });

  it("取消与刚完成连接竞速时会主动断开", async () => {
    const cancelResult = deferred<SerialStatePayload>();
    cancelSerialConnectMock.mockReturnValue(cancelResult.promise);
    disconnectSerialMock.mockResolvedValue({
      status: "disconnected",
      portName: "COM3",
      generation: 3,
      revision: 3,
    });
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      connectionStatus: "connecting",
      runtimeTransitionStatus: "connecting",
    });

    const cancelling = useWorkbenchStore.getState().cancelSerialConnection();
    useWorkbenchStore.getState().handleSerialState({
      status: "connected",
      portName: "COM3",
      generation: 2,
      revision: 2,
    });
    cancelResult.resolve({
      status: "connected",
      portName: "COM3",
      generation: 2,
      revision: 2,
    });
    await cancelling;

    expect(disconnectSerialMock).toHaveBeenCalledOnce();
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "disconnected",
      serialGeneration: 3,
      serialStateRevision: 3,
      serialRecovery: { phase: "off" },
    });
  });

  it("旧连接 Promise 失败不会污染取消后发起的新连接", async () => {
    const firstConnection = deferred<SerialStatePayload>();
    const secondConnection = deferred<SerialStatePayload>();
    const port: SerialPortInfo = {
      name: "COM3",
      kind: "usb",
      serialNumber: "DEVICE-001",
      vendorId: 0x1234,
      productId: 0x5678,
    };
    connectSerialMock
      .mockReturnValueOnce(firstConnection.promise)
      .mockReturnValueOnce(secondConnection.promise);
    cancelSerialConnectMock.mockResolvedValue({
      status: "disconnected",
      portName: "COM3",
      generation: 2,
      revision: 2,
    });
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      ports: [port],
      serialConfig: { ...useWorkbenchStore.getState().serialConfig, portName: "COM3" },
    });

    const first = useWorkbenchStore.getState().connect();
    await vi.waitFor(() => {
      expect(connectSerialMock).toHaveBeenCalledTimes(1);
    });
    await useWorkbenchStore.getState().cancelSerialConnection();

    const second = useWorkbenchStore.getState().connect();
    await vi.waitFor(() => {
      expect(connectSerialMock).toHaveBeenCalledTimes(2);
    });
    firstConnection.reject(new Error("旧连接迟到失败"));
    await first;
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "connecting",
      runtimeTransitionStatus: "connecting",
    });

    secondConnection.resolve({
      status: "connected",
      portName: "COM3",
      generation: 3,
      revision: 3,
    });
    await second;
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "connected",
      runtimeTransitionStatus: "idle",
    });
  });

  it("运行时卸载会阻止异步前置结束后再打开串口", async () => {
    const replayClosed = deferred<ReplayStatePayload>();
    const port: SerialPortInfo = {
      name: "COM3",
      kind: "usb",
      serialNumber: "DEVICE-001",
      vendorId: 0x1234,
      productId: 0x5678,
    };
    closeReplayMock.mockReturnValue(replayClosed.promise);
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      ports: [port],
      serialConfig: { ...useWorkbenchStore.getState().serialConfig, portName: "COM3" },
      replayStatus: "ready",
      replaySessionId: 7,
      replayRevision: 1,
      replayHeader: TEST_REPLAY_HEADER,
    });

    const connecting = useWorkbenchStore.getState().connect();
    await vi.waitFor(() => {
      expect(closeReplayMock).toHaveBeenCalledOnce();
    });
    disposeWorkbenchRuntime();
    replayClosed.resolve(
      replayState("idle", {
        revision: 2,
        path: "",
        header: undefined,
        complete: false,
      }),
    );
    await connecting;

    expect(connectSerialMock).not.toHaveBeenCalled();
  });

  it("相同 revision 的断开快照不会重复重置恢复状态", () => {
    useWorkbenchStore.setState({
      source: "serial",
      connectionStatus: "disconnected",
      serialGeneration: 4,
      serialStateRevision: 8,
      serialRecovery: {
        enabled: true,
        phase: "waiting",
        attempt: 2,
        maxAttempts: 10,
        message: "等待重试",
        diagnosticEventCount: 5,
        diagnosticDroppedEvents: 0,
      },
    });

    useWorkbenchStore.getState().handleSerialState({
      status: "disconnected",
      portName: "COM3",
      generation: 4,
      revision: 8,
    });

    expect(useWorkbenchStore.getState().serialRecovery).toMatchObject({
      phase: "waiting",
      attempt: 2,
    });
  });

  it("保存当前工作区并另存为独立快照", () => {
    expect(selectIsWorkspaceDirty(useWorkbenchStore.getState())).toBe(false);

    useWorkbenchStore.getState().setProtocol("raw");
    useWorkbenchStore.getState().setSendMode("hex");
    expect(selectIsWorkspaceDirty(useWorkbenchStore.getState())).toBe(true);

    useWorkbenchStore.getState().saveActiveWorkspace("原始数据");
    expect(selectIsWorkspaceDirty(useWorkbenchStore.getState())).toBe(false);
    expect(useWorkbenchStore.getState().workspaces[0]).toMatchObject({
      name: "原始数据",
      config: { protocol: "raw", sendMode: "hex" },
    });

    const copiedId = useWorkbenchStore.getState().saveWorkspaceAs("原始数据副本");
    expect(useWorkbenchStore.getState()).toMatchObject({
      activeWorkspaceId: copiedId,
    });
    expect(useWorkbenchStore.getState().workspaces).toHaveLength(2);
    expect(() => useWorkbenchStore.getState().saveWorkspaceAs("原始数据")).toThrow(/已存在/);
  });

  it("快捷命令的增改和排序参与 dirty 并随保存形成独立快照", () => {
    const first = quickCommand();
    const second = quickCommand({
      id: "quick-2",
      name: "复位设备",
      template: "AA 55",
      mode: "hex",
      lineEnding: "none",
    });

    useWorkbenchStore.getState().setQuickCommands([first, second]);
    expect(selectIsWorkspaceDirty(useWorkbenchStore.getState())).toBe(true);
    useWorkbenchStore.getState().saveActiveWorkspace("默认工作区");
    expect(selectIsWorkspaceDirty(useWorkbenchStore.getState())).toBe(false);
    expect(useWorkbenchStore.getState().workspaces[0]?.config.quickCommands).toEqual([
      first,
      second,
    ]);

    useWorkbenchStore.getState().setQuickCommands([second, first]);
    expect(selectIsWorkspaceDirty(useWorkbenchStore.getState())).toBe(true);
    const copiedId = useWorkbenchStore.getState().saveWorkspaceAs("快捷命令排序");
    expect(selectIsWorkspaceDirty(useWorkbenchStore.getState())).toBe(false);
    expect(
      useWorkbenchStore.getState().workspaces.find((workspace) => workspace.id === copiedId)
        ?.config.quickCommands,
    ).toEqual([second, first]);
  });

  it("快捷命令更新严格且原子，非法输入不会覆盖旧配置", () => {
    const existing = [quickCommand()];
    useWorkbenchStore.getState().setQuickCommands(existing);
    const stored = useWorkbenchStore.getState().quickCommands;

    expect(() =>
      useWorkbenchStore.getState().setQuickCommands([
        ...stored,
        { ...quickCommand({ name: "重复 ID" }) },
      ]),
    ).toThrow(/ID 重复/);
    expect(useWorkbenchStore.getState().quickCommands).toBe(stored);
    expect(useWorkbenchStore.getState().quickCommands).toEqual(existing);
  });

  it("切换工作区时隔离并克隆快捷命令", async () => {
    const current = quickCommand({ id: "quick-current", name: "当前命令" });
    const targetCommand = quickCommand({
      id: "quick-target",
      name: "目标命令",
      template: "TARGET",
      lineEnding: "lf",
    });
    useWorkbenchStore.getState().setQuickCommands([current]);
    useWorkbenchStore.getState().saveActiveWorkspace("默认工作区");
    const targetConfig = createDefaultWorkspaceConfig("simulator");
    targetConfig.quickCommands = [targetCommand];
    const target = createWorkspaceProfile("目标工作区", targetConfig, "target-quick", 200);
    useWorkbenchStore.setState((state) => ({ workspaces: [...state.workspaces, target] }));

    expect(await useWorkbenchStore.getState().switchWorkspace(target.id)).toBe(true);

    const applied = useWorkbenchStore.getState().quickCommands;
    expect(applied).toEqual([targetCommand]);
    expect(applied).not.toBe(target.config.quickCommands);
    expect(applied[0]).not.toBe(target.config.quickCommands[0]);
    expect(selectIsWorkspaceDirty(useWorkbenchStore.getState())).toBe(false);
  });

  it("切换工作区时清空运行数据且不自动连接", async () => {
    const targetConfig = createDefaultWorkspaceConfig("serial");
    targetConfig.serialConfig.portName = "COM11";
    targetConfig.protocol = "justfloat";
    targetConfig.displayMode = "hex";
    targetConfig.channelVisibility = { "channel-0": false };
    const target = createWorkspaceProfile("串口台架", targetConfig, "serial-bench", 200);
    useWorkbenchStore.setState((state) => ({
      workspaces: [...state.workspaces, target],
      connectionStatus: "connected",
      terminalPaused: true,
      chartPaused: true,
      terminalEntries: [
        {
          id: 1,
          direction: "rx",
          timestamp: 1,
          text: "1",
          hex: "31",
          byteCount: 1,
        },
      ],
      stats: { rxBytes: 12, txBytes: 3, rxFrames: 1, startedAt: 1 },
    }));

    const applied = await useWorkbenchStore.getState().switchWorkspace(target.id);

    expect(applied).toBe(true);
    expect(useWorkbenchStore.getState()).toMatchObject({
      activeWorkspaceId: target.id,
      source: "simulator",
      protocol: "justfloat",
      displayMode: "hex",
      connectionStatus: "disconnected",
      terminalPaused: false,
      chartPaused: false,
      channels: [],
      terminalEntries: [],
      channelVisibility: { "channel-0": false },
      stats: { rxBytes: 0, txBytes: 0, rxFrames: 0 },
    });
    expect(selectIsWorkspaceDirty(useWorkbenchStore.getState())).toBe(false);

    useWorkbenchStore.getState().setChartWindowSeconds(30);
    useWorkbenchStore.getState().saveActiveWorkspace("串口台架");
    const copiedId = useWorkbenchStore.getState().saveWorkspaceAs("串口台架副本");
    expect(
      useWorkbenchStore.getState().workspaces.find((workspace) => workspace.id === target.id)
        ?.config.source,
    ).toBe("serial");
    expect(
      useWorkbenchStore.getState().workspaces.find((workspace) => workspace.id === copiedId)
        ?.config.source,
    ).toBe("serial");
  });

  it("将通道显隐偏好应用到稍后出现的数据", () => {
    useWorkbenchStore.setState({ channelVisibility: { "channel-0": false } });

    useWorkbenchStore.getState().ingestBytes(new TextEncoder().encode("1,2\n"), 1_000);

    expect(useWorkbenchStore.getState().channels.map((channel) => channel.visible)).toEqual([
      false,
      true,
    ]);
    useWorkbenchStore.getState().toggleChannel("channel-0");
    expect(useWorkbenchStore.getState().channelVisibility).toEqual({});
  });

  it("批量追加帧时保留最新标签并完整写入各通道", () => {
    useWorkbenchStore.getState().ingestBytes(
      new TextEncoder().encode("first:1,voltage:2\n3,4\nlatest:5,6\n"),
      1_000,
    );

    const channels = useWorkbenchStore.getState().channels;
    expect(channels.map((channel) => channel.name)).toEqual(["latest", "voltage"]);
    expect(channels.map((channel) => channel.lastValue)).toEqual([5, 6]);
    expect(channels.map((channel) => channel.points.map((point) => point.y))).toEqual([
      [1, 3, 5],
      [2, 4, 6],
    ]);
  });

  it("保持基础通道直通并把处理图结果写入独立派生通道", () => {
    useWorkbenchStore.getState().setProcessingGraph({
      enabled: true,
      nodes: [
        { id: "source", kind: "input", channelIndex: 0 },
        { id: "scaled", kind: "affine", input: "source", gain: 2, offset: 1 },
        {
          id: "result",
          kind: "output",
          input: "scaled",
          name: "Scaled",
          color: "#55bde8",
        },
      ],
    });

    useWorkbenchStore.getState().ingestBytes(new TextEncoder().encode("1,2\n"), 1_000);

    const state = useWorkbenchStore.getState();
    expect(state.channels.map((channel) => channel.lastValue)).toEqual([1, 2]);
    expect(state.processedChannels).toEqual([
      expect.objectContaining({
        id: "derived:result",
        name: "Scaled",
        color: "#55bde8",
        lastValue: 3,
      }),
    ]);
    expect(state.stats.rxFrames).toBe(1);
    expect(state.processingStatus).toMatchObject({ status: "ready", processedFrames: 1 });

    useWorkbenchStore.getState().toggleChannel("derived:result");
    expect(useWorkbenchStore.getState().channelVisibility).toEqual({
      "derived:result": false,
    });
  });

  it("拒绝无效新图并保留旧配置与运行链路", () => {
    const validGraph = {
      enabled: true,
      nodes: [
        { id: "source", kind: "input" as const, channelIndex: 0 },
        {
          id: "result",
          kind: "output" as const,
          input: "source",
          name: "Result",
          color: "#46d89c",
        },
      ],
    };
    useWorkbenchStore.getState().setProcessingGraph(validGraph);

    expect(() =>
      useWorkbenchStore.getState().setProcessingGraph({
        enabled: true,
        nodes: [
          { id: "a", kind: "affine", input: "b", gain: 1, offset: 0 },
          { id: "b", kind: "affine", input: "a", gain: 1, offset: 0 },
        ],
      }),
    ).toThrow(/循环/);
    expect(useWorkbenchStore.getState().processingGraph).toEqual(validGraph);

    useWorkbenchStore.getState().ingestBytes(new TextEncoder().encode("4\n"), 1_000);
    expect(useWorkbenchStore.getState().processedChannels[0]?.lastValue).toBe(4);
  });

  it("应用处理图时统一规范化配置与运行时输出", () => {
    useWorkbenchStore.getState().setProcessingGraph({
      enabled: true,
      nodes: [
        { id: "source", kind: "input", channelIndex: 0 },
        {
          id: "result",
          kind: "output",
          input: "source",
          name: "  Filtered  ",
          color: "#AABBCC",
        },
      ],
    });
    useWorkbenchStore.getState().ingestBytes(new TextEncoder().encode("4\n"), 1_000);

    expect(useWorkbenchStore.getState().processingGraph.nodes[1]).toMatchObject({
      name: "Filtered",
      color: "#aabbcc",
    });
    expect(useWorkbenchStore.getState().processedChannels[0]).toMatchObject({
      name: "Filtered",
      color: "#aabbcc",
    });
  });

  it("波形暂停时继续推进滤波状态但不追加派生显示点", () => {
    useWorkbenchStore.getState().setProcessingGraph({
      enabled: true,
      nodes: [
        { id: "source", kind: "input", channelIndex: 0 },
        { id: "smooth", kind: "ema", input: "source", alpha: 0.5 },
        {
          id: "result",
          kind: "output",
          input: "smooth",
          name: "EMA",
          color: "#46d89c",
        },
      ],
    });
    const encoder = new TextEncoder();

    useWorkbenchStore.getState().ingestBytes(encoder.encode("0\n"), 1_000);
    useWorkbenchStore.getState().setChartPaused(true);
    useWorkbenchStore.getState().ingestBytes(encoder.encode("10\n"), 2_000);
    useWorkbenchStore.getState().setChartPaused(false);
    useWorkbenchStore.getState().ingestBytes(encoder.encode("10\n"), 3_000);

    expect(
      useWorkbenchStore.getState().processedChannels[0]?.points.map((point) => point.y),
    ).toEqual([0, 7.5]);
    expect(useWorkbenchStore.getState().processingStatus.processedFrames).toBe(3);
  });

  it("同一时间戳的多帧姿态不跨帧拼接", () => {
    const attitudeConfig = createDefaultWorkspaceConfig("simulator").attitudeConfig;
    attitudeConfig.channels.roll = "channel-0";
    attitudeConfig.channels.pitch = "channel-1";
    attitudeConfig.channels.yaw = "channel-2";
    useWorkbenchStore.getState().setAttitudeConfig(attitudeConfig);

    useWorkbenchStore
      .getState()
      .ingestBytes(new TextEncoder().encode("1,2,3\n4,5\n"), 1_000);

    expect(useWorkbenchStore.getState().attitudeSample).toMatchObject({
      frameIndex: 0,
      timestamp: 1_000,
      sourceValues: { inputMode: "euler", roll: 1, pitch: 2, yaw: 3 },
    });
  });

  it("波形暂停时仍持续更新姿态样本", () => {
    const attitudeConfig = createDefaultWorkspaceConfig("simulator").attitudeConfig;
    attitudeConfig.channels.roll = "channel-0";
    attitudeConfig.channels.pitch = "channel-1";
    attitudeConfig.channels.yaw = "channel-2";
    useWorkbenchStore.getState().setAttitudeConfig(attitudeConfig);
    useWorkbenchStore.getState().setChartPaused(true);

    useWorkbenchStore.getState().ingestBytes(new TextEncoder().encode("10,20,30\n"), 2_000);

    expect(useWorkbenchStore.getState().channels).toEqual([]);
    expect(useWorkbenchStore.getState().attitudeSample?.sourceValues).toEqual({
      inputMode: "euler",
      roll: 10,
      pitch: 20,
      yaw: 30,
    });
  });

  it("只组合来自同一帧的基础与派生姿态通道", () => {
    useWorkbenchStore.getState().setProcessingGraph({
      enabled: true,
      nodes: [
        { id: "source", kind: "input", channelIndex: 0 },
        {
          id: "roll",
          kind: "output",
          input: "source",
          name: "Roll",
          color: "#46d89c",
        },
      ],
    });
    const attitudeConfig = createDefaultWorkspaceConfig("simulator").attitudeConfig;
    attitudeConfig.channels.roll = "derived:roll";
    attitudeConfig.channels.pitch = "channel-1";
    attitudeConfig.channels.yaw = "channel-2";
    useWorkbenchStore.getState().setAttitudeConfig(attitudeConfig);

    useWorkbenchStore
      .getState()
      .ingestBytes(new TextEncoder().encode("1,2,3\n4,5,6\n"), 3_000);

    expect(useWorkbenchStore.getState().attitudeSample).toMatchObject({
      frameIndex: 1,
      sourceValues: { inputMode: "euler", roll: 4, pitch: 5, yaw: 6 },
    });
  });

  it("四元数零模帧被拒绝并保留最后一个有效姿态", () => {
    const attitudeConfig = createDefaultWorkspaceConfig("simulator").attitudeConfig;
    attitudeConfig.inputMode = "quaternion";
    attitudeConfig.channels.w = "channel-0";
    attitudeConfig.channels.x = "channel-1";
    attitudeConfig.channels.y = "channel-2";
    attitudeConfig.channels.z = "channel-3";
    useWorkbenchStore.getState().setAttitudeConfig(attitudeConfig);
    const encoder = new TextEncoder();

    useWorkbenchStore.getState().ingestBytes(encoder.encode("1,0,0,0\n"), 4_000);
    const validSample = useWorkbenchStore.getState().attitudeSample;
    useWorkbenchStore.getState().ingestBytes(encoder.encode("0,0,0,0\n"), 5_000);

    expect(validSample?.sourceValues).toEqual({
      inputMode: "quaternion",
      w: 1,
      x: 0,
      y: 0,
      z: 0,
    });
    expect(useWorkbenchStore.getState().attitudeSample).toBe(validSample);
  });

  it("删除处理图输出时清理对应姿态映射与旧样本", () => {
    useWorkbenchStore.getState().setProcessingGraph({
      enabled: true,
      nodes: [
        { id: "source", kind: "input", channelIndex: 0 },
        {
          id: "roll",
          kind: "output",
          input: "source",
          name: "Roll",
          color: "#46d89c",
        },
      ],
    });
    const attitudeConfig = createDefaultWorkspaceConfig("simulator").attitudeConfig;
    attitudeConfig.channels.roll = "derived:roll";
    attitudeConfig.channels.pitch = "channel-1";
    attitudeConfig.channels.yaw = "channel-2";
    useWorkbenchStore.getState().setAttitudeConfig(attitudeConfig);
    useWorkbenchStore.getState().ingestBytes(new TextEncoder().encode("1,2,3\n"), 6_000);
    expect(useWorkbenchStore.getState().attitudeSample).not.toBeNull();

    useWorkbenchStore.getState().setProcessingGraph({ enabled: false, nodes: [] });

    expect(useWorkbenchStore.getState().attitudeConfig.channels.roll).toBe("");
    expect(useWorkbenchStore.getState().attitudeSample).toBeNull();
  });

  it("实时与回放使用互不共享的滤波状态", () => {
    useWorkbenchStore.getState().setProcessingGraph({
      enabled: true,
      nodes: [
        { id: "source", kind: "input", channelIndex: 0 },
        { id: "smooth", kind: "moving_average", input: "source", windowSize: 2 },
        {
          id: "result",
          kind: "output",
          input: "smooth",
          name: "Average",
          color: "#46d89c",
        },
      ],
    });
    useWorkbenchStore.getState().ingestBytes(new TextEncoder().encode("10\n"), 1_000);
    expect(useWorkbenchStore.getState().processedChannels[0]?.lastValue).toBe(10);
    useWorkbenchStore.setState({
      replayStatus: "playing",
      replaySessionId: 7,
      replayGeneration: 1,
      replayHeader: TEST_REPLAY_HEADER,
      replayNextSequence: 1,
      channels: [],
      processedChannels: [],
    });

    useWorkbenchStore.getState().handleReplayBatch({
      sessionId: 7,
      generation: 1,
      sequence: 1,
      startUs: 1_000,
      endUs: 1_000,
      dataBytes: 2,
      records: [
        {
          direction: "rx",
          timestampUs: 1_000,
          data: Array.from(new TextEncoder().encode("0\n")),
        },
      ],
    });

    expect(useWorkbenchStore.getState().processedChannels[0]?.lastValue).toBe(0);
  });

  it("导入同名工作区时生成后缀且不自动应用", () => {
    const beforeActiveId = useWorkbenchStore.getState().activeWorkspaceId;
    const importedId = useWorkbenchStore.getState().importWorkspace({
      format: "vofa-ultra.workspace",
      schemaVersion: 7,
      name: "默认工作区",
      config: createDefaultWorkspaceConfig("serial"),
    });

    expect(useWorkbenchStore.getState().activeWorkspaceId).toBe(beforeActiveId);
    expect(useWorkbenchStore.getState().workspaces.find((item) => item.id === importedId)?.name).toBe(
      "默认工作区 (2)",
    );
  });

  it("删除活动工作区时先切换，并禁止删除最后一个", async () => {
    const second = createWorkspaceProfile(
      "第二工作区",
      createDefaultWorkspaceConfig("simulator"),
      "second",
      200,
    );
    useWorkbenchStore.setState((state) => ({
      workspaces: [...state.workspaces, second],
    }));

    expect(await useWorkbenchStore.getState().deleteWorkspace("default")).toBe(true);
    expect(useWorkbenchStore.getState()).toMatchObject({
      activeWorkspaceId: "second",
      workspaces: [{ id: "second" }],
    });
    await expect(useWorkbenchStore.getState().deleteWorkspace("second")).rejects.toThrow(
      /至少需要保留/,
    );
  });

  it("通过 rehydrate 把 v0 单工作区设置迁移为默认快照", async () => {
    localStorage.setItem(
      "vofa-ultra-workbench",
      JSON.stringify({
        version: 0,
        state: {
          source: "serial",
          protocol: "raw",
          serialConfig: {
            portName: "COM8",
            baudRate: 230_400,
            dataBits: 8,
            parity: "none",
            stopBits: 1,
            flowControl: "none",
            dtr: true,
            rts: true,
          },
          displayMode: "hex",
          terminalAutoScroll: false,
          chartWindowSeconds: 30,
        },
      }),
    );

    await useWorkbenchStore.persist.rehydrate();

    expect(useWorkbenchStore.getState()).toMatchObject({
      activeWorkspaceId: "default",
      workspaces: [
        {
          id: "default",
          name: "默认工作区",
          config: {
            source: "serial",
            protocol: "raw",
            displayMode: "hex",
            sendMode: "text",
            lineEnding: "none",
            chartWindowSeconds: 30,
            processingGraph: { enabled: false, nodes: [] },
            attitudeConfig: {
              inputMode: "euler",
              angleUnit: "degrees",
              coordinateFrame: "enu-flu",
            },
          },
        },
      ],
    });
    expect(
      JSON.parse(localStorage.getItem("vofa-ultra-workbench") ?? "null"),
    ).toMatchObject({ version: 7 });
  });

  it("通过 rehydrate 把 v1 工作区写回 v7 且保留快照", async () => {
    const config = createDefaultWorkspaceConfig("simulator");
    const legacyConfig = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
    delete legacyConfig.processingGraph;
    delete legacyConfig.attitudeConfig;
    delete legacyConfig.autoResponderRules;
    delete legacyConfig.quickCommands;
    delete legacyConfig.terminalRxRecordMode;
    delete legacyConfig.terminalRxLineEnding;
    localStorage.setItem(
      "vofa-ultra-workbench",
      JSON.stringify({
        version: 1,
        state: {
          ...legacyConfig,
          workspaces: [
            {
              id: "legacy",
              name: "旧工作区",
              createdAt: 100,
              updatedAt: 100,
              config: legacyConfig,
            },
          ],
          activeWorkspaceId: "legacy",
        },
      }),
    );

    await useWorkbenchStore.persist.rehydrate();

    expect(useWorkbenchStore.getState()).toMatchObject({
      activeWorkspaceId: "legacy",
      processingGraph: { enabled: false, nodes: [] },
      attitudeConfig: { inputMode: "euler", angleUnit: "degrees", coordinateFrame: "enu-flu" },
      workspaces: [
        {
          id: "legacy",
          config: {
            processingGraph: { enabled: false, nodes: [] },
            attitudeConfig: {
              inputMode: "euler",
              angleUnit: "degrees",
              coordinateFrame: "enu-flu",
            },
          },
        },
      ],
    });
    expect(
      JSON.parse(localStorage.getItem("vofa-ultra-workbench") ?? "null"),
    ).toMatchObject({ version: 7 });
  });

  it("通过 rehydrate 把 v3 工作区补充默认配置并写回 v7", async () => {
    const config = createDefaultWorkspaceConfig("simulator");
    const legacyConfig = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
    delete legacyConfig.autoResponderRules;
    delete legacyConfig.quickCommands;
    delete legacyConfig.terminalRxRecordMode;
    delete legacyConfig.terminalRxLineEnding;
    localStorage.setItem(
      "vofa-ultra-workbench",
      JSON.stringify({
        version: 3,
        state: {
          ...legacyConfig,
          workspaces: [
            {
              id: "legacy-v3",
              name: "v3 工作区",
              createdAt: 100,
              updatedAt: 100,
              config: legacyConfig,
            },
          ],
          activeWorkspaceId: "legacy-v3",
        },
      }),
    );

    await useWorkbenchStore.persist.rehydrate();

    expect(useWorkbenchStore.getState()).toMatchObject({
      activeWorkspaceId: "legacy-v3",
      autoResponderRules: [],
      quickCommands: [],
      workspaces: [
        { id: "legacy-v3", config: { autoResponderRules: [], quickCommands: [] } },
      ],
    });
    expect(
      JSON.parse(localStorage.getItem("vofa-ultra-workbench") ?? "null"),
    ).toMatchObject({ version: 7 });
  });

  it("通过 rehydrate 从 v4 补充空快捷命令并保留全部工作区", async () => {
    const firstConfig = createDefaultWorkspaceConfig("simulator");
    firstConfig.autoResponderRules = [createDefaultAutoResponderRule("ready", "设备就绪")];
    const secondConfig = createDefaultWorkspaceConfig("serial");
    const legacyFirst = JSON.parse(JSON.stringify(firstConfig)) as Record<string, unknown>;
    const legacySecond = JSON.parse(JSON.stringify(secondConfig)) as Record<string, unknown>;
    delete legacyFirst.quickCommands;
    delete legacySecond.quickCommands;
    delete legacyFirst.terminalRxRecordMode;
    delete legacyFirst.terminalRxLineEnding;
    delete legacySecond.terminalRxRecordMode;
    delete legacySecond.terminalRxLineEnding;
    localStorage.setItem(
      "vofa-ultra-workbench",
      JSON.stringify({
        version: 4,
        state: {
          ...legacySecond,
          workspaces: [
            {
              id: "legacy-v4-a",
              name: "v4 工作区 A",
              createdAt: 100,
              updatedAt: 100,
              config: legacyFirst,
            },
            {
              id: "legacy-v4-b",
              name: "v4 工作区 B",
              createdAt: 200,
              updatedAt: 200,
              config: legacySecond,
            },
          ],
          activeWorkspaceId: "legacy-v4-b",
        },
      }),
    );

    await useWorkbenchStore.persist.rehydrate();

    expect(useWorkbenchStore.getState()).toMatchObject({
      activeWorkspaceId: "legacy-v4-b",
      quickCommands: [],
      workspaces: [
        {
          id: "legacy-v4-a",
          config: { autoResponderRules: firstConfig.autoResponderRules, quickCommands: [] },
        },
        { id: "legacy-v4-b", config: { quickCommands: [] } },
      ],
    });
    expect(
      JSON.parse(localStorage.getItem("vofa-ultra-workbench") ?? "null"),
    ).toMatchObject({ version: 7 });
  });

  it("通过 rehydrate 把 v5 的全部工作区无损迁移并写回 v7", async () => {
    const firstConfig = createDefaultWorkspaceConfig("simulator");
    firstConfig.lineEnding = "crlf";
    firstConfig.autoResponderRules = [createDefaultAutoResponderRule("legacy-rule")];
    firstConfig.autoResponderRules[0]!.lineEnding = "lf";
    firstConfig.quickCommands = [quickCommand({ lineEnding: "crlf" })];
    const secondConfig = createDefaultWorkspaceConfig("serial");
    secondConfig.lineEnding = "lf";
    const first = createWorkspaceProfile("v5 工作区 A", firstConfig, "legacy-v5-a", 100);
    const second = createWorkspaceProfile("v5 工作区 B", secondConfig, "legacy-v5-b", 200);
    delete (first.config as Partial<typeof first.config>).terminalRxRecordMode;
    delete (first.config as Partial<typeof first.config>).terminalRxLineEnding;
    delete (second.config as Partial<typeof second.config>).terminalRxRecordMode;
    delete (second.config as Partial<typeof second.config>).terminalRxLineEnding;
    const legacySecondConfig = JSON.parse(JSON.stringify(secondConfig)) as Record<string, unknown>;
    delete legacySecondConfig.terminalRxRecordMode;
    delete legacySecondConfig.terminalRxLineEnding;
    localStorage.setItem(
      "vofa-ultra-workbench",
      JSON.stringify({
        version: 5,
        state: {
          ...legacySecondConfig,
          workspaces: [first, second],
          activeWorkspaceId: second.id,
        },
      }),
    );

    await useWorkbenchStore.persist.rehydrate();

    expect(useWorkbenchStore.getState()).toMatchObject({
      activeWorkspaceId: second.id,
      lineEnding: "lf",
      workspaces: [
        {
          id: first.id,
          config: {
            lineEnding: "crlf",
            autoResponderRules: firstConfig.autoResponderRules,
            quickCommands: firstConfig.quickCommands,
          },
        },
        { id: second.id, config: { lineEnding: "lf" } },
      ],
    });
    expect(
      JSON.parse(localStorage.getItem("vofa-ultra-workbench") ?? "null"),
    ).toMatchObject({ version: 7 });
  });

  it("迁移 v6 本地状态并保留工作区内的 CR 发送行尾", async () => {
    const config = createDefaultWorkspaceConfig("simulator");
    config.lineEnding = "cr";
    config.autoResponderRules = [createDefaultAutoResponderRule("cr-rule")];
    config.autoResponderRules[0]!.lineEnding = "cr";
    config.quickCommands = [quickCommand({ lineEnding: "cr" })];
    const workspace = createWorkspaceProfile("CR 工作区", config, "cr-workspace", 100);
    delete (workspace.config as Partial<typeof workspace.config>).terminalRxRecordMode;
    delete (workspace.config as Partial<typeof workspace.config>).terminalRxLineEnding;
    const legacyConfig = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
    delete legacyConfig.terminalRxRecordMode;
    delete legacyConfig.terminalRxLineEnding;
    localStorage.setItem(
      "vofa-ultra-workbench",
      JSON.stringify({
        version: 6,
        state: {
          ...legacyConfig,
          workspaces: [workspace],
          activeWorkspaceId: workspace.id,
        },
      }),
    );

    await useWorkbenchStore.persist.rehydrate();

    expect(useWorkbenchStore.getState()).toMatchObject({
      activeWorkspaceId: workspace.id,
      lineEnding: "cr",
      autoResponderRules: [{ lineEnding: "cr" }],
      quickCommands: [{ lineEnding: "cr" }],
      terminalRxRecordMode: "chunk",
      terminalRxLineEnding: "lf",
      workspaces: [
        {
          id: workspace.id,
          config: {
            lineEnding: "cr",
            autoResponderRules: [{ lineEnding: "cr" }],
            quickCommands: [{ lineEnding: "cr" }],
            terminalRxRecordMode: "chunk",
            terminalRxLineEnding: "lf",
          },
        },
      ],
    });
  });

  it("拒绝并保留更高版本的持久化数据", async () => {
    const futureValue = JSON.stringify({
      version: 8,
      state: {
        futureWorkspaceFormat: true,
        workspaces: [{ id: "future-only" }],
      },
    });
    localStorage.setItem("vofa-ultra-workbench", futureValue);

    await useWorkbenchStore.persist.rehydrate();
    useWorkbenchStore.getState().setDisplayMode("hex");

    expect(useWorkbenchStore.getState()).toMatchObject({
      workspaceStorageStatus: "newer-version",
      incompatibleStorageVersion: 8,
    });
    expect(() => useWorkbenchStore.getState().saveActiveWorkspace("不会保存")).toThrow(
      /版本 8.*不能保存/,
    );
    expect(() => useWorkbenchStore.getState().setQuickCommands([quickCommand()])).toThrow(
      /版本 8.*不能保存/,
    );
    expect(localStorage.getItem("vofa-ultra-workbench")).toBe(futureValue);
    useWorkbenchStore.persist.clearStorage();
  });

  it("工作区事务进行时拒绝重入和配置修改", async () => {
    const targetConfig = createDefaultWorkspaceConfig("simulator");
    targetConfig.protocol = "raw";
    const target = createWorkspaceProfile("目标工作区", targetConfig, "target", 200);
    useWorkbenchStore.setState((state) => ({
      workspaces: [...state.workspaces, target],
      connectionStatus: "connected",
    }));

    const firstSwitch = useWorkbenchStore.getState().switchWorkspace(target.id);
    expect(useWorkbenchStore.getState().workspaceTransitionStatus).toBe("switching");
    useWorkbenchStore.getState().updateSerialConfig("baudRate", 9_600);
    useWorkbenchStore.getState().setQuickCommands([quickCommand()]);
    const secondSwitch = await useWorkbenchStore.getState().switchWorkspace("default");

    expect(secondSwitch).toBe(false);
    expect(useWorkbenchStore.getState().serialConfig.baudRate).toBe(115_200);
    expect(useWorkbenchStore.getState().quickCommands).toEqual([]);
    expect(await firstSwitch).toBe(true);
    expect(useWorkbenchStore.getState()).toMatchObject({
      activeWorkspaceId: target.id,
      protocol: "raw",
      workspaceTransitionStatus: "idle",
    });
  });

  it("串口列表刷新期间拒绝切换和删除工作区", async () => {
    const target = createWorkspaceProfile(
      "目标工作区",
      createDefaultWorkspaceConfig("simulator"),
      "target",
      200,
    );
    useWorkbenchStore.setState((state) => ({
      workspaces: [...state.workspaces, target],
      isRefreshingPorts: true,
    }));

    expect(await useWorkbenchStore.getState().switchWorkspace(target.id)).toBe(false);
    expect(await useWorkbenchStore.getState().deleteWorkspace("default")).toBe(false);
    expect(useWorkbenchStore.getState()).toMatchObject({
      activeWorkspaceId: "default",
      isRefreshingPorts: true,
      workspaces: [{ id: "default" }, { id: "target" }],
      workspaceTransitionStatus: "idle",
    });
  });

  it("拒绝并发刷新串口列表并保持忙碌状态直到请求完成", async () => {
    let resolvePorts: ((ports: Awaited<ReturnType<typeof listSerialPorts>>) => void) | undefined;
    listSerialPortsMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePorts = resolve;
        }),
    );
    useWorkbenchStore.setState({ isNativeRuntime: true });

    const firstRefresh = useWorkbenchStore.getState().refreshPorts();
    const secondRefresh = useWorkbenchStore.getState().refreshPorts();

    expect(listSerialPortsMock).toHaveBeenCalledTimes(1);
    await secondRefresh;
    expect(useWorkbenchStore.getState().isRefreshingPorts).toBe(true);

    resolvePorts?.([{ name: "COM7", kind: "usb" }]);
    await firstRefresh;
    expect(useWorkbenchStore.getState()).toMatchObject({
      isRefreshingPorts: false,
      ports: [{ name: "COM7", kind: "usb" }],
      serialConfig: { portName: "COM7" },
    });
  });

  it("开始录制时冻结数据源、协议和串口参数", async () => {
    startCaptureMock.mockResolvedValue({
      status: "recording",
      sessionId: 7,
      revision: 3,
      formatVersion: 2,
      path: "C:\\captures\\session.vucap",
      startedAtUnixMs: 1_000,
      dataBytes: 0,
      recordCount: 0,
      markerCount: 0,
    });
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      connectionStatus: "connected",
      protocol: "justfloat",
      serialConfig: {
        ...useWorkbenchStore.getState().serialConfig,
        portName: "COM7",
        baudRate: 921_600,
      },
    });

    expect(await useWorkbenchStore.getState().startCapture()).toBe(true);
    expect(startCaptureMock).toHaveBeenCalledWith({
      source: "simulator",
      protocol: "justfloat",
      serialConfig: expect.objectContaining({ portName: "COM7", baudRate: 921_600 }),
    });
    expect(useWorkbenchStore.getState()).toMatchObject({
      captureStatus: "recording",
      captureSessionId: 7,
      capturePath: "C:\\captures\\session.vucap",
    });

    useWorkbenchStore.getState().setProtocol("raw");
    await useWorkbenchStore.getState().setSource("serial");
    useWorkbenchStore.getState().updateSerialConfig("baudRate", 57_600);
    expect(useWorkbenchStore.getState().protocol).toBe("justfloat");
    expect(useWorkbenchStore.getState().source).toBe("simulator");
    expect(useWorkbenchStore.getState().serialConfig.baudRate).toBe(921_600);
  });

  it("数值记录可与原始捕获并行并冻结数据源协议", async () => {
    startNumericLogMock.mockResolvedValue(
      numericLogState("recording", {
        sessionId: 17,
        revision: 3,
        startedAtUnixMs: 1_000,
      }),
    );
    startCaptureMock.mockResolvedValue({
      status: "recording",
      sessionId: 7,
      revision: 3,
      formatVersion: 2,
      path: "C:\\captures\\session.vucap",
      startedAtUnixMs: 1_000,
      dataBytes: 0,
      recordCount: 0,
      markerCount: 0,
    });
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      connectionStatus: "connected",
      protocol: "justfloat",
    });

    expect(await useWorkbenchStore.getState().startNumericLog()).toBe(true);
    expect(startNumericLogMock).toHaveBeenCalledWith({
      source: "simulator",
      protocol: "justfloat",
    });
    expect(await useWorkbenchStore.getState().startCapture()).toBe(true);
    expect(useWorkbenchStore.getState()).toMatchObject({
      numericLogStatus: "recording",
      numericLogSessionId: 17,
      captureStatus: "recording",
      captureSessionId: 7,
    });

    useWorkbenchStore.getState().setProtocol("raw");
    await useWorkbenchStore.getState().setSource("serial");
    useWorkbenchStore.getState().updateSerialConfig("baudRate", 57_600);
    expect(useWorkbenchStore.getState().protocol).toBe("justfloat");
    expect(useWorkbenchStore.getState().source).toBe("simulator");
    expect(useWorkbenchStore.getState().serialConfig.baudRate).toBe(115_200);
  });

  it("Raw 协议拒绝启动数值记录且不调用后端", async () => {
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      connectionStatus: "connected",
      protocol: "raw",
    });

    await expect(useWorkbenchStore.getState().startNumericLog()).resolves.toBe(false);
    expect(startNumericLogMock).not.toHaveBeenCalled();
    expect(useWorkbenchStore.getState()).toMatchObject({
      numericLogStatus: "error",
      numericLogMessage: expect.stringMatching(/不产生数值通道/),
    });
  });

  it("暂停视图时仍把模拟器原始 RX 和 TX 送入录制队列", () => {
    useWorkbenchStore.setState({
      captureStatus: "recording",
      captureSessionId: 4,
      terminalPaused: true,
      chartPaused: true,
      connectionStatus: "connected",
    });
    const rxBytes = new Uint8Array([1, 2, 3]);
    const txBytes = new Uint8Array([4, 5]);

    useWorkbenchStore.getState().ingestBytes(rxBytes, 1_000);
    useWorkbenchStore.getState().handleSerialTx({
      data: btoa(String.fromCharCode(...txBytes)),
      byteCount: txBytes.length,
      transmittedAt: 1_001,
      generation: 0,
    });

    expect(enqueueSimulatorCaptureMock).toHaveBeenNthCalledWith(
      1,
      4,
      "rx",
      rxBytes,
      expect.any(Function),
    );
    expect(enqueueSimulatorCaptureMock).toHaveBeenNthCalledWith(
      2,
      4,
      "tx",
      txBytes,
      expect.any(Function),
    );
    expect(useWorkbenchStore.getState()).toMatchObject({
      channels: [],
      terminalEntries: [],
      stats: { rxBytes: 3, txBytes: 2 },
    });
  });

  it("录制中把命名标记加入当前会话的有界 FIFO", () => {
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      captureStatus: "recording",
      captureSessionId: 4,
      runtimeTransitionStatus: "idle",
    });

    expect(useWorkbenchStore.getState().addCaptureMarker(" 进入稳态 ", "orange")).toBe(
      true,
    );
    expect(enqueueCaptureMarkerMock).toHaveBeenCalledWith(
      4,
      "orange",
      "进入稳态",
      expect.any(Function),
      expect.any(Function),
    );

    const rejectMarker = enqueueCaptureMarkerMock.mock.calls[0]?.[3];
    rejectMarker?.(new Error("单次捕获最多添加 512 个标记"));
    expect(useWorkbenchStore.getState()).toMatchObject({
      captureStatus: "recording",
      captureMessage: "单次捕获最多添加 512 个标记",
    });

    useWorkbenchStore.setState({ captureMarkerCount: 512 });
    expect(useWorkbenchStore.getState().addCaptureMarker("上限外", "red")).toBe(false);
    expect(enqueueCaptureMarkerMock).toHaveBeenCalledOnce();
  });

  it("波形暂停时仍记录基础与派生数值样本", () => {
    useWorkbenchStore.getState().setProtocol("firewater");
    useWorkbenchStore.getState().setProcessingGraph({
      enabled: true,
      nodes: [
        { id: "source", kind: "input", channelIndex: 0 },
        { id: "scaled", kind: "affine", input: "source", gain: 2, offset: 1 },
        {
          id: "result",
          kind: "output",
          input: "scaled",
          name: "Scaled",
          color: "#55bde8",
        },
      ],
    });
    useWorkbenchStore.setState({
      numericLogStatus: "recording",
      numericLogSessionId: 17,
      terminalPaused: true,
      chartPaused: true,
      connectionStatus: "connected",
    });

    useWorkbenchStore.getState().ingestBytes(
      new TextEncoder().encode("temp:1,2\n"),
      1_000,
    );

    expect(enqueueNumericLogSamplesMock).toHaveBeenCalledOnce();
    expect(enqueueNumericLogSamplesMock).toHaveBeenCalledWith(
      17,
      [
        {
          timestampUnixUs: 1_000_000,
          channelKind: "base",
          channelId: "channel-0",
          channelName: "temp",
          value: 1,
        },
        {
          timestampUnixUs: 1_000_000,
          channelKind: "base",
          channelId: "channel-1",
          channelName: "CH 2",
          value: 2,
        },
        {
          timestampUnixUs: 1_000_000,
          channelKind: "derived",
          channelId: "derived:result",
          channelName: "Scaled",
          value: 3,
        },
      ],
      expect.any(Function),
    );
    expect(useWorkbenchStore.getState()).toMatchObject({
      channels: [],
      processedChannels: [],
      terminalEntries: [],
      stats: { rxFrames: 1 },
    });
  });

  it("断开数据源前并行完成两类记录", async () => {
    stopCaptureMock.mockResolvedValue({
      status: "idle",
      sessionId: 9,
      revision: 6,
      formatVersion: 2,
      path: "C:\\captures\\complete.vucap",
      endedAtUnixMs: 2_000,
      dataBytes: 128,
      recordCount: 4,
      markerCount: 1,
    });
    stopNumericLogMock.mockResolvedValue(
      numericLogState("idle", {
        sessionId: 17,
        revision: 6,
        path: "C:\\captures\\numeric.csv",
        endedAtUnixMs: 2_000,
        outputBytes: 256,
        sampleCount: 6,
      }),
    );
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      connectionStatus: "connected",
      captureStatus: "recording",
      captureSessionId: 9,
      numericLogStatus: "recording",
      numericLogSessionId: 17,
    });

    await expect(useWorkbenchStore.getState().disconnect()).resolves.toBe(true);
    expect(stopCaptureMock).toHaveBeenCalledOnce();
    expect(stopNumericLogMock).toHaveBeenCalledOnce();
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "disconnected",
      captureStatus: "idle",
      numericLogStatus: "idle",
      numericLogSampleCount: 6,
    });
  });

  it("数值记录收尾时忽略同一会话的迟到进度状态", async () => {
    const stopping = deferred<NumericLogStatePayload>();
    stopNumericLogMock.mockReturnValue(stopping.promise);
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      connectionStatus: "connected",
      protocol: "firewater",
      numericLogStatus: "recording",
      numericLogSessionId: 17,
      numericLogRevision: 3,
      numericLogMessage: "",
    });

    const stopPromise = useWorkbenchStore.getState().stopNumericLog();
    expect(useWorkbenchStore.getState()).toMatchObject({
      numericLogStatus: "stopping",
      numericLogMessage: "正在完成数值 CSV",
    });

    useWorkbenchStore.getState().handleNumericLogState(
      numericLogState("recording", {
        sessionId: 17,
        revision: 4,
        outputBytes: 256,
        sampleCount: 6,
        message: "记录中",
      }),
    );
    expect(useWorkbenchStore.getState()).toMatchObject({
      numericLogStatus: "stopping",
      numericLogRevision: 4,
      numericLogOutputBytes: 256,
      numericLogSampleCount: 6,
      numericLogMessage: "正在完成数值 CSV",
    });

    stopping.resolve(
      numericLogState("idle", {
        sessionId: 17,
        revision: 5,
        path: "C:\\captures\\numeric.csv",
        outputBytes: 320,
        sampleCount: 8,
      }),
    );
    await expect(stopPromise).resolves.toBe(true);
    expect(useWorkbenchStore.getState()).toMatchObject({
      numericLogStatus: "idle",
      numericLogRevision: 5,
      numericLogSampleCount: 8,
    });
  });

  it("捕获收尾时忽略同一会话的迟到录制状态", async () => {
    const stopping = deferred<CaptureStatePayload>();
    stopCaptureMock.mockReturnValue(stopping.promise);
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      captureStatus: "recording",
      captureSessionId: 9,
      captureRevision: 3,
      captureMessage: "",
    });

    const stopPromise = useWorkbenchStore.getState().stopCapture();
    expect(useWorkbenchStore.getState()).toMatchObject({
      captureStatus: "stopping",
      captureMessage: "正在完成捕获文件",
    });

    useWorkbenchStore.getState().handleCaptureState({
      status: "recording",
      sessionId: 9,
      revision: 4,
      formatVersion: 2,
      path: "C:\\captures\\session.vucap.part",
      dataBytes: 256,
      recordCount: 6,
      markerCount: 2,
      message: "录制中",
    });
    expect(useWorkbenchStore.getState()).toMatchObject({
      captureStatus: "stopping",
      captureRevision: 4,
      captureDataBytes: 256,
      captureMarkerCount: 2,
      captureMessage: "正在完成捕获文件",
    });

    stopping.resolve({
      status: "idle",
      sessionId: 9,
      revision: 5,
      formatVersion: 2,
      path: "C:\\captures\\session.vucap",
      dataBytes: 320,
      recordCount: 8,
      markerCount: 2,
    });
    await expect(stopPromise).resolves.toBe(true);
    expect(useWorkbenchStore.getState()).toMatchObject({
      captureStatus: "idle",
      captureRevision: 5,
      captureMarkerCount: 2,
    });
    expect(resetSimulatorCaptureQueueMock).toHaveBeenCalled();
  });

  it("工作区切换先完成录制并忽略迟到状态", async () => {
    const target = createWorkspaceProfile(
      "目标工作区",
      createDefaultWorkspaceConfig("simulator"),
      "target",
      200,
    );
    stopCaptureMock.mockResolvedValue({
      status: "idle",
      sessionId: 9,
      revision: 6,
      formatVersion: 2,
      path: "C:\\captures\\complete.vucap",
      startedAtUnixMs: 1_000,
      endedAtUnixMs: 2_000,
      dataBytes: 128,
      recordCount: 4,
      markerCount: 1,
      message: "捕获文件已完成",
    });
    useWorkbenchStore.setState((state) => ({
      workspaces: [...state.workspaces, target],
      isNativeRuntime: true,
      connectionStatus: "connected",
      captureStatus: "recording",
      captureSessionId: 9,
      captureRevision: 5,
    }));

    expect(await useWorkbenchStore.getState().switchWorkspace(target.id)).toBe(true);
    expect(stopCaptureMock).toHaveBeenCalledOnce();
    expect(useWorkbenchStore.getState()).toMatchObject({
      activeWorkspaceId: target.id,
      captureStatus: "idle",
      captureRevision: 6,
      captureDataBytes: 128,
    });

    useWorkbenchStore.getState().handleCaptureState({
      status: "recording",
      sessionId: 9,
      revision: 5,
      formatVersion: 2,
      path: "late.vucap",
      dataBytes: 64,
      recordCount: 2,
      markerCount: 0,
    });
    expect(useWorkbenchStore.getState()).toMatchObject({
      captureStatus: "idle",
      captureRevision: 6,
      captureDataBytes: 128,
    });
  });

  it("录制尚未收尾时不提前断开数据源", async () => {
    stopCaptureMock.mockResolvedValue({
      status: "stopping",
      sessionId: 11,
      revision: 8,
      formatVersion: 2,
      path: "C:\\captures\\pending.vucap",
      startedAtUnixMs: 1_000,
      dataBytes: 64,
      recordCount: 2,
      markerCount: 0,
      message: "正在完成捕获文件",
    });
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      connectionStatus: "connected",
      captureStatus: "recording",
      captureSessionId: 11,
      captureRevision: 7,
    });

    await expect(useWorkbenchStore.getState().disconnect()).resolves.toBe(false);
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "connected",
      captureStatus: "stopping",
      statusMessage: "结束录制失败，未断开数据源",
    });
  });

  it("选择源文件后按格式生成请求且二进制强制单一方向", async () => {
    selectCaptureExportSourcePathMock.mockResolvedValue(
      "C:\\captures\\session.vucap",
    );
    selectCaptureExportDestinationPathMock.mockResolvedValue(
      "C:\\captures\\session.bin",
    );
    startCaptureExportMock.mockResolvedValue(
      captureExportState("running", {
        phase: "reading",
        destinationPath: "C:\\captures\\session.bin",
        format: "binary",
        direction: "rx",
      }),
    );
    useWorkbenchStore.setState({ isNativeRuntime: true });

    await expect(
      useWorkbenchStore.getState().selectCaptureExportSource(),
    ).resolves.toBe(true);
    useWorkbenchStore.getState().setCaptureExportFormat("binary");
    expect(useWorkbenchStore.getState()).toMatchObject({
      captureExportStatus: "idle",
      captureExportFormat: "binary",
      captureExportDirection: "rx",
      captureExportSourcePath: "C:\\captures\\session.vucap",
    });

    await expect(useWorkbenchStore.getState().startCaptureExport()).resolves.toBe(true);
    expect(selectCaptureExportDestinationPathMock).toHaveBeenCalledWith(
      "C:\\captures\\session.vucap",
      "binary",
    );
    expect(startCaptureExportMock).toHaveBeenCalledWith({
      sourcePath: "C:\\captures\\session.vucap",
      destinationPath: "C:\\captures\\session.bin",
      format: "binary",
      direction: "rx",
      allowIncomplete: false,
    });
    expect(useWorkbenchStore.getState()).toMatchObject({
      captureExportStatus: "running",
      captureExportJobId: 7,
      captureExportDestinationPath: "C:\\captures\\session.bin",
    });
  });

  it("录制活跃时拒绝选择或启动导出且不打开文件对话框", async () => {
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      captureStatus: "recording",
      captureExportSourcePath: "C:\\captures\\older.vucap",
    });

    await expect(
      useWorkbenchStore.getState().selectCaptureExportSource(),
    ).resolves.toBe(false);
    await expect(useWorkbenchStore.getState().startCaptureExport()).resolves.toBe(false);
    expect(selectCaptureExportSourcePathMock).not.toHaveBeenCalled();
    expect(selectCaptureExportDestinationPathMock).not.toHaveBeenCalled();
    expect(startCaptureExportMock).not.toHaveBeenCalled();
    expect(useWorkbenchStore.getState().captureExportMessage).toContain("完成当前捕获文件");
  });

  it("按任务和修订过滤迟到导出状态并可取消当前任务", async () => {
    useWorkbenchStore.getState().handleCaptureExportState(
      captureExportState("running", { jobId: 7, revision: 3 }),
    );
    useWorkbenchStore.getState().handleCaptureExportState(
      captureExportState("completed", {
        jobId: 6,
        revision: 99,
        outputBytes: 99_999,
      }),
    );
    useWorkbenchStore.getState().handleCaptureExportState(
      captureExportState("completed", {
        jobId: 7,
        revision: 3,
        outputBytes: 88_888,
      }),
    );
    expect(useWorkbenchStore.getState()).toMatchObject({
      captureExportStatus: "running",
      captureExportJobId: 7,
      captureExportRevision: 3,
      captureExportOutputBytes: 1_024,
    });

    cancelCaptureExportMock.mockResolvedValue(
      captureExportState("cancelling", {
        phase: "reading",
        jobId: 7,
        revision: 4,
      }),
    );
    await expect(useWorkbenchStore.getState().cancelCaptureExport()).resolves.toBe(true);
    expect(cancelCaptureExportMock).toHaveBeenCalledWith(7);
    expect(useWorkbenchStore.getState()).toMatchObject({
      captureExportStatus: "cancelling",
      captureExportRevision: 4,
    });

    useWorkbenchStore.getState().handleCaptureExportState(
      captureExportState("cancelled", { jobId: 7, revision: 5 }),
    );
    expect(useWorkbenchStore.getState().captureExportStatus).toBe("cancelled");
  });

  it("修改已完成任务的导出选项会进入新草稿", () => {
    useWorkbenchStore.getState().handleCaptureExportState(
      captureExportState("completed", {
        jobId: 7,
        revision: 4,
        message: "导出完成",
      }),
    );

    useWorkbenchStore.getState().setCaptureExportDirection("tx");

    expect(useWorkbenchStore.getState()).toMatchObject({
      captureExportStatus: "idle",
      captureExportPhase: "idle",
      captureExportSourcePath: "C:\\captures\\session.vucap",
      captureExportDestinationPath: "",
      captureExportDirection: "tx",
      captureExportOutputBytes: 0,
      captureExportExportedRecords: 0,
      captureExportMessage: "",
    });
  });

  it("取消选择回放文件时保留连接和录制会话", async () => {
    selectReplayFilePathMock.mockResolvedValue(null);
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      connectionStatus: "connected",
      captureStatus: "recording",
      captureSessionId: 12,
    });

    await expect(useWorkbenchStore.getState().openReplayFile()).resolves.toBe(false);

    expect(stopCaptureMock).not.toHaveBeenCalled();
    expect(openReplayMock).not.toHaveBeenCalled();
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "connected",
      captureStatus: "recording",
      captureSessionId: 12,
      replayStatus: "idle",
      runtimeTransitionStatus: "idle",
    });
  });

  it("进入回放文件选择时立即停止周期任务且取消后不恢复", async () => {
    vi.useFakeTimers();
    const selection = deferred<string | null>();
    selectReplayFilePathMock.mockReturnValue(selection.promise);
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "simulator",
      connectionStatus: "connected",
    });
    useWorkbenchStore.getState().startPeriodicSend("PING", "text", "none", 20, null);
    await flushPromises();

    const opening = useWorkbenchStore.getState().openReplayFile();
    expect(useWorkbenchStore.getState().commandTask).toMatchObject({
      status: "stopped",
      sentCount: 1,
    });
    expect(useWorkbenchStore.getState().commandTask.message).toContain("回放流程");

    await vi.advanceTimersByTimeAsync(200);
    expect(useWorkbenchStore.getState().commandTask.sentCount).toBe(1);
    selection.resolve(null);
    await expect(opening).resolves.toBe(false);
    expect(useWorkbenchStore.getState().commandTask.status).toBe("stopped");
  });

  it("选择文件后断开实时数据源但不修改工作区协议", async () => {
    selectReplayFilePathMock.mockResolvedValue("C:\\captures\\session.vucap");
    openReplayMock.mockResolvedValue(replayState("ready"));
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      connectionStatus: "connected",
      protocol: "raw",
    });
    const dirtyBeforeReplay = selectIsWorkspaceDirty(useWorkbenchStore.getState());

    await expect(useWorkbenchStore.getState().openReplayFile()).resolves.toBe(true);

    expect(openReplayMock).toHaveBeenCalledWith("C:\\captures\\session.vucap");
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "disconnected",
      protocol: "raw",
      replayStatus: "ready",
      replaySessionId: 7,
      replayHeader: { protocol: "firewater" },
    });
    expect(selectIsWorkspaceDirty(useWorkbenchStore.getState())).toBe(dirtyBeforeReplay);
  });

  it("文件选择期间拒绝并发连接事务", async () => {
    let resolveSelection: ((path: string | null) => void) | undefined;
    selectReplayFilePathMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSelection = resolve;
        }),
    );
    useWorkbenchStore.setState({ isNativeRuntime: true });

    const opening = useWorkbenchStore.getState().openReplayFile();
    expect(useWorkbenchStore.getState().runtimeTransitionStatus).toBe("selecting-replay");
    await useWorkbenchStore.getState().connect();
    expect(useWorkbenchStore.getState().connectionStatus).toBe("disconnected");

    resolveSelection?.(null);
    await opening;
    expect(useWorkbenchStore.getState().runtimeTransitionStatus).toBe("idle");
  });

  it("回放批次只更新一次状态并保持跨批解析和 TX 解码", async () => {
    playReplayMock.mockResolvedValue(
      replayState("playing", { generation: 1, revision: 2 }),
    );
    useWorkbenchStore.setState({
      protocol: "raw",
      replayStatus: "ready",
      replaySessionId: 7,
      replayGeneration: 0,
      replayRevision: 1,
      replayHeader: TEST_REPLAY_HEADER,
      replayComplete: true,
      replayDurationUs: 50_000,
      terminalEntries: [
        { id: 1, direction: "system", timestamp: 0, text: "旧数据", hex: "", byteCount: 0 },
      ],
    });

    await expect(useWorkbenchStore.getState().playReplay()).resolves.toBe(true);
    expect(playReplayMock).toHaveBeenCalledWith(7, 0);
    expect(ackReplayBatchMock).toHaveBeenCalledWith(7, 1, 0);
    expect(useWorkbenchStore.getState().terminalEntries).toEqual([]);

    const encoder = new TextEncoder();
    const txBytes = encoder.encode("中");
    let updates = 0;
    const unsubscribe = useWorkbenchStore.subscribe(() => {
      updates += 1;
    });
    useWorkbenchStore.getState().handleReplayBatch({
      sessionId: 7,
      generation: 1,
      sequence: 1,
      startUs: 1_000,
      endUs: 1_000,
      dataBytes: 7,
      records: [
        { direction: "rx", timestampUs: 1_000, data: Array.from(encoder.encode("a:1,")) },
        { direction: "tx", timestampUs: 1_000, data: Array.from(txBytes.slice(0, 1)) },
      ],
    });
    expect(updates).toBe(1);

    useWorkbenchStore.getState().handleReplayBatch({
      sessionId: 7,
      generation: 1,
      sequence: 2,
      startUs: 2_000,
      endUs: 2_000,
      dataBytes: 6,
      records: [
        { direction: "rx", timestampUs: 2_000, data: Array.from(encoder.encode("b:2\n")) },
        { direction: "tx", timestampUs: 2_000, data: Array.from(txBytes.slice(1)) },
      ],
    });
    unsubscribe();

    const state = useWorkbenchStore.getState();
    expect(state.protocol).toBe("raw");
    expect(state.channels.map((channel) => channel.lastValue)).toEqual([1, 2]);
    expect(state.stats).toMatchObject({ rxBytes: 8, txBytes: 3, rxFrames: 1 });
    expect(
      state.terminalEntries
        .filter((entry) => entry.direction === "tx")
        .map((entry) => entry.text)
        .join(""),
    ).toBe("中");
    expect(state.terminalEntries.at(-1)?.timestamp).toBe(1_002);
    expect(state.replayNextSequence).toBe(3);
    expect(ackReplayBatchMock.mock.calls).toEqual([
      [7, 1, 0],
      [7, 1, 1],
      [7, 1, 2],
    ]);
    expect(enqueueSimulatorCaptureMock).not.toHaveBeenCalled();
  });

  it("回放 RX 行模式跨 record 和 batch 聚合并保留原始字节", () => {
    const encoder = new TextEncoder();
    const rawHeader: ReplayCaptureHeader = { ...TEST_REPLAY_HEADER, protocol: "raw" };
    const firstLine = encoder.encode("温度\r\n");
    useWorkbenchStore.setState({
      terminalRxRecordMode: "line",
      terminalRxLineEnding: "crlf",
      replayStatus: "playing",
      replaySessionId: 7,
      replayGeneration: 1,
      replayRevision: 1,
      replayHeader: rawHeader,
      replayNextSequence: 1,
    });

    useWorkbenchStore.getState().handleReplayBatch({
      sessionId: 7,
      generation: 1,
      sequence: 1,
      startUs: 1_000,
      endUs: 1_100,
      dataBytes: firstLine.length - 1,
      records: [
        { direction: "rx", timestampUs: 1_000, data: Array.from(firstLine.slice(0, 2)) },
        { direction: "rx", timestampUs: 1_100, data: Array.from(firstLine.slice(2, -1)) },
      ],
    });
    expect(useWorkbenchStore.getState().terminalEntries).toEqual([]);

    useWorkbenchStore.getState().handleReplayBatch({
      sessionId: 7,
      generation: 1,
      sequence: 2,
      startUs: 2_000,
      endUs: 2_100,
      dataBytes: 7,
      records: [
        { direction: "rx", timestampUs: 2_000, data: [0x0a, ...encoder.encode("next\r")] },
        { direction: "rx", timestampUs: 2_100, data: [0x0a] },
      ],
    });

    expect(useWorkbenchStore.getState().terminalEntries).toMatchObject([
      {
        direction: "rx",
        timestamp: 1_001,
        text: "温度\\r\\n",
        hex: "E6 B8 A9 E5 BA A6 0D 0A",
        byteCount: 8,
      },
      {
        direction: "rx",
        timestamp: 1_002,
        text: "next\\r\\n",
        hex: "6E 65 78 74 0D 0A",
        byteCount: 6,
      },
    ]);
  });

  it("切换 RX 记录方式不打断回放 TX 的跨 record UTF-8 解码", () => {
    const txBytes = new TextEncoder().encode("中");
    const rawHeader: ReplayCaptureHeader = { ...TEST_REPLAY_HEADER, protocol: "raw" };
    useWorkbenchStore.setState({
      terminalRxRecordMode: "chunk",
      replayStatus: "playing",
      replaySessionId: 7,
      replayGeneration: 1,
      replayRevision: 1,
      replayHeader: rawHeader,
      replayNextSequence: 1,
    });

    useWorkbenchStore.getState().handleReplayBatch({
      sessionId: 7,
      generation: 1,
      sequence: 1,
      startUs: 1_000,
      endUs: 1_000,
      dataBytes: 1,
      records: [{ direction: "tx", timestampUs: 1_000, data: [txBytes[0]!] }],
    });
    useWorkbenchStore.getState().setTerminalRxRecordMode("line");
    useWorkbenchStore.getState().handleReplayBatch({
      sessionId: 7,
      generation: 1,
      sequence: 2,
      startUs: 2_000,
      endUs: 2_000,
      dataBytes: 2,
      records: [
        { direction: "tx", timestampUs: 2_000, data: Array.from(txBytes.slice(1)) },
      ],
    });

    expect(
      useWorkbenchStore
        .getState()
        .terminalEntries.filter((entry) => entry.direction === "tx")
        .map((entry) => entry.text)
        .join(""),
    ).toBe("中");
  });

  it("回放 seek 时间线修订丢弃旧 RX 行残片", () => {
    const encoder = new TextEncoder();
    const rawHeader: ReplayCaptureHeader = { ...TEST_REPLAY_HEADER, protocol: "raw" };
    useWorkbenchStore.setState({
      terminalRxRecordMode: "line",
      terminalRxLineEnding: "lf",
      replayStatus: "playing",
      replaySessionId: 7,
      replayGeneration: 3,
      replayTimelineRevision: 0,
      replayRevision: 4,
      replayHeader: rawHeader,
      replayNextSequence: 1,
    });
    useWorkbenchStore.getState().handleReplayBatch({
      sessionId: 7,
      generation: 3,
      sequence: 1,
      startUs: 1_000,
      endUs: 1_000,
      dataBytes: 9,
      records: [
        { direction: "rx", timestampUs: 1_000, data: Array.from(encoder.encode("discarded")) },
      ],
    });
    expect(useWorkbenchStore.getState().terminalEntries).toEqual([]);

    useWorkbenchStore.getState().handleReplayState(
      replayState("paused", {
        header: rawHeader,
        generation: 4,
        timelineRevision: 1,
        revision: 5,
        positionUs: 20_000,
      }),
    );
    useWorkbenchStore.setState({ replayStatus: "playing" });
    useWorkbenchStore.getState().handleReplayBatch({
      sessionId: 7,
      generation: 4,
      sequence: 1,
      startUs: 20_000,
      endUs: 20_000,
      dataBytes: 5,
      records: [
        { direction: "rx", timestampUs: 20_000, data: Array.from(encoder.encode("kept\n")) },
      ],
    });

    expect(useWorkbenchStore.getState().terminalEntries).toMatchObject([
      { text: "kept\\n", hex: "6B 65 70 74 0A", byteCount: 5 },
    ]);
  });

  it("回放结束将 RX 行残片标记为未结束且只追加一次", () => {
    const encoder = new TextEncoder();
    const rawHeader: ReplayCaptureHeader = { ...TEST_REPLAY_HEADER, protocol: "raw" };
    useWorkbenchStore.setState({
      terminalRxRecordMode: "line",
      terminalRxLineEnding: "lf",
      replayStatus: "playing",
      replaySessionId: 7,
      replayGeneration: 1,
      replayRevision: 1,
      replayHeader: rawHeader,
      replayNextSequence: 1,
    });
    useWorkbenchStore.getState().handleReplayBatch({
      sessionId: 7,
      generation: 1,
      sequence: 1,
      startUs: 1_000,
      endUs: 1_000,
      dataBytes: 7,
      records: [
        { direction: "rx", timestampUs: 1_000, data: Array.from(encoder.encode("partial")) },
      ],
    });

    useWorkbenchStore.getState().handleReplayState(
      replayState("completed", {
        header: rawHeader,
        generation: 1,
        revision: 2,
        positionUs: 1_000,
      }),
    );
    useWorkbenchStore.getState().handleReplayState(
      replayState("ready", {
        header: rawHeader,
        generation: 2,
        revision: 3,
        positionUs: 0,
      }),
    );

    expect(useWorkbenchStore.getState().terminalEntries).toMatchObject([
      {
        text: "partial",
        hex: "70 61 72 74 69 61 6C",
        byteCount: 7,
        rxBoundary: "unterminated",
      },
    ]);
  });

  it("回放批次生成姿态，时间线修订后立即清空旧样本", () => {
    const attitudeConfig = createDefaultWorkspaceConfig("simulator").attitudeConfig;
    attitudeConfig.channels.roll = "channel-0";
    attitudeConfig.channels.pitch = "channel-1";
    attitudeConfig.channels.yaw = "channel-2";
    useWorkbenchStore.setState({
      attitudeConfig,
      replayStatus: "playing",
      replaySessionId: 7,
      replayGeneration: 1,
      replayTimelineRevision: 0,
      replayRevision: 1,
      replayHeader: TEST_REPLAY_HEADER,
      replayNextSequence: 1,
    });

    useWorkbenchStore.getState().handleReplayBatch({
      sessionId: 7,
      generation: 1,
      sequence: 1,
      startUs: 1_000,
      endUs: 1_000,
      dataBytes: 9,
      records: [
        {
          direction: "rx",
          timestampUs: 1_000,
          data: Array.from(new TextEncoder().encode("7,8,9\n")),
        },
      ],
    });
    expect(useWorkbenchStore.getState().attitudeSample?.sourceValues).toEqual({
      inputMode: "euler",
      roll: 7,
      pitch: 8,
      yaw: 9,
    });

    useWorkbenchStore.getState().handleReplayState(
      replayState("paused", {
        generation: 1,
        timelineRevision: 1,
        revision: 2,
        header: undefined,
      }),
    );

    expect(useWorkbenchStore.getState().attitudeSample).toBeNull();
  });

  it("启动 ACK 失败时停止已经进入 playing 的后端回放", async () => {
    playReplayMock.mockResolvedValue(
      replayState("playing", { generation: 1, revision: 2 }),
    );
    ackReplayBatchMock.mockRejectedValue(new Error("启动 ACK 失败"));
    stopReplayMock.mockResolvedValue(
      replayState("ready", { generation: 2, revision: 4, positionUs: 0 }),
    );
    useWorkbenchStore.setState({
      replayStatus: "ready",
      replaySessionId: 7,
      replayGeneration: 0,
      replayRevision: 1,
      replayHeader: TEST_REPLAY_HEADER,
    });

    await expect(useWorkbenchStore.getState().playReplay()).resolves.toBe(false);

    expect(ackReplayBatchMock).toHaveBeenCalledWith(7, 1, 0);
    expect(stopReplayMock).toHaveBeenCalledWith(7, 1);
    expect(useWorkbenchStore.getState()).toMatchObject({
      replayStatus: "ready",
      replayGeneration: 2,
      replayPositionUs: 0,
      runtimeTransitionStatus: "idle",
    });
    expect(useWorkbenchStore.getState().replayMessage).toContain("已停止回放");
  });

  it("忽略旧会话、旧代次和乱序回放批次", () => {
    useWorkbenchStore.setState({
      replayStatus: "playing",
      replaySessionId: 7,
      replayGeneration: 3,
      replayHeader: TEST_REPLAY_HEADER,
      replayNextSequence: 1,
    });
    const record = {
      direction: "rx" as const,
      timestampUs: 1_000,
      data: Array.from(new TextEncoder().encode("1\n")),
    };

    useWorkbenchStore.getState().handleReplayBatch({
      sessionId: 6,
      generation: 3,
      sequence: 1,
      startUs: 1_000,
      endUs: 1_000,
      dataBytes: 2,
      records: [record],
    });
    useWorkbenchStore.getState().handleReplayBatch({
      sessionId: 7,
      generation: 2,
      sequence: 1,
      startUs: 1_000,
      endUs: 1_000,
      dataBytes: 2,
      records: [record],
    });
    useWorkbenchStore.getState().handleReplayBatch({
      sessionId: 7,
      generation: 3,
      sequence: 2,
      startUs: 1_000,
      endUs: 1_000,
      dataBytes: 2,
      records: [record],
    });

    expect(useWorkbenchStore.getState()).toMatchObject({
      replayNextSequence: 1,
      terminalEntries: [],
      stats: { rxBytes: 0, txBytes: 0, rxFrames: 0 },
    });
    expect(ackReplayBatchMock).not.toHaveBeenCalled();
  });

  it("回放标记只接受当前非空闲会话", () => {
    const markers = [
      { index: 1, timestampUs: 12_000, label: "峰值", color: "red" as const },
    ];
    useWorkbenchStore.setState({
      replayStatus: "ready",
      replaySessionId: 7,
      replayMarkers: markers,
    });

    useWorkbenchStore.getState().handleReplayMarkers({
      sessionId: 6,
      markers: [{ index: 1, timestampUs: 8_000, label: "旧会话", color: "gray" }],
    });
    expect(useWorkbenchStore.getState().replayMarkers).toEqual(markers);

    useWorkbenchStore.getState().handleReplayMarkers({
      sessionId: 7,
      markers: [{ index: 1, timestampUs: 15_000, label: "稳定", color: "green" }],
    });
    expect(useWorkbenchStore.getState().replayMarkers).toMatchObject([
      { timestampUs: 15_000, label: "稳定", color: "green" },
    ]);

    useWorkbenchStore.setState({ replayStatus: "idle" });
    useWorkbenchStore.getState().handleReplayMarkers({ sessionId: 7, markers: [] });
    expect(useWorkbenchStore.getState().replayMarkers).toHaveLength(1);
  });

  it("定位和停止保留标记，换文件与关闭时清空", async () => {
    const rawHeader: ReplayCaptureHeader = { ...TEST_REPLAY_HEADER, protocol: "raw" };
    const markers = [
      { index: 1, timestampUs: 12_000, label: "观察点", color: "blue" as const },
    ];
    seekReplayMock.mockResolvedValue(
      replayState("seeking", {
        header: rawHeader,
        generation: 4,
        revision: 5,
        positionUs: 30_000,
        markerCount: 1,
      }),
    );
    stopReplayMock.mockResolvedValue(
      replayState("ready", {
        header: rawHeader,
        generation: 5,
        timelineRevision: 2,
        revision: 7,
        markerCount: 1,
      }),
    );
    useWorkbenchStore.setState({
      replayStatus: "paused",
      replaySessionId: 7,
      replayGeneration: 3,
      replayTimelineRevision: 0,
      replayRevision: 4,
      replayHeader: rawHeader,
      replayDurationUs: 50_000,
      replayMarkers: markers,
    });

    await expect(useWorkbenchStore.getState().seekReplay(30_000)).resolves.toBe(true);
    expect(useWorkbenchStore.getState().replayMarkers).toEqual(markers);

    useWorkbenchStore.getState().handleReplayState(
      replayState("playing", {
        header: rawHeader,
        generation: 4,
        timelineRevision: 1,
        revision: 6,
        positionUs: 30_000,
        markerCount: 1,
      }),
    );
    await expect(useWorkbenchStore.getState().stopReplay()).resolves.toBe(true);
    expect(useWorkbenchStore.getState().replayMarkers).toEqual(markers);

    useWorkbenchStore.getState().handleReplayState(
      replayState("loading", {
        sessionId: 8,
        revision: 8,
        path: "C:\\captures\\next.vucap",
        markerCount: 0,
      }),
    );
    expect(useWorkbenchStore.getState().replayMarkers).toEqual([]);

    useWorkbenchStore.getState().handleReplayMarkers({
      sessionId: 8,
      markers: [{ index: 1, timestampUs: 1_000, label: "新文件", color: "purple" }],
    });
    useWorkbenchStore.getState().handleReplayState(
      replayState("idle", {
        sessionId: 8,
        revision: 9,
        path: "",
        header: undefined,
        formatVersion: 0,
        complete: false,
        durationUs: 0,
        dataBytes: 0,
        recordCount: 0,
        markerCount: 0,
      }),
    );
    expect(useWorkbenchStore.getState().replayMarkers).toEqual([]);
  });

  it("暂停保留画面而停止回放会清空旧时间线并回到文件起点", async () => {
    pauseReplayMock.mockResolvedValue(
      replayState("paused", { generation: 3, revision: 3, positionUs: 20_000 }),
    );
    stopReplayMock.mockResolvedValue(
      replayState("ready", {
        generation: 4,
        timelineRevision: 1,
        revision: 5,
        positionUs: 0,
      }),
    );
    useWorkbenchStore.setState({
      replayStatus: "playing",
      replaySessionId: 7,
      replayGeneration: 2,
      replayRevision: 2,
      replayHeader: TEST_REPLAY_HEADER,
      replayPositionUs: 20_000,
      terminalEntries: [
        { id: 4, direction: "rx", timestamp: 1_020, text: "1", hex: "31", byteCount: 1 },
      ],
    });

    await expect(useWorkbenchStore.getState().pauseReplay()).resolves.toBe(true);
    expect(useWorkbenchStore.getState().terminalEntries).toMatchObject([{ text: "1" }]);
    await expect(useWorkbenchStore.getState().stopReplay()).resolves.toBe(true);

    expect(pauseReplayMock).toHaveBeenCalledWith(7, 2);
    expect(stopReplayMock).toHaveBeenCalledWith(7, 3);
    expect(useWorkbenchStore.getState()).toMatchObject({
      replayStatus: "ready",
      replayPositionUs: 0,
      terminalEntries: [],
      channels: [],
      stats: { rxBytes: 0, txBytes: 0, rxFrames: 0 },
    });
  });

  it("Raw 回放定位只提交一次并在时间线切换完成后清空旧画面", async () => {
    const rawHeader: ReplayCaptureHeader = { ...TEST_REPLAY_HEADER, protocol: "raw" };
    seekReplayMock.mockResolvedValue(
      replayState("seeking", {
        header: rawHeader,
        generation: 4,
        timelineRevision: 0,
        revision: 5,
        positionUs: 20_000,
      }),
    );
    useWorkbenchStore.setState({
      replayStatus: "paused",
      replaySessionId: 7,
      replayGeneration: 3,
      replayTimelineRevision: 0,
      replayRevision: 4,
      replayHeader: rawHeader,
      replayPositionUs: 20_000,
      replayDurationUs: 50_000,
      replayNextSequence: 8,
      terminalEntries: [
        { id: 4, direction: "rx", timestamp: 1_020, text: "旧画面", hex: "", byteCount: 3 },
      ],
      stats: { rxBytes: 3, txBytes: 0, rxFrames: 1 },
    });

    await expect(useWorkbenchStore.getState().seekReplay(35_000)).resolves.toBe(true);
    expect(seekReplayMock).toHaveBeenCalledWith(7, 3, 35_000);
    expect(useWorkbenchStore.getState()).toMatchObject({
      replayStatus: "seeking",
      replayGeneration: 4,
      replayNextSequence: 1,
      terminalEntries: [{ text: "旧画面" }],
    });

    useWorkbenchStore.getState().handleReplayState(
      replayState("paused", {
        header: rawHeader,
        generation: 4,
        timelineRevision: 1,
        revision: 6,
        positionUs: 35_000,
      }),
    );

    expect(useWorkbenchStore.getState()).toMatchObject({
      replayStatus: "paused",
      replayTimelineRevision: 1,
      replayPositionUs: 35_000,
      replayNextSequence: 1,
      terminalEntries: [],
      channels: [],
      stats: { rxBytes: 0, txBytes: 0, rxFrames: 0 },
    });
  });

  it("结构化协议定位接收后端吸附位置，播放中仍拒绝定位", async () => {
    seekReplayMock.mockResolvedValue(
      replayState("seeking", {
        generation: 4,
        revision: 5,
      }),
    );
    useWorkbenchStore.setState({
      replayStatus: "paused",
      replaySessionId: 7,
      replayGeneration: 3,
      replayRevision: 4,
      replayHeader: TEST_REPLAY_HEADER,
      replayDurationUs: 50_000,
    });
    await expect(useWorkbenchStore.getState().seekReplay(10_000)).resolves.toBe(true);
    expect(seekReplayMock).toHaveBeenCalledWith(7, 3, 10_000);

    useWorkbenchStore.getState().handleReplayState(
      replayState("paused", {
        generation: 4,
        timelineRevision: 1,
        revision: 6,
        positionUs: 12_000,
      }),
    );
    expect(useWorkbenchStore.getState()).toMatchObject({
      replayStatus: "paused",
      replayPositionUs: 12_000,
      replayTimelineRevision: 1,
    });

    useWorkbenchStore.setState({
      replayStatus: "playing",
      replayHeader: { ...TEST_REPLAY_HEADER, protocol: "raw" },
    });
    await expect(useWorkbenchStore.getState().seekReplay(10_000)).resolves.toBe(false);
    expect(seekReplayMock).toHaveBeenCalledOnce();
  });

  it("播放中切换倍速保留代次、时间线和待接收批次", async () => {
    setReplaySpeedMock.mockResolvedValue(
      replayState("playing", {
        generation: 3,
        timelineRevision: 2,
        revision: 5,
        speed: 2,
        positionUs: 20_000,
      }),
    );
    useWorkbenchStore.setState({
      replayStatus: "playing",
      replaySessionId: 7,
      replayGeneration: 3,
      replayTimelineRevision: 2,
      replayRevision: 4,
      replayHeader: TEST_REPLAY_HEADER,
      replaySpeed: 1,
      replayPositionUs: 20_000,
      replayNextSequence: 4,
    });

    await expect(useWorkbenchStore.getState().setReplaySpeed(2)).resolves.toBe(true);

    expect(setReplaySpeedMock).toHaveBeenCalledWith(7, 3, 2);
    expect(useWorkbenchStore.getState()).toMatchObject({
      replayStatus: "playing",
      replayGeneration: 3,
      replayTimelineRevision: 2,
      replayRevision: 5,
      replaySpeed: 2,
      replayNextSequence: 4,
      runtimeTransitionStatus: "idle",
    });

    await expect(useWorkbenchStore.getState().setReplaySpeed(2)).resolves.toBe(true);
    expect(setReplaySpeedMock).toHaveBeenCalledOnce();
  });

  it("控制命令在途时忽略旧代次批次", () => {
    const record = {
      direction: "rx" as const,
      timestampUs: 1_000,
      data: Array.from(new TextEncoder().encode("1\n")),
    };

    for (const replayStatus of ["pausing", "seeking", "stopping", "closing"] as const) {
      useWorkbenchStore.setState({
        replayStatus,
        replaySessionId: 7,
        replayGeneration: 3,
        replayHeader: TEST_REPLAY_HEADER,
        replayNextSequence: 1,
        terminalEntries: [],
      });
      useWorkbenchStore.getState().handleReplayBatch({
        sessionId: 7,
        generation: 3,
        sequence: 1,
        startUs: 1_000,
        endUs: 1_000,
        dataBytes: 2,
        records: [record],
      });
      expect(useWorkbenchStore.getState().terminalEntries).toEqual([]);
    }

    expect(ackReplayBatchMock).not.toHaveBeenCalled();
  });

  it("暂停命令在途时拒绝迟到的 playing 状态与旧批次", async () => {
    let resolvePause: ((payload: ReplayStatePayload) => void) | undefined;
    pauseReplayMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePause = resolve;
        }),
    );
    useWorkbenchStore.setState({
      replayStatus: "playing",
      replaySessionId: 7,
      replayGeneration: 3,
      replayRevision: 4,
      replayHeader: TEST_REPLAY_HEADER,
      replayNextSequence: 1,
    });

    const pausing = useWorkbenchStore.getState().pauseReplay();
    useWorkbenchStore.getState().handleReplayState(
      replayState("playing", { generation: 3, revision: 5, positionUs: 500 }),
    );
    useWorkbenchStore.getState().handleReplayBatch({
      sessionId: 7,
      generation: 3,
      sequence: 1,
      startUs: 1_000,
      endUs: 1_000,
      dataBytes: 2,
      records: [
        {
          direction: "rx",
          timestampUs: 1_000,
          data: Array.from(new TextEncoder().encode("1\n")),
        },
      ],
    });

    expect(useWorkbenchStore.getState()).toMatchObject({
      replayStatus: "pausing",
      replayRevision: 4,
      terminalEntries: [],
    });
    expect(ackReplayBatchMock).not.toHaveBeenCalled();

    resolvePause?.(
      replayState("paused", { generation: 4, revision: 6, positionUs: 0 }),
    );
    await expect(pausing).resolves.toBe(true);
    expect(useWorkbenchStore.getState()).toMatchObject({
      replayStatus: "paused",
      replayGeneration: 4,
      replayRevision: 6,
    });
  });

  it("迟到的 ACK 失败不会覆盖已经换代的暂停状态", async () => {
    let rejectAck: ((error: Error) => void) | undefined;
    ackReplayBatchMock.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectAck = reject;
        }),
    );
    pauseReplayMock.mockResolvedValue(
      replayState("paused", { generation: 4, revision: 5, positionUs: 1_000 }),
    );
    useWorkbenchStore.setState({
      replayStatus: "playing",
      replaySessionId: 7,
      replayGeneration: 3,
      replayRevision: 4,
      replayHeader: TEST_REPLAY_HEADER,
      replayNextSequence: 1,
    });

    useWorkbenchStore.getState().handleReplayBatch({
      sessionId: 7,
      generation: 3,
      sequence: 1,
      startUs: 1_000,
      endUs: 1_000,
      dataBytes: 2,
      records: [
        {
          direction: "rx",
          timestampUs: 1_000,
          data: Array.from(new TextEncoder().encode("1\n")),
        },
      ],
    });
    await expect(useWorkbenchStore.getState().pauseReplay()).resolves.toBe(true);
    rejectAck?.(new Error("IPC 已断开"));
    await Promise.resolve();

    expect(useWorkbenchStore.getState()).toMatchObject({
      replayStatus: "paused",
      replayGeneration: 4,
    });
    expect(stopReplayMock).not.toHaveBeenCalled();
  });

  it("当前代次 ACK 失败时主动停止回放并解除屏障", async () => {
    ackReplayBatchMock.mockRejectedValue(new Error("ACK 队列已满"));
    stopReplayMock.mockResolvedValue(
      replayState("ready", { generation: 4, revision: 5, positionUs: 0 }),
    );
    useWorkbenchStore.setState({
      replayStatus: "playing",
      replaySessionId: 7,
      replayGeneration: 3,
      replayRevision: 4,
      replayHeader: TEST_REPLAY_HEADER,
      replayNextSequence: 1,
    });

    useWorkbenchStore.getState().handleReplayBatch({
      sessionId: 7,
      generation: 3,
      sequence: 1,
      startUs: 1_000,
      endUs: 1_000,
      dataBytes: 2,
      records: [
        {
          direction: "rx",
          timestampUs: 1_000,
          data: Array.from(new TextEncoder().encode("1\n")),
        },
      ],
    });

    await vi.waitFor(() => expect(stopReplayMock).toHaveBeenCalledWith(7, 3));
    expect(useWorkbenchStore.getState()).toMatchObject({
      replayStatus: "ready",
      replayGeneration: 4,
      replayPositionUs: 0,
      runtimeTransitionStatus: "idle",
    });
    expect(useWorkbenchStore.getState().replayMessage).toContain("已停止回放");
  });

  it("同一播放代次的迟到状态事件不会倒拨进度", () => {
    useWorkbenchStore.setState({
      replayStatus: "playing",
      replaySessionId: 7,
      replayGeneration: 2,
      replayRevision: 4,
      replayHeader: TEST_REPLAY_HEADER,
      replayPositionUs: 20_000,
    });

    useWorkbenchStore.getState().handleReplayState(
      replayState("playing", {
        generation: 2,
        revision: 5,
        positionUs: 10_000,
      }),
    );

    expect(useWorkbenchStore.getState()).toMatchObject({
      replayRevision: 5,
      replayPositionUs: 20_000,
    });
  });

  it("从回放连接实时数据源前清空旧回放画面", async () => {
    closeReplayMock.mockResolvedValue(
      replayState("idle", {
        generation: 3,
        revision: 5,
        path: "",
        header: undefined,
        complete: false,
        durationUs: 0,
        dataBytes: 0,
        recordCount: 0,
      }),
    );
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      replayStatus: "ready",
      replaySessionId: 7,
      replayGeneration: 2,
      replayRevision: 4,
      replayHeader: TEST_REPLAY_HEADER,
      channels: [
        {
          id: "channel-0",
          name: "CH 1",
          color: "#46d89c",
          visible: true,
          points: [{ x: 1, y: 2 }],
          lastValue: 2,
        },
      ],
      terminalEntries: [
        { id: 9, direction: "rx", timestamp: 1_000, text: "旧回放", hex: "", byteCount: 6 },
      ],
      stats: { rxBytes: 6, txBytes: 0, rxFrames: 1 },
    });

    await useWorkbenchStore.getState().connect();

    expect(closeReplayMock).toHaveBeenCalledWith(7);
    expect(useWorkbenchStore.getState()).toMatchObject({
      replayStatus: "idle",
      connectionStatus: "connected",
      channels: [],
      terminalEntries: [],
      stats: { rxBytes: 0, txBytes: 0, rxFrames: 0 },
    });
  });

  it("切换工作区前关闭回放会话", async () => {
    const target = createWorkspaceProfile(
      "回放后工作区",
      createDefaultWorkspaceConfig("simulator"),
      "after-replay",
      300,
    );
    closeReplayMock.mockResolvedValue(
      replayState("idle", {
        sessionId: 7,
        revision: 3,
        path: "",
        header: undefined,
        complete: false,
        durationUs: 0,
        dataBytes: 0,
        recordCount: 0,
      }),
    );
    useWorkbenchStore.setState((state) => ({
      isNativeRuntime: true,
      workspaces: [...state.workspaces, target],
      replayStatus: "ready",
      replaySessionId: 7,
      replayRevision: 2,
      replayHeader: TEST_REPLAY_HEADER,
    }));

    await expect(useWorkbenchStore.getState().switchWorkspace(target.id)).resolves.toBe(true);
    expect(closeReplayMock).toHaveBeenCalledWith(7);
    expect(useWorkbenchStore.getState()).toMatchObject({
      activeWorkspaceId: target.id,
      replayStatus: "idle",
      connectionStatus: "disconnected",
    });
  });

  it("仅运行数据变化时不重复写入持久化存储", () => {
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    storageWrite.mockClear();

    useWorkbenchStore.getState().ingestBytes(new TextEncoder().encode("1,2\n"), 1_000);

    expect(storageWrite).not.toHaveBeenCalled();
    storageWrite.mockRestore();
  });

  it("命令历史与任务状态不会写入持久化存储", async () => {
    useWorkbenchStore.setState({
      source: "simulator",
      connectionStatus: "connected",
    });
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    storageWrite.mockClear();

    await useWorkbenchStore.getState().send("PRIVATE", "text", "none");

    expect(useWorkbenchStore.getState().commandHistory).toHaveLength(1);
    expect(storageWrite).not.toHaveBeenCalled();
    storageWrite.mockRestore();
  });

  it("只持久化自动应答规则，不持久化启用态和运行计数", async () => {
    useWorkbenchStore.setState({
      source: "simulator",
      connectionStatus: "connected",
    });
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    storageWrite.mockClear();
    useWorkbenchStore.getState().setAutoResponderRules([
      createDefaultAutoResponderRule("line-ready"),
    ]);
    expect(storageWrite).toHaveBeenCalled();
    storageWrite.mockClear();

    useWorkbenchStore.getState().startAutoResponder();
    useWorkbenchStore.getState().ingestBytes(
      Uint8Array.from([0x0a]),
      Date.now(),
    );
    await flushPromises();

    expect(useWorkbenchStore.getState().autoResponder.sentCount).toBe(1);
    expect(storageWrite).not.toHaveBeenCalled();
    storageWrite.mockRestore();
  });
});
