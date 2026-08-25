export const DATA_NUMERIC_TYPES = [
  "u8",
  "i8",
  "u16",
  "i16",
  "u32",
  "i32",
  "f32",
  "f64",
] as const;

export const DATA_ENDIANNESS_VALUES = ["le", "be"] as const;

export type DataNumericType = (typeof DATA_NUMERIC_TYPES)[number];
export type DataEndianness = (typeof DATA_ENDIANNESS_VALUES)[number];
