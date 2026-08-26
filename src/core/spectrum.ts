import FFT from "fft.js";
import type { DataPoint } from "../types/workbench";
import {
  MAX_SPECTRUM_SAMPLE_RATE_HZ,
  MIN_SPECTRUM_SAMPLE_RATE_HZ,
  SPECTRUM_WINDOW_SIZES,
  type SpectrumWindowSize,
} from "./spectrumConfig";

export { SPECTRUM_WINDOW_SIZES };
export type { SpectrumWindowSize };

interface SpectrumOkResult {
  readonly status: "ok";
  readonly pointCount: number;
  readonly sampleRateHz: number;
  readonly frequencyResolutionHz: number;
  readonly frequenciesHz: number[];
  readonly amplitudes: number[];
  readonly peakFrequencyHz: number | null;
  readonly peakAmplitude: number;
}

interface SpectrumInsufficientResult {
  readonly status: "insufficient";
  readonly requiredPointCount: number;
  readonly availablePointCount: number;
}

interface SpectrumInvalidDataResult {
  readonly status: "invalid-data";
  readonly reason: "non-finite";
}

export type SpectrumAnalysisResult =
  | SpectrumOkResult
  | SpectrumInsufficientResult
  | SpectrumInvalidDataResult;

export function analyzeSpectrum(
  points: readonly DataPoint[],
  windowSize: SpectrumWindowSize,
  sampleRateHz: number,
): SpectrumAnalysisResult {
  assertSupportedWindowSize(windowSize);
  assertValidSampleRate(sampleRateHz);

  if (points.length < windowSize) {
    return {
      status: "insufficient",
      requiredPointCount: windowSize,
      availablePointCount: points.length,
    };
  }

  const values = points.slice(-windowSize).map((point) => point.y);
  if (values.some((value) => !Number.isFinite(value))) {
    return { status: "invalid-data", reason: "non-finite" };
  }

  const mean = calculateFiniteMean(values);
  const windowedValues = new Array<number>(windowSize);
  let windowWeightSum = 0;
  for (let index = 0; index < windowSize; index += 1) {
    const windowWeight = 0.5 * (1 - Math.cos((2 * Math.PI * index) / windowSize));
    windowWeightSum += windowWeight;
    windowedValues[index] = ((values[index] ?? 0) - mean) * windowWeight;
  }

  if (windowedValues.some((value) => !Number.isFinite(value))) {
    return { status: "invalid-data", reason: "non-finite" };
  }

  const fft = new FFT(windowSize);
  const spectrum = fft.createComplexArray();
  fft.realTransform(spectrum, windowedValues);

  const frequencyResolutionHz = sampleRateHz / windowSize;
  const lastBinIndex = windowSize / 2;
  const frequenciesHz = new Array<number>(lastBinIndex + 1);
  const amplitudes = new Array<number>(lastBinIndex + 1);
  let peakBinIndex: number | null = null;
  let peakAmplitude = 0;

  for (let binIndex = 0; binIndex <= lastBinIndex; binIndex += 1) {
    const real = spectrum[binIndex * 2] ?? 0;
    const imaginary = spectrum[binIndex * 2 + 1] ?? 0;
    const oneSidedScale = binIndex === 0 || binIndex === lastBinIndex ? 1 : 2;
    const amplitude = (Math.hypot(real, imaginary) * oneSidedScale) / windowWeightSum;
    if (!Number.isFinite(amplitude)) {
      return { status: "invalid-data", reason: "non-finite" };
    }

    frequenciesHz[binIndex] = binIndex * frequencyResolutionHz;
    amplitudes[binIndex] = amplitude;
    if (
      binIndex > 0 &&
      isPreferredPeak(amplitude, peakAmplitude, binIndex === lastBinIndex)
    ) {
      peakBinIndex = binIndex;
      peakAmplitude = amplitude;
    }
  }

  return {
    status: "ok",
    pointCount: windowSize,
    sampleRateHz,
    frequencyResolutionHz,
    frequenciesHz,
    amplitudes,
    peakFrequencyHz: peakBinIndex === null ? null : frequenciesHz[peakBinIndex] ?? null,
    peakAmplitude,
  };
}

function assertSupportedWindowSize(windowSize: number): asserts windowSize is SpectrumWindowSize {
  if (!SPECTRUM_WINDOW_SIZES.some((supportedSize) => supportedSize === windowSize)) {
    throw new RangeError(`Unsupported spectrum window size: ${windowSize}`);
  }
}

function assertValidSampleRate(sampleRateHz: number): void {
  if (
    !Number.isFinite(sampleRateHz) ||
    sampleRateHz < MIN_SPECTRUM_SAMPLE_RATE_HZ ||
    sampleRateHz > MAX_SPECTRUM_SAMPLE_RATE_HZ
  ) {
    throw new RangeError(
      "Spectrum sample rate must be between "
        + `${MIN_SPECTRUM_SAMPLE_RATE_HZ} and ${MAX_SPECTRUM_SAMPLE_RATE_HZ} Hz`,
    );
  }
}

function calculateFiniteMean(values: readonly number[]): number {
  const scale = values.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0);
  if (scale === 0) {
    return 0;
  }

  const scaledSum = values.reduce((sum, value) => sum + value / scale, 0);
  return (scaledSum / values.length) * scale;
}

function isPreferredPeak(
  candidateAmplitude: number,
  currentAmplitude: number,
  preferApproximateTie: boolean,
): boolean {
  if (candidateAmplitude === 0) {
    return false;
  }
  if (candidateAmplitude > currentAmplitude) {
    return true;
  }
  if (!preferApproximateTie) {
    return false;
  }

  const comparisonTolerance =
    Number.EPSILON * Math.max(Number.MIN_VALUE, candidateAmplitude, currentAmplitude) * 16;
  return currentAmplitude - candidateAmplitude <= comparisonTolerance;
}
