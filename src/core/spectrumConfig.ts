export const SPECTRUM_WINDOW_SIZES = [256, 512, 1024] as const;
export type SpectrumWindowSize = (typeof SPECTRUM_WINDOW_SIZES)[number];

export const MIN_SPECTRUM_SAMPLE_RATE_HZ = 0.1;
export const MAX_SPECTRUM_SAMPLE_RATE_HZ = 1_000_000;
