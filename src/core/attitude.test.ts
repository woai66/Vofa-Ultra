import { describe, expect, it } from "vitest";
import type {
  AttitudeChannelValue,
  AttitudeConfig,
  AttitudeCoordinateFrame,
  Quaternion,
} from "../types/attitude";
import {
  areAttitudeConfigsEqual,
  cloneAttitudeConfig,
  createDefaultAttitudeConfig,
  extractLatestAttitudeSample,
  getNeutralSceneQuaternion,
  isAttitudeConfigComplete,
  parseAttitudeConfig,
  quaternionInvert,
  quaternionMultiply,
} from "./attitude";

function completeEulerConfig(): AttitudeConfig {
  const config = createDefaultAttitudeConfig();
  config.channels.roll = "channel-0";
  config.channels.pitch = "channel-1";
  config.channels.yaw = "channel-2";
  return config;
}

function completeQuaternionConfig(): AttitudeConfig {
  const config = createDefaultAttitudeConfig();
  config.inputMode = "quaternion";
  config.channels.w = "channel-0";
  config.channels.x = "channel-1";
  config.channels.y = "channel-2";
  config.channels.z = "channel-3";
  return config;
}

function channelValue(
  frameIndex: number,
  timestamp: number,
  channelId: string,
  value: number,
): AttitudeChannelValue {
  return { frameIndex, timestamp, channelId, value };
}

function rotateVector(quaternion: Quaternion, vector: readonly [number, number, number]) {
  const vectorQuaternion = { x: vector[0], y: vector[1], z: vector[2], w: 0 };
  const rotated = multiplyRaw(
    multiplyRaw(quaternion, vectorQuaternion),
    conjugateRaw(quaternion),
  );
  return [rotated.x, rotated.y, rotated.z] as const;
}

function multiplyRaw(left: Quaternion, right: Quaternion): Quaternion {
  return {
    x: left.w * right.x + left.x * right.w + left.y * right.z - left.z * right.y,
    y: left.w * right.y - left.x * right.z + left.y * right.w + left.z * right.x,
    z: left.w * right.z + left.x * right.y - left.y * right.x + left.z * right.w,
    w: left.w * right.w - left.x * right.x - left.y * right.y - left.z * right.z,
  };
}

function conjugateRaw(quaternion: Quaternion): Quaternion {
  return { x: -quaternion.x, y: -quaternion.y, z: -quaternion.z, w: quaternion.w };
}

function expectQuaternionClose(actual: Quaternion, expected: Quaternion): void {
  expect(actual.x).toBeCloseTo(expected.x, 12);
  expect(actual.y).toBeCloseTo(expected.y, 12);
  expect(actual.z).toBeCloseTo(expected.z, 12);
  expect(actual.w).toBeCloseTo(expected.w, 12);
}

function expectVectorClose(
  actual: readonly [number, number, number],
  expected: readonly [number, number, number],
): void {
  actual.forEach((component, index) => {
    expect(component).toBeCloseTo(expected[index] ?? Number.NaN, 12);
  });
}

describe("姿态配置", () => {
  it("创建、克隆和比较七个稳定通道", () => {
    const config = createDefaultAttitudeConfig();
    expect(config).toEqual({
      inputMode: "euler",
      angleUnit: "degrees",
      coordinateFrame: "enu-flu",
      channels: { roll: "", pitch: "", yaw: "", w: "", x: "", y: "", z: "" },
    });

    const cloned = cloneAttitudeConfig(config);
    expect(areAttitudeConfigsEqual(config, cloned)).toBe(true);
    cloned.channels.roll = "channel-0";
    expect(config.channels.roll).toBe("");
    expect(areAttitudeConfigsEqual(config, cloned)).toBe(false);
  });

  it("严格拒绝缺失或多余字段，并允许不完整配置", () => {
    const config = createDefaultAttitudeConfig();
    expect(parseAttitudeConfig(config)).toEqual(config);
    expect(isAttitudeConfigComplete(config)).toBe(false);
    expect(() => parseAttitudeConfig({ ...config, extra: true })).toThrow("未知字段");
    expect(() => parseAttitudeConfig({ inputMode: config.inputMode })).toThrow("缺少字段");
    expect(() =>
      parseAttitudeConfig({ ...config, channels: { ...config.channels, extra: "" } }),
    ).toThrow("未知字段");
  });

  it("校验原始和派生通道 ID 以及当前模式重复映射", () => {
    const config = completeEulerConfig();
    config.channels.roll = "derived:roll_value";
    expect(parseAttitudeConfig(config)).toEqual(config);
    expect(isAttitudeConfigComplete(config)).toBe(true);

    for (const invalidId of ["channel-16", "channel--1", "derived:", "derived:1bad", "other"]) {
      expect(() =>
        parseAttitudeConfig({ ...config, channels: { ...config.channels, roll: invalidId } }),
      ).toThrow("ID 无效");
    }

    expect(() =>
      parseAttitudeConfig({
        ...config,
        channels: { ...config.channels, pitch: config.channels.roll },
      }),
    ).toThrow("重复通道");

    config.channels.w = config.channels.roll;
    expect(parseAttitudeConfig(config)).toEqual(config);
  });
});

