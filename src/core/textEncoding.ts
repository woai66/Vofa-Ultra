import type { TerminalTextEncoding } from "../types/workbench";

type LibraryTextEncoderFactory =
  typeof import("@kayahr/text-encoding/no-encodings").createTextEncoder;

export const TEXT_ENCODING_OPTIONS: readonly {
  value: TerminalTextEncoding;
  label: string;
}[] = Object.freeze([
  { value: "utf-8", label: "UTF-8" },
  { value: "gb18030", label: "GB18030" },
  { value: "windows-1252", label: "Windows-1252" },
]);

const loadedEncodings = new Set<TerminalTextEncoding>(["utf-8"]);
const loadingEncodings = new Map<TerminalTextEncoding, Promise<void>>();
const encoders = new Map<TerminalTextEncoding, TextEncoder>();
let libraryTextEncoderFactory: LibraryTextEncoderFactory | undefined;
let libraryTextEncoderFactoryPromise: Promise<LibraryTextEncoderFactory> | undefined;

export function isTextEncodingLoaded(encoding: TerminalTextEncoding): boolean {
  return loadedEncodings.has(encoding);
}

export function textEncodingLabel(encoding: TerminalTextEncoding): string {
  return TEXT_ENCODING_OPTIONS.find((option) => option.value === encoding)?.label ?? encoding;
}

export async function loadTextEncoding(encoding: TerminalTextEncoding): Promise<void> {
  if (loadedEncodings.has(encoding)) {
    return;
  }
  const existing = loadingEncodings.get(encoding);
  if (existing) {
    return existing;
  }

  const loading = loadEncodingModule(encoding)
    .then(() => {
      loadedEncodings.add(encoding);
    })
    .finally(() => {
      loadingEncodings.delete(encoding);
    });
  loadingEncodings.set(encoding, loading);
  return loading;
}

export function encodeText(
  value: string,
  encoding: TerminalTextEncoding = "utf-8",
): Uint8Array {
  if (!loadedEncodings.has(encoding)) {
    throw new Error(`${textEncodingLabel(encoding)} 编码器尚未加载`);
  }

  try {
    let encoder = encoders.get(encoding);
    if (!encoder) {
      if (encoding === "utf-8") {
        encoder = new globalThis.TextEncoder();
      } else {
        const createLibraryTextEncoder = libraryTextEncoderFactory;
        if (!createLibraryTextEncoder) {
          throw new Error(`${textEncodingLabel(encoding)} 编码器尚未加载`);
        }
        encoder = createLibraryTextEncoder(encoding);
      }
      encoders.set(encoding, encoder);
    }
    return encoder.encode(value);
  } catch (error) {
    throw createEncodingError(encoding, error);
  }
}

async function loadEncodingModule(encoding: TerminalTextEncoding): Promise<void> {
  switch (encoding) {
    case "utf-8":
      return;
    case "gb18030":
      await Promise.all([
        loadLibraryTextEncoderFactory(),
        import("@kayahr/text-encoding/encodings/gb18030"),
      ]);
      return;
    case "windows-1252":
      await Promise.all([
        loadLibraryTextEncoderFactory(),
        import("@kayahr/text-encoding/encodings/windows-1252"),
      ]);
      return;
  }
}

function loadLibraryTextEncoderFactory(): Promise<LibraryTextEncoderFactory> {
  libraryTextEncoderFactoryPromise ??= import("@kayahr/text-encoding/no-encodings")
    .then(({ createTextEncoder }) => {
      libraryTextEncoderFactory = createTextEncoder;
      return createTextEncoder;
    });
  return libraryTextEncoderFactoryPromise;
}

function createEncodingError(encoding: TerminalTextEncoding, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const codePoint = /code point (\d+)/i.exec(detail)?.[1];
  if (!codePoint) {
    return new Error(`${textEncodingLabel(encoding)} 编码失败：${detail}`, { cause });
  }
  const numericCodePoint = Number(codePoint);
  const formatted = `U+${numericCodePoint.toString(16).toUpperCase().padStart(4, "0")}`;
  return new Error(`${textEncodingLabel(encoding)} 无法表示字符 ${formatted}`, { cause });
}
