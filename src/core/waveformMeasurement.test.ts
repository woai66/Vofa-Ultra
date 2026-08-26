import { describe, expect, it } from "vitest";
import type { DataPoint } from "../types/workbench";
import {
  calculateWaveformMeasurement,
  createInitialMeasurementAnchors,
  getVisibleMeasurementPoints,
  moveMeasurementAnchor,
  resolveMeasurementAnchor,
  snapToNearestMeasurementPoint,
} from "./waveformMeasurement";

function point(x: number, y = x): DataPoint {
  return { x, y };
}

describe("波形测量可见窗口", () => {
  it("过滤非有限点，并以最后一个有限时间为窗口终点", () => {
    const points = [
      point(10, 10),
      point(Number.NaN, 20),
      point(2, 2),
      point(Number.POSITIVE_INFINITY, 30),
      point(8, Number.NEGATIVE_INFINITY),
      point(20, 20),
      point(21, Number.NaN),
    ];

    expect(getVisibleMeasurementPoints(points, 10)).toEqual([
      { index: 0, timestampSeconds: 10, value: 10 },
      { index: 1, timestampSeconds: 20, value: 20 },
    ]);
    expect(getVisibleMeasurementPoints(points, Number.NaN)).toEqual([]);
    expect(getVisibleMeasurementPoints(points, -1)).toEqual([]);
  });

  it("窗口起点包含边界样本", () => {
    expect(getVisibleMeasurementPoints([point(0), point(5), point(10)], 5)).toEqual([
      { index: 0, timestampSeconds: 5, value: 5 },
      { index: 1, timestampSeconds: 10, value: 10 },
    ]);
  });

  it("重复时间戳保留图表同样会显示的最后一个样本", () => {
    expect(
      getVisibleMeasurementPoints(
        [point(2, 20), point(1, 10), point(2, 21), point(3, 30), point(2, 22)],
        2,
      ),
    ).toEqual([
      { index: 0, timestampSeconds: 1, value: 10 },
      { index: 1, timestampSeconds: 2, value: 22 },
      { index: 2, timestampSeconds: 3, value: 30 },
    ]);
  });
});

describe("波形测量游标", () => {
  it("空窗口不创建游标，单点窗口让 A/B 指向同一点", () => {
    expect(createInitialMeasurementAnchors([], 5)).toBeNull();
    expect(createInitialMeasurementAnchors([point(Number.NaN)], 5)).toBeNull();
    expect(createInitialMeasurementAnchors([point(7, 3)], 5)).toEqual({
      aTimestampSeconds: 7,
      bTimestampSeconds: 7,
    });
  });

  it("在可见样本约 25% 和 75% 处初始化固定 A/B 游标", () => {
    expect(createInitialMeasurementAnchors([0, 1, 2, 3, 4].map((x) => point(x)), 4)).toEqual({
      aTimestampSeconds: 1,
      bTimestampSeconds: 3,
    });
    expect(createInitialMeasurementAnchors([point(0), point(1)], 1)).toEqual({
      aTimestampSeconds: 0,
      bTimestampSeconds: 1,
    });
  });

  it("二分吸附在越界时取端点，在中点平局时取较早样本", () => {
    const visiblePoints = getVisibleMeasurementPoints([point(0), point(2), point(5)], 5);

    expect(snapToNearestMeasurementPoint(visiblePoints, -10)?.timestampSeconds).toBe(0);
    expect(snapToNearestMeasurementPoint(visiblePoints, 10)?.timestampSeconds).toBe(5);
    expect(snapToNearestMeasurementPoint(visiblePoints, 3.5)?.timestampSeconds).toBe(2);
    expect(snapToNearestMeasurementPoint(visiblePoints, Number.POSITIVE_INFINITY)).toBeNull();
    expect(snapToNearestMeasurementPoint([], 1)).toBeNull();
  });

  it("从语义时间锚点解析当前样本，并按指定样本数移动", () => {
    const points = [0, 1, 2, 3, 4].map((x) => point(x, x * 10));

    expect(resolveMeasurementAnchor(points, 4, 2.4)).toEqual({
      index: 2,
      timestampSeconds: 2,
      value: 20,
    });
    expect(moveMeasurementAnchor(points, 4, 2.4, 2)?.timestampSeconds).toBe(4);
    expect(moveMeasurementAnchor(points, 4, 2.4, -10)?.timestampSeconds).toBe(0);
    expect(moveMeasurementAnchor(points, 4, 2.4, 0.5)).toBeNull();
  });

  it("锚点被时间窗或容量边界淘汰后返回失效", () => {
    expect(resolveMeasurementAnchor([point(0), point(5), point(10)], 5, 4.9)).toBeNull();
    expect(resolveMeasurementAnchor([point(5), point(6), point(7)], 10, 4)).toBeNull();
    expect(moveMeasurementAnchor([point(5), point(6), point(7)], 10, 4, 1)).toBeNull();
  });
});

describe("波形区间测量", () => {
  it("反向输入按时间排序并计算非负时间、频率和 B-A 差值", () => {
    const result = calculateWaveformMeasurement(
      [point(1, 2), point(2, 5), point(4, 11)],
      3,
      { aTimestampSeconds: 4, bTimestampSeconds: 1 },
    );

    expect(result).toEqual({
      pointA: { index: 0, timestampSeconds: 1, value: 2 },
      pointB: { index: 2, timestampSeconds: 4, value: 11 },
      deltaTimeSeconds: 3,
      frequencyHz: 1 / 3,
      deltaY: 9,
    });
  });

  it("两个游标落在同一时间时频率为空", () => {
    expect(
      calculateWaveformMeasurement([point(2, 7)], 5, {
        aTimestampSeconds: 2,
        bTimestampSeconds: 2,
      }),
    ).toEqual({
      pointA: { index: 0, timestampSeconds: 2, value: 7 },
      pointB: { index: 0, timestampSeconds: 2, value: 7 },
      deltaTimeSeconds: 0,
      frequencyHz: null,
      deltaY: 0,
    });
  });

  it("任一锚点失效时不返回部分测量结果", () => {
    expect(
      calculateWaveformMeasurement([point(5), point(10)], 5, {
        aTimestampSeconds: 4,
        bTimestampSeconds: 10,
      }),
    ).toBeNull();
  });

  it("覆盖每通道 2000 点边界且不产生索引偏移", () => {
    const points = Array.from({ length: 2_000 }, (_, index) => point(index));
    const visiblePoints = getVisibleMeasurementPoints(points, 1_999);

    expect(visiblePoints).toHaveLength(2_000);
    expect(visiblePoints.at(-1)).toEqual({ index: 1_999, timestampSeconds: 1_999, value: 1_999 });
    expect(snapToNearestMeasurementPoint(visiblePoints, 999.5)?.timestampSeconds).toBe(999);
    expect(createInitialMeasurementAnchors(points, 1_999)).toEqual({
      aTimestampSeconds: 500,
      bTimestampSeconds: 1_499,
    });
    expect(moveMeasurementAnchor(points, 1_999, 1_999, 1)?.index).toBe(1_999);
  });
});