describe("姿态样本提取", () => {
  it("只组合相同 frameIndex，并按输入顺序选择最新完整帧", () => {
    const config = completeEulerConfig();
    const sameTimestampAcrossFrames = [
      channelValue(1, 10, "channel-0", 1),
      channelValue(2, 10, "channel-1", 2),
      channelValue(1, 10, "channel-2", 3),
    ];
    expect(extractLatestAttitudeSample(config, sameTimestampAcrossFrames)).toBeNull();

    const sample = extractLatestAttitudeSample(config, [
      channelValue(7, 70, "channel-0", 1),
      channelValue(7, 70, "channel-1", 2),
      channelValue(7, 70, "channel-2", 3),
      channelValue(5, 50, "channel-0", 4),
      channelValue(5, 50, "channel-1", 5),
      channelValue(5, 50, "channel-2", 6),
    ]);
    expect(sample?.frameIndex).toBe(5);
    expect(sample?.timestamp).toBe(50);
    expect(sample?.sourceValues).toEqual({ inputMode: "euler", roll: 4, pitch: 5, yaw: 6 });
  });

  it("拒绝非有限值、帧内时间不一致和过小四元数", () => {
    const eulerConfig = completeEulerConfig();
    expect(
      extractLatestAttitudeSample(eulerConfig, [
        channelValue(1, 1, "channel-0", 0),
        channelValue(1, 1, "channel-1", Number.NaN),
        channelValue(1, 1, "channel-2", 0),
      ]),
    ).toBeNull();
    expect(
      extractLatestAttitudeSample(eulerConfig, [
        channelValue(1, 1, "channel-0", 0),
        channelValue(1, 2, "channel-1", 0),
        channelValue(1, 1, "channel-2", 0),
      ]),
    ).toBeNull();

    const quaternionConfig = completeQuaternionConfig();
    expect(
      extractLatestAttitudeSample(quaternionConfig, [
        channelValue(1, 1, "channel-0", 1e-20),
        channelValue(1, 1, "channel-1", 0),
        channelValue(1, 1, "channel-2", 0),
        channelValue(1, 1, "channel-3", 0),
      ]),
    ).toBeNull();
  });
});

describe("姿态坐标转换", () => {
  it("Euler degrees 和 radians 产生相同的内禀 ZYX 旋转", () => {
    const degreesConfig = completeEulerConfig();
    const radiansConfig = completeEulerConfig();
    radiansConfig.angleUnit = "radians";
    const degrees = extractLatestAttitudeSample(degreesConfig, [
      channelValue(1, 1, "channel-0", 30),
      channelValue(1, 1, "channel-1", -20),
      channelValue(1, 1, "channel-2", 70),
    ]);
    const radians = extractLatestAttitudeSample(radiansConfig, [
      channelValue(1, 1, "channel-0", Math.PI / 6),
      channelValue(1, 1, "channel-1", -Math.PI / 9),
      channelValue(1, 1, "channel-2", (7 * Math.PI) / 18),
    ]);
    expect(degrees).not.toBeNull();
    expect(radians).not.toBeNull();
    expectQuaternionClose(degrees!.sceneQuaternion, radians!.sceneQuaternion);
  });

  it.each([
    ["enu-flu", [0, 0, -1]],
    ["ned-frd", [1, 0, 0]],
  ] as const)("%s 的 yaw +90 将前向轴映射到约定场景方向", (coordinateFrame, expected) => {
    const config = completeEulerConfig();
    config.coordinateFrame = coordinateFrame;
    const sample = extractLatestAttitudeSample(config, [
      channelValue(1, 1, "channel-0", 0),
      channelValue(1, 1, "channel-1", 0),
      channelValue(1, 1, "channel-2", 90),
    ]);
    expect(sample).not.toBeNull();
    expectVectorClose(rotateVector(sample!.sceneQuaternion, [1, 0, 0]), expected);
  });

  it.each(["enu-flu", "ned-frd"] as const)(
    "%s 的零姿态与 neutral quaternion 一致且保持单位范数",
    (coordinateFrame: AttitudeCoordinateFrame) => {
      const config = completeQuaternionConfig();
      config.coordinateFrame = coordinateFrame;
      const sample = extractLatestAttitudeSample(config, [
        channelValue(1, 1, "channel-0", -2),
        channelValue(1, 1, "channel-1", 0),
        channelValue(1, 1, "channel-2", 0),
        channelValue(1, 1, "channel-3", 0),
      ]);
      expect(sample).not.toBeNull();
      expectQuaternionClose(sample!.sceneQuaternion, getNeutralSceneQuaternion(coordinateFrame));
      expect(Math.hypot(...Object.values(sample!.sceneQuaternion))).toBeCloseTo(1, 12);
      expect(sample!.sceneQuaternion.w).toBeGreaterThanOrEqual(0);
    },
  );

  it("归一化输入、稳定 π 旋转符号，并可通过 multiply/invert 归零", () => {
    const config = completeQuaternionConfig();
    const sample = extractLatestAttitudeSample(config, [
      channelValue(1, 1, "channel-0", 0),
      channelValue(1, 1, "channel-1", -20),
      channelValue(1, 1, "channel-2", 0),
      channelValue(1, 1, "channel-3", 0),
    ]);
    expect(sample).not.toBeNull();
    expect(sample!.sceneQuaternion.w).toBeGreaterThanOrEqual(0);
    expect(Math.hypot(...Object.values(sample!.sceneQuaternion))).toBeCloseTo(1, 12);

    const zeroed = quaternionMultiply(quaternionInvert(sample!.sceneQuaternion), sample!.sceneQuaternion);
    expectQuaternionClose(zeroed, { x: 0, y: 0, z: 0, w: 1 });
  });
});
