import { describe, expect, it } from "vitest";
import type { ChannelSeries } from "../types/workbench";
import type { ChannelPresentations } from "../types/workspace";
import {
  areChannelPresentationsEqual,
  cloneChannelPresentations,
  createDefaultChannelPresentations,
  getChannelPresentationOverride,
  normalizeChannelPresentationOverride,
  parseChannelPresentations,
  presentChannelSeries,
  updateChannelPresentation,
} from "./channelPresentation";

const CHANNEL: ChannelSeries = {
  id: "channel-0",
  name: "CH 0",
  color: "#123456",
  visible: true,
  points: [{ x: 1, y: 2 }],
  lastValue: 2,
};

describe("通道展示配置", () => {
  it("创建协议隔离的空配置", () => {
    const presentations = createDefaultChannelPresentations();

    expect(presentations).toEqual({ firewater: {}, justfloat: {} });
    expect(presentations.firewater).not.toBe(presentations.justfloat);
  });

  it("严格解析并规范化别名、单位和颜色", () => {
    const parsed = parseChannelPresentations({
      firewater: {
        "channel-0": { alias: "  温度  ", unit: "  degC ", color: "#A1B2C3" },
        "channel-1": { alias: " ", unit: "", color: null },
      },
      justfloat: {
        "channel-15": { alias: "电压", unit: "V", color: null },
      },
    });

    expect(parsed).toEqual({
      firewater: {
        "channel-0": { alias: "温度", unit: "degC", color: "#a1b2c3" },
      },
      justfloat: {
        "channel-15": { alias: "电压", unit: "V", color: null },
      },
    });
  });

  it.each([
    [{ firewater: {} }, /缺少字段/],
    [{ firewater: {}, justfloat: {}, raw: {} }, /未知字段/],
    [{ firewater: [], justfloat: {} }, /必须是对象/],
    [
      {
        firewater: {
          "derived:value": { alias: "结果", unit: "", color: null },
        },
        justfloat: {},
      },
      /不支持通道/,
    ],
    [
      {
        firewater: {
          "channel-16": { alias: "越界", unit: "", color: null },
        },
        justfloat: {},
      },
      /不支持通道/,
    ],
    [
      {
        firewater: {
          "channel-0": { alias: "名称", unit: "", color: null, script: "run()" },
        },
        justfloat: {},
      },
      /未知字段/,
    ],
    [
      {
        firewater: {
          "channel-0": { alias: "名称", unit: "" },
        },
        justfloat: {},
      },
      /缺少字段/,
    ],
  ] as const)("拒绝不符合严格 schema 的配置 %#", (value, expected) => {
    expect(() => parseChannelPresentations(value)).toThrow(expected);
  });

  it("限制每个协议的覆盖项数量", () => {
    const firewater = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [
        `channel-${index}`,
        { alias: "", unit: "V", color: null },
      ]),
    );

    expect(() => parseChannelPresentations({ firewater, justfloat: {} })).toThrow(/最多包含 16 项/);
  });

  it.each([
    [{ alias: `A${"x".repeat(64)}`, unit: "", color: null }, /不能超过 64 个字符/],
    [{ alias: "名称\u0000", unit: "", color: null }, /控制字符/],
    [{ alias: "名称\n", unit: "", color: null }, /控制字符/],
    [{ alias: "", unit: "测".repeat(24), color: null }, /不能超过 64 字节/],
    [{ alias: "", unit: "u".repeat(25), color: null }, /不能超过 24 个字符/],
    [{ alias: "", unit: "", color: "red" }, /#RRGGBB/],
    [{ alias: "", unit: "", color: "#12345g" }, /#RRGGBB/],
  ] as const)("拒绝越界覆盖 %#", (value, expected) => {
    expect(() => normalizeChannelPresentationOverride(value)).toThrow(expected);
  });

  it("空覆盖归一化为 null", () => {
    expect(
      normalizeChannelPresentationOverride({ alias: "  ", unit: "", color: null }),
    ).toBeNull();
  });

  it("不可变更新单个协议并在恢复默认时删除条目", () => {
    const initial = createDefaultChannelPresentations();
    const updated = updateChannelPresentation(initial, "firewater", "channel-0", {
      alias: "温度",
      unit: "degC",
      color: "#ABCDEF",
    });

    expect(updated).not.toBe(initial);
    expect(updated.firewater).not.toBe(initial.firewater);
    expect(updated.justfloat).toBe(initial.justfloat);
    expect(updated.firewater["channel-0"]).toEqual({
      alias: "温度",
      unit: "degC",
      color: "#abcdef",
    });
    expect(
      updateChannelPresentation(updated, "firewater", "channel-0", {
        alias: "温度",
        unit: "degC",
        color: "#ABCDEF",
      }),
    ).toBe(updated);

    const reset = updateChannelPresentation(updated, "firewater", "channel-0", null);
    expect(reset).toEqual(initial);
    expect(updateChannelPresentation(reset, "firewater", "channel-0", null)).toBe(reset);
  });

  it("深克隆并按内容比较，忽略通道键顺序", () => {
    const left = parseChannelPresentations({
      firewater: {
        "channel-1": { alias: "B", unit: "V", color: null },
        "channel-0": { alias: "A", unit: "A", color: "#123456" },
      },
      justfloat: {},
    });
    const right = parseChannelPresentations({
      firewater: {
        "channel-0": { alias: "A", unit: "A", color: "#123456" },
        "channel-1": { alias: "B", unit: "V", color: null },
      },
      justfloat: {},
    });
    const cloned = cloneChannelPresentations(left);

    expect(areChannelPresentationsEqual(left, right)).toBe(true);
    expect(cloned).toEqual(left);
    expect(cloned).not.toBe(left);
    expect(cloned.firewater).not.toBe(left.firewater);
    expect(cloned.firewater["channel-0"]).not.toBe(left.firewater["channel-0"]);

    right.firewater["channel-0"] = { alias: "C", unit: "A", color: "#123456" };
    expect(areChannelPresentationsEqual(left, right)).toBe(false);
  });

  it("只投影当前内建协议的基础通道，不修改原始通道", () => {
    const presentations: ChannelPresentations = {
      firewater: {
        "channel-0": { alias: "温度", unit: "degC", color: "#abcdef" },
      },
      justfloat: {
        "channel-0": { alias: "电压", unit: "V", color: null },
      },
    };

    const firewater = presentChannelSeries(CHANNEL, "firewater", presentations);
    expect(firewater).toMatchObject({
      name: "CH 0",
      displayName: "温度",
      unit: "degC",
      color: "#abcdef",
    });
    expect(firewater.points).toBe(CHANNEL.points);
    expect(CHANNEL).toEqual({
      id: "channel-0",
      name: "CH 0",
      color: "#123456",
      visible: true,
      points: [{ x: 1, y: 2 }],
      lastValue: 2,
    });

    expect(presentChannelSeries(CHANNEL, "justfloat", presentations)).toMatchObject({
      displayName: "电压",
      unit: "V",
      color: "#123456",
    });
    expect(presentChannelSeries(CHANNEL, "raw", presentations)).toMatchObject({
      displayName: "CH 0",
      unit: "",
      color: "#123456",
    });
    expect(
      presentChannelSeries({ ...CHANNEL, id: "derived:result" }, "firewater", presentations),
    ).toMatchObject({ displayName: "CH 0", unit: "", color: "#123456" });
    expect(getChannelPresentationOverride(presentations, "raw", "channel-0")).toBeNull();
    expect(getChannelPresentationOverride(presentations, "firewater", "channel-16")).toBeNull();
  });
});
