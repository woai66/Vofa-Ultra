import { describe, expect, it } from "vitest";
import {
  APP_BUILD_ID,
  APP_DISPLAY_BUILD_ID,
  APP_DISPLAY_VERSION,
  APP_VERSION,
} from "./appMetadata";

describe("应用元数据", () => {
  it("公开构建注入的 SemVer 与显示版本", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
    expect(APP_DISPLAY_VERSION).toBe(`v${APP_VERSION}`);
    expect(APP_BUILD_ID).toMatch(/^(?:[0-9a-f]{7,12}(?:-dirty)?|development)$/);
    expect(APP_DISPLAY_BUILD_ID).toBe(
      APP_BUILD_ID === "development"
        ? APP_BUILD_ID
        : `${APP_BUILD_ID.slice(0, 7)}${APP_BUILD_ID.endsWith("-dirty") ? "-dirty" : ""}`,
    );
  });
});
