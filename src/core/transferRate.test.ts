import { describe, expect, it } from "vitest";
import {
  sampleTransferRates,
  ZERO_TRANSFER_RATES,
  type TransferRateSample,
} from "./transferRate";

describe("sampleTransferRates", () => {
  it("首个样本只建立基线", () => {
    const update = sampleTransferRates(
      { rxBytes: 2_048, txBytes: 1_024, startedAt: 10 },
      500,
      null,
    );

    expect(update.rates).toEqual(ZERO_TRANSFER_RATES);
    expect(update.sample).toEqual({
      sampledAtMilliseconds: 500,
      startedAt: 10,
      rxBytes: 2_048,
      txBytes: 1_024,
    });
  });

  it("按实际单调时间间隔独立计算 RX 与 TX 增量", () => {
    const previous = createSample(1_000, 10, 1_000, 500);
    const update = sampleTransferRates(
      { rxBytes: 2_000, txBytes: 1_000, startedAt: 10 },
      3_500,
      previous,
    );

    expect(update.rates).toEqual({
      rxBytesPerSecond: 400,
      txBytesPerSecond: 200,
    });
  });

  it("空闲一个采样周期后归零", () => {
    const previous = createSample(1_000, 10, 2_000, 1_000);
    const update = sampleTransferRates(
      { rxBytes: 2_000, txBytes: 1_000, startedAt: 10 },
      2_000,
      previous,
    );

    expect(update.rates).toEqual(ZERO_TRANSFER_RATES);
  });

  it.each([
    ["会话变化", { rxBytes: 3_000, txBytes: 1_500, startedAt: 11 }, 2_000],
    ["RX 计数回退", { rxBytes: 999, txBytes: 1_500, startedAt: 10 }, 2_000],
    ["TX 计数回退", { rxBytes: 3_000, txBytes: 499, startedAt: 10 }, 2_000],
    ["时间没有推进", { rxBytes: 3_000, txBytes: 1_500, startedAt: 10 }, 1_000],
  ])("%s 时重建基线", (_name, stats, sampledAtMilliseconds) => {
    const previous = createSample(1_000, 10, 2_000, 500);
    const update = sampleTransferRates(stats, sampledAtMilliseconds, previous);

    expect(update.rates).toEqual(ZERO_TRANSFER_RATES);
    expect(update.sample).toMatchObject(stats);
  });

  it("拒绝非有限时间或计数且不产生无穷速率", () => {
    const previous = createSample(1_000, 10, 2_000, 500);
    const invalidTime = sampleTransferRates(
      { rxBytes: 3_000, txBytes: 1_500, startedAt: 10 },
      Number.NaN,
      previous,
    );
    const invalidCounter = sampleTransferRates(
      { rxBytes: Number.POSITIVE_INFINITY, txBytes: 1_500, startedAt: 10 },
      2_000,
      previous,
    );
    const overflowingRate = sampleTransferRates(
      { rxBytes: Number.MAX_VALUE, txBytes: 1_500, startedAt: 10 },
      Number.MIN_VALUE,
      createSample(0, 10, 0, 500),
    );

    expect(invalidTime.rates).toEqual(ZERO_TRANSFER_RATES);
    expect(invalidCounter.rates).toEqual(ZERO_TRANSFER_RATES);
    expect(overflowingRate.rates).toEqual(ZERO_TRANSFER_RATES);
  });
});

function createSample(
  sampledAtMilliseconds: number,
  startedAt: number,
  rxBytes: number,
  txBytes: number,
): TransferRateSample {
  return { sampledAtMilliseconds, startedAt, rxBytes, txBytes };
}
