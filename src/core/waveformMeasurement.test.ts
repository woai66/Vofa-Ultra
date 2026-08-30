import { describe, expect, it } from "vitest";
import type { DataPoint } from "../types/workbench";
import {
  calculateWaveformMeasurement,
  createInitialMeasurementAnchors,
  getVisibleMeasurementPoints,
  moveMeasurementAnchor,
  resolveMeasurementAnchor,
  snapToNearestMeasurementPoint,
  type WaveformMeasurementPoint,
} from "./waveformMeasurement";

function point(x: number, y = x, frameSequence?: number): DataPoint {
  return frameSequence === undefined ? { x, y } : { x, y, frameSequence };
}

function measurementPoint(
  index: number,
  timestampSeconds: number,
  value: number,
): WaveformMeasurementPoint {
  return { index, timestampSeconds, value };
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
      measurementPoint(0, 10, 10),
      measurementPoint(1, 20, 20),
    ]);
    expect(getVisibleMeasurementPoints(points, Number.NaN)).toEqual([]);
    expect(getVisibleMeasurementPoints(points, -1)).toEqual([]);
  });

  it("窗口起点包含边界样本", () => {
    expect(getVisibleMeasurementPoints([point(0), point(5), point(10)], 5)).toEqual([
      measurementPoint(0, 5, 5),
      measurementPoint(1, 10, 10),
    ]);
  });

  it("同一时间的多帧全部保留，并优先按帧序号排序", () => {
    expect(
      getVisibleMeasurementPoints(
        [
          point(2, 20, 202),
          point(1, 10, 101),
          point(2, 21, 201),
          point(3, 30, 301),
          point(2, 22, 203),
        ],
        2,
      ),
    ).toEqual([
      measurementPoint(0, 1, 10),
      measurementPoint(1, 2, 21),
      measurementPoint(2, 2, 20),
      measurementPoint(3, 2, 22),
      measurementPoint(4, 3, 30),
    ]);
  });

  it("没有帧序号的同刻样本按来源顺序保留", () => {
    expect(getVisibleMeasurementPoints([point(1, 10), point(1, 20), point(1, 30)], 0)).toEqual([
      measurementPoint(0, 1, 10),
      measurementPoint(1, 1, 20),
      measurementPoint(2, 1, 30),
    ]);
  });
});

describe("波形测量游标", () => {
  it("空窗口不创建游标，单点窗口让 A/B 指向同一样本", () => {
    expect(createInitialMeasurementAnchors([], 5)).toBeNull();
    expect(createInitialMeasurementAnchors([point(Number.NaN)], 5)).toBeNull();
    expect(createInitialMeasurementAnchors([point(7, 3)], 5)).toEqual({
      aIndex: 0,
      bIndex: 0,
    });
  });

  it("在可见样本约 25% 和 75% 处初始化固定 A/B 游标", () => {
    expect(createInitialMeasurementAnchors([0, 1, 2, 3, 4].map((x) => point(x)), 4)).toEqual({
      aIndex: 1,
      bIndex: 3,
    });
    expect(createInitialMeasurementAnchors([point(0), point(1)], 1)).toEqual({
      aIndex: 0,
      bIndex: 1,
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

  it("按冻结快照索引解析游标，并按指定样本数移动", () => {
    const points = [0, 1, 2, 3, 4].map((x) => point(x, x * 10));

    expect(resolveMeasurementAnchor(points, 4, 2)).toEqual(measurementPoint(2, 2, 20));
    expect(moveMeasurementAnchor(points, 4, 2, 2)?.timestampSeconds).toBe(4);
    expect(moveMeasurementAnchor(points, 4, 2, -10)?.timestampSeconds).toBe(0);
    expect(moveMeasurementAnchor(points, 4, 2, 0.5)).toBeNull();
  });

  it("非法或越界索引不解析为其他样本", () => {
    const points = [point(5), point(6), point(7)];

    expect(resolveMeasurementAnchor(points, 10, -1)).toBeNull();
    expect(resolveMeasurementAnchor(points, 10, 3)).toBeNull();
    expect(moveMeasurementAnchor(points, 10, 3, 1)).toBeNull();
  });
});

describe("波形区间测量", () => {
  it("反向输入按样本顺序排列并计算非负时间、频率和 B-A 差值", () => {
    const result = calculateWaveformMeasurement(
      [point(1, 2), point(2, 5), point(4, 11)],
      3,
      { aIndex: 2, bIndex: 0 },
    );

    expect(result).toEqual({
      pointA: measurementPoint(0, 1, 2),
      pointB: measurementPoint(2, 4, 11),
      deltaTimeSeconds: 3,
      frequencyHz: 1 / 3,
      deltaY: 9,
    });
  });

  it("同一时刻的不同帧保留各自读数，且频率为空", () => {
    const points = [point(2, 1, 101), point(2, 2, 102), point(2, 3, 103)];

    expect(
      calculateWaveformMeasurement(points, 0, {
        aIndex: 0,
        bIndex: 2,
      }),
    ).toEqual({
      pointA: measurementPoint(0, 2, 1),
      pointB: measurementPoint(2, 2, 3),
      deltaTimeSeconds: 0,
      frequencyHz: null,
      deltaY: 2,
    });
  });

  it("两个游标落在同一样本时频率为空", () => {
    expect(
      calculateWaveformMeasurement([point(2, 7)], 5, {
        aIndex: 0,
        bIndex: 0,
      }),
    ).toEqual({
      pointA: measurementPoint(0, 2, 7),
      pointB: measurementPoint(0, 2, 7),
      deltaTimeSeconds: 0,
      frequencyHz: null,
      deltaY: 0,
    });
  });

  it("任一锚点失效时不返回部分测量结果", () => {
    expect(
      calculateWaveformMeasurement([point(5), point(10)], 5, {
        aIndex: -1,
        bIndex: 1,
      }),
    ).toBeNull();
  });

  it("覆盖每通道 2000 点边界且不产生索引偏移", () => {
    const points = Array.from({ length: 2_000 }, (_, index) => point(index));
    const visiblePoints = getVisibleMeasurementPoints(points, 1_999);

    expect(visiblePoints).toHaveLength(2_000);
    expect(visiblePoints.at(-1)).toEqual(measurementPoint(1_999, 1_999, 1_999));
    expect(snapToNearestMeasurementPoint(visiblePoints, 999.5)?.timestampSeconds).toBe(999);
    expect(createInitialMeasurementAnchors(points, 1_999)).toEqual({
      aIndex: 500,
      bIndex: 1_499,
    });
    expect(moveMeasurementAnchor(points, 1_999, 1_999, 1)?.index).toBe(1_999);
  });
});
