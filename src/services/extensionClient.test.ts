import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateExtension,
  deactivateExtension,
  getExtensionState,
  inspectExtension,
  pushExtensionBatch,
  resetExtension,
  selectExtensionPackagePath,
} from "./extensionClient";

const { invokeMock, openDialogMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  openDialogMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialogMock }));

describe("extensionClient", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue({ status: "idle" });
    openDialogMock.mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  it("仅通过原生对话框选择 vux 扩展包", async () => {
    openDialogMock.mockResolvedValue("C:\\extensions\\parser.vux");
    await expect(selectExtensionPackagePath()).resolves.toBe("C:\\extensions\\parser.vux");
    expect(openDialogMock).toHaveBeenCalledWith({
      directory: false,
      multiple: false,
      filters: [{ name: "Vofa-Ultra 扩展包", extensions: ["vux"] }],
    });
  });

  it("所有运行命令携带哈希、授权和会话边界", async () => {
    await inspectExtension("C:\\extensions\\parser.vux");
    await activateExtension("C:\\extensions\\parser.vux", "a".repeat(64), ["live-rx.read"]);
    await getExtensionState();
    await resetExtension(7, 3);
    await pushExtensionBatch(7, 4, 1, 1_000, Uint8Array.of(1, 2, 3));
    await deactivateExtension(7);

    expect(invokeMock.mock.calls).toEqual([
      ["inspect_extension", { path: "C:\\extensions\\parser.vux" }],
      [
        "activate_extension",
        {
          path: "C:\\extensions\\parser.vux",
          expectedPackageSha256: "a".repeat(64),
          authorizedCapabilities: ["live-rx.read"],
        },
      ],
      ["get_extension_state"],
      ["reset_extension", { sessionId: 7, generation: 3 }],
      [
        "push_extension_batch",
        {
          sessionId: 7,
          generation: 4,
          sequence: 1,
          receivedAt: 1_000,
          data: [1, 2, 3],
        },
      ],
      ["deactivate_extension", { sessionId: 7 }],
    ]);
  });
});
