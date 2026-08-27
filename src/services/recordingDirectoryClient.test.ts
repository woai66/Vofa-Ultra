import { beforeEach, describe, expect, it, vi } from "vitest";
import { selectRecordingDirectoryPath } from "./recordingDirectoryClient";

const { openDialogMock } = vi.hoisted(() => ({
  openDialogMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialogMock }));

describe("recordingDirectoryClient", () => {
  beforeEach(() => {
    openDialogMock.mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  it("只通过原生目录选择器取得单个文件夹", async () => {
    openDialogMock.mockResolvedValueOnce("C:\\captures").mockResolvedValueOnce(null);

    await expect(selectRecordingDirectoryPath()).resolves.toBe("C:\\captures");
    await expect(selectRecordingDirectoryPath()).resolves.toBeNull();
    expect(openDialogMock).toHaveBeenCalledWith({
      title: "选择记录目录",
      directory: true,
      multiple: false,
    });
  });

  it("忽略目录模式不应返回的多选结果", async () => {
    openDialogMock.mockResolvedValue(["C:\\captures"]);

    await expect(selectRecordingDirectoryPath()).resolves.toBeNull();
  });

  it("浏览器预览明确拒绝目录选择", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");

    await expect(selectRecordingDirectoryPath()).rejects.toThrow(
      "浏览器预览不支持选择记录目录",
    );
    expect(openDialogMock).not.toHaveBeenCalled();
  });
});
