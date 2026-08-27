import type { TransferStats } from "../types/workbench";

export interface TransferRates {
  readonly rxBytesPerSecond: number;
  readonly txBytesPerSecond: number;
}

export interface TransferRateSample {
  readonly sampledAtMilliseconds: number;
  readonly startedAt: number | undefined;
  readonly rxBytes: number;
  readonly txBytes: number;
}

export interface TransferRateUpdate {
  readonly sample: TransferRateSample;
  readonly rates: TransferRates;
}

export const ZERO_TRANSFER_RATES: TransferRates = {
  rxBytesPerSecond: 0,
  txBytesPerSecond: 0,
};

export function sampleTransferRates(
  stats: Pick<TransferStats, "rxBytes" | "txBytes" | "startedAt">,
  sampledAtMilliseconds: number,
  previous: TransferRateSample | null,
): TransferRateUpdate {
  const sample: TransferRateSample = {
    sampledAtMilliseconds,
    startedAt: stats.startedAt,
    rxBytes: stats.rxBytes,
    txBytes: stats.txBytes,
  };
  if (
    previous === null ||
    !validSample(sample) ||
    !validSample(previous) ||
    sample.startedAt !== previous.startedAt ||
    sample.rxBytes < previous.rxBytes ||
    sample.txBytes < previous.txBytes ||
    sample.sampledAtMilliseconds <= previous.sampledAtMilliseconds
  ) {
    return { sample, rates: ZERO_TRANSFER_RATES };
  }

  const elapsedSeconds =
    (sample.sampledAtMilliseconds - previous.sampledAtMilliseconds) / 1_000;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
    return { sample, rates: ZERO_TRANSFER_RATES };
  }
  return {
    sample,
    rates: {
      rxBytesPerSecond: finiteRate(sample.rxBytes - previous.rxBytes, elapsedSeconds),
      txBytesPerSecond: finiteRate(sample.txBytes - previous.txBytes, elapsedSeconds),
    },
  };
}

function validSample(sample: TransferRateSample): boolean {
  return (
    Number.isFinite(sample.sampledAtMilliseconds) &&
    sample.sampledAtMilliseconds >= 0 &&
    Number.isFinite(sample.rxBytes) &&
    sample.rxBytes >= 0 &&
    Number.isFinite(sample.txBytes) &&
    sample.txBytes >= 0
  );
}

function finiteRate(deltaBytes: number, elapsedSeconds: number): number {
  const rate = deltaBytes / elapsedSeconds;
  return Number.isFinite(rate) && rate >= 0 ? rate : 0;
}
