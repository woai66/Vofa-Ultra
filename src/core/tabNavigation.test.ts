import { describe, expect, it } from "vitest";
import { getHorizontalTabTarget, getVerticalNavigationTarget } from "./tabNavigation";

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

describe("getVerticalNavigationTarget", () => {
  it("使用上下方向键循环移动", () => {
    expect(getVerticalNavigationTarget(TABS, "first", "ArrowDown")).toBe("second");
    expect(getVerticalNavigationTarget(TABS, "third", "ArrowDown")).toBe("first");
    expect(getVerticalNavigationTarget(TABS, "first", "ArrowUp")).toBe("third");
    expect(getVerticalNavigationTarget(TABS, "third", "ArrowUp")).toBe("second");
  });

  it("支持边界跳转并忽略无关输入", () => {
    expect(getVerticalNavigationTarget(TABS, "second", "Home")).toBe("first");
    expect(getVerticalNavigationTarget(TABS, "second", "End")).toBe("third");
    expect(getVerticalNavigationTarget(TABS, "first", "Enter")).toBeUndefined();
    expect(getVerticalNavigationTarget([], "first", "ArrowDown")).toBeUndefined();
  });
});
