import { bench, describe } from "vitest";
import {
  createProtocolParser,
  encodeFireWaterFrame,
  encodeJustFloatFrame,
} from "../src/core/protocols";
import {
  compileProcessingGraph,
  ProcessingGraphRuntime,
} from "../src/core/processingGraph";
import {
  copyExtensionInputBatches,
  MAX_EXTENSION_BATCH_BYTES,
  MAX_EXTENSION_QUEUE_BYTES,
} from "../src/core/extensionCoordinator";
import type { ParsedFrame } from "../src/types/workbench";

const MEBIBYTE = 1024 * 1024;
const PROTOCOL_CHUNK_BYTES = 4_093;
const PROCESSING_FRAME_COUNT = 4_096;
const EXTENSION_BENCHMARK_BYTES = 512 * 1024;
const EXTENSION_BENCHMARK_BATCH_BYTES = 64 * 1024;
const EXTENSION_BENCHMARK_BATCHES = 8;
const BENCHMARK_OPTIONS = {
  time: 1_000,
  iterations: 15,
  warmupTime: 300,
  warmupIterations: 5,
} as const;

const protocolValues = Array.from({ length: 16 }, (_, index) => index + 0.25);
const fireWaterFrame = encodeFireWaterFrame(protocolValues);
const justFloatFrame = encodeJustFloatFrame(protocolValues);
const fireWaterBytes = repeatToMinimumSize(
  fireWaterFrame,
  MEBIBYTE,
);
const justFloatBytes = repeatToMinimumSize(
  justFloatFrame,
  MEBIBYTE,
);
const fireWaterChunks = splitBytes(fireWaterBytes, PROTOCOL_CHUNK_BYTES);
const justFloatChunks = splitBytes(justFloatBytes, PROTOCOL_CHUNK_BYTES);

const processingGraph = compileProcessingGraph({
  enabled: true,
  nodes: Array.from({ length: 4 }, (_, index) => [
    { id: `input_${index}`, kind: "input" as const, channelIndex: index },
    {
      id: `scale_${index}`,
      kind: "affine" as const,
      input: `input_${index}`,
      gain: 1.5,
      offset: 0.25,
    },
    {
      id: `ema_${index}`,
      kind: "ema" as const,
      input: `scale_${index}`,
      alpha: 0.2,
    },
    {
      id: `average_${index}`,
      kind: "moving_average" as const,
      input: `ema_${index}`,
      windowSize: 32,
    },
    {
      id: `output_${index}`,
      kind: "output" as const,
      input: `average_${index}`,
      name: `输出 ${index + 1}`,
      color: `#${(0x228855 + index * 0x111111).toString(16).padStart(6, "0")}`,
    },
  ]).flat(),
});
const processingFrames: ParsedFrame[] = Array.from(
  { length: PROCESSING_FRAME_COUNT },
  (_, frameIndex) => ({
    values: protocolValues.map((value) => value + frameIndex / 1_000),
    timestamp: frameIndex,
  }),
);
const maximumExtensionInput = new Uint8Array(EXTENSION_BENCHMARK_BYTES).fill(0x5a);

describe("协议与数据处理热路径", () => {
  bench(
    "FireWater 1 MiB 分片解析",
    () => {
      const parser = createProtocolParser("firewater");
      let acceptedFrames = 0;
      for (const chunk of fireWaterChunks) {
        acceptedFrames += parser.push(chunk, 1_000).length;
      }
      requireEqual(
        acceptedFrames,
        fireWaterBytes.length / fireWaterFrame.length,
        "FireWater 帧数",
      );
    },
    BENCHMARK_OPTIONS,
  );

  bench(
    "JustFloat 1 MiB 分片解析",
    () => {
      const parser = createProtocolParser("justfloat");
      let acceptedFrames = 0;
      for (const chunk of justFloatChunks) {
        acceptedFrames += parser.push(chunk, 1_000).length;
      }
      requireEqual(
        acceptedFrames,
        justFloatBytes.length / justFloatFrame.length,
        "JustFloat 帧数",
      );
    },
    BENCHMARK_OPTIONS,
  );

  bench(
    "20 节点处理图执行 4096 帧",
    () => {
      const runtime = new ProcessingGraphRuntime(processingGraph);
      const samples = runtime.process(processingFrames);
      requireEqual(samples.length, PROCESSING_FRAME_COUNT * 4, "处理图输出样本数");
      requireEqual(
        runtime.getSnapshot().processedFrames,
        PROCESSING_FRAME_COUNT,
        "处理图完成帧数",
      );
    },
    BENCHMARK_OPTIONS,
  );
});

describe("扩展同步入口", () => {
  bench(
    "512 KiB RX 分批复制",
    () => {
      requireEqual(
        MAX_EXTENSION_QUEUE_BYTES,
        EXTENSION_BENCHMARK_BYTES,
        "扩展队列字节上限",
      );
      requireEqual(
        MAX_EXTENSION_BATCH_BYTES,
        EXTENSION_BENCHMARK_BATCH_BYTES,
        "扩展批次字节上限",
      );
      const batches = copyExtensionInputBatches(maximumExtensionInput);
      requireEqual(batches.length, EXTENSION_BENCHMARK_BATCHES, "扩展批次数");
      requireEqual(
        batches.reduce((total, batch) => total + batch.length, 0),
        EXTENSION_BENCHMARK_BYTES,
        "扩展复制字节数",
      );
      requireEqual(batches[0]?.[0] ?? -1, 0x5a, "扩展复制内容");
    },
    BENCHMARK_OPTIONS,
  );
});

function repeatToMinimumSize(frame: Uint8Array, minimumBytes: number): Uint8Array {
  const repeatCount = Math.ceil(minimumBytes / frame.length);
  const result = new Uint8Array(frame.length * repeatCount);
  for (let index = 0; index < repeatCount; index += 1) {
    result.set(frame, index * frame.length);
  }
  return result;
}

function splitBytes(bytes: Uint8Array, chunkBytes: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    chunks.push(bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length)));
  }
  return chunks;
}

function requireEqual(actual: number, expected: number, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}不符合基准契约：${actual}，预期 ${expected}`);
  }
}
