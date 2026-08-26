import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CaptureExportRequest,
  CaptureExportStatePayload,
} from "../types/captureExport";
import {
  cancelCaptureExport,
  clearCaptureExport,
  getCaptureExportState,
  selectCaptureExportDestinationPath,
  selectCaptureExportSourcePath,
  startCaptureExport,
  subscribeToCaptureExportEvents,
} from "./captureExportClient";

const { invokeMock, listenMock, openDialogMock, saveDialogMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  openDialogMock: vi.fn(),
  saveDialogMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: openDialogMock,
  save: saveDialogMock,
}));

const request: CaptureExportRequest = {
  sourcePath: "C:\\captures\\session.vucap",
  destinationPath: "C:\\captures\\session.csv",
  format: "csv",
  direction: "both",
  allowIncomplete: false,
};

const statePayload: CaptureExportStatePayload = {
  ...request,
  status: "running",
  phase: "reading",
  jobId: 7,
  revision: 3,
  totalInputBytes: 4_096,
  processedInputBytes: 1_024,
  processedDataBytes: 768,
  processedRecords: 12,
  exportedDataBytes: 768,
  exportedRecords: 12,
  outputBytes: 2_048,
  sourceComplete: false,
  startedAtUnixMs: 1_000,
};

const idleStatePayload: CaptureExportStatePayload = {
  status: "idle",
  phase: "idle",
  jobId: 0,
  revision: 0,
  sourcePath: "",
  destinationPath: "",
  format: "csv",
  direction: "both",
  allowIncomplete: false,
  totalInputBytes: 0,
  processedInputBytes: 0,
  processedDataBytes: 0,
  processedRecords: 0,
  exportedDataBytes: 0,
  exportedRecords: 0,
  outputBytes: 0,
  sourceComplete: false,
};

describe("captureExportClient", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    openDialogMock.mockReset();
    saveDialogMock.mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  it("仅通过原生对话框选择 vucap 源文件", async () => {
    openDialogMock.mockResolvedValue("C:\\captures\\session.vucap");

    await expect(selectCaptureExportSourcePath()).resolves.toBe(
      "C:\\captures\\session.vucap",
    );
    expect(openDialogMock).toHaveBeenCalledWith({
      directory: false,
      multiple: false,
      filters: [{ name: "Vofa-Ultra 捕获文件", extensions: ["vucap"] }],
    });

    openDialogMock.mockResolvedValue(null);
    await expect(selectCaptureExportSourcePath()).resolves.toBeNull();
  });

  it("按格式和源文件路径生成保存对话框默认值", async () => {
    saveDialogMock.mockResolvedValueOnce("C:\\captures\\session.csv");
    saveDialogMock.mockResolvedValueOnce("/tmp/session.jsonl");
    saveDialogMock.mockResolvedValueOnce("capture.bin");

    await expect(
      selectCaptureExportDestinationPath("C:\\captures\\session.VUCAP", "csv"),
    ).resolves.toBe("C:\\captures\\session.csv");
    await expect(
      selectCaptureExportDestinationPath("/tmp/session.vucap", "jsonl"),
    ).resolves.toBe("/tmp/session.jsonl");
    await expect(selectCaptureExportDestinationPath("capture", "binary")).resolves.toBe(
      "capture.bin",
    );

    expect(saveDialogMock.mock.calls).toEqual([
      [
        {
          title: "导出捕获文件",
          defaultPath: "C:\\captures\\session.csv",
          filters: [{ name: "CSV 数据文件", extensions: ["csv"] }],
        },
      ],
      [
        {
          title: "导出捕获文件",
          defaultPath: "/tmp/session.jsonl",
          filters: [{ name: "JSON Lines 数据文件", extensions: ["jsonl"] }],
        },
      ],
      [
        {
          title: "导出捕获文件",
          defaultPath: "capture.bin",
          filters: [{ name: "原始二进制文件", extensions: ["bin"] }],
        },
      ],
    ]);
  });

  it("导出命令始终携带请求或任务标识", async () => {
    invokeMock.mockResolvedValueOnce(statePayload);
    invokeMock.mockResolvedValueOnce(statePayload);
    invokeMock.mockResolvedValueOnce(idleStatePayload);
    invokeMock.mockResolvedValueOnce(idleStatePayload);

    await startCaptureExport(request);
    await cancelCaptureExport(7);
    await clearCaptureExport();
    await getCaptureExportState();

    expect(invokeMock.mock.calls).toEqual([
      ["start_capture_export", { request }],
      ["cancel_capture_export", { jobId: 7 }],
      ["clear_capture_export"],
      ["get_capture_export_state"],
    ]);
  });

  it("订阅导出状态事件并释放监听", async () => {
    let callback: ((event: { payload: CaptureExportStatePayload }) => void) | undefined;
    const dispose = vi.fn();
    listenMock.mockImplementation(
      (event: string, handler: (event: { payload: CaptureExportStatePayload }) => void) => {
        expect(event).toBe("capture-export://state");
        callback = handler;
        return Promise.resolve(dispose);
      },
    );
    const onState = vi.fn();

    const unlisten = await subscribeToCaptureExportEvents({ onState });
    callback?.({ payload: statePayload });
    unlisten();

    expect(onState).toHaveBeenCalledWith(statePayload);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("浏览器预览明确拒绝文件选择和导出命令", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");

    await expect(selectCaptureExportSourcePath()).rejects.toThrow("浏览器预览不支持捕获文件导出");
    await expect(
      selectCaptureExportDestinationPath("capture.vucap", "csv"),
    ).rejects.toThrow("浏览器预览不支持捕获文件导出");
    await expect(startCaptureExport(request)).rejects.toThrow("浏览器预览不支持捕获文件导出");
    expect(openDialogMock).not.toHaveBeenCalled();
    expect(saveDialogMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();

    const unlisten = await subscribeToCaptureExportEvents({ onState: vi.fn() });
    unlisten();
    expect(listenMock).not.toHaveBeenCalled();
  });
});
