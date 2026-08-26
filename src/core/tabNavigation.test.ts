import { describe, expect, it } from "vitest";
import { getHorizontalTabTarget } from "./tabNavigation";

const TABS = ["first", "second", "third"] as const;

describe("getHorizontalTabTarget", () => {
  it("使用左右方向键循环移动", () => {
    expect(getHorizontalTabTarget(TABS, "first", "ArrowRight")).toBe("second");
    expect(getHorizontalTabTarget(TABS, "third", "ArrowRight")).toBe("first");
    expect(getHorizontalTabTarget(TABS, "first", "ArrowLeft")).toBe("third");
    expect(getHorizontalTabTarget(TABS, "third", "ArrowLeft")).toBe("second");
  });

  it("使用 Home 和 End 跳转到边界", () => {
    expect(getHorizontalTabTarget(TABS, "second", "Home")).toBe("first");
    expect(getHorizontalTabTarget(TABS, "second", "End")).toBe("third");
  });

  it("忽略无关按键、空集合和未知当前项", () => {
    expect(getHorizontalTabTarget(TABS, "first", "Enter")).toBeUndefined();
    expect(getHorizontalTabTarget([], "first", "ArrowRight")).toBeUndefined();
    expect(
      getHorizontalTabTarget(TABS as readonly string[], "missing", "ArrowRight"),
    ).toBeUndefined();
  });
});
