import { describe, expect, it } from "vitest";
import {
  encodeFireWaterFrame,
  encodeJustFloatFrame,
  FireWaterParser,
  JustFloatParser,
} from "./protocols";

describe("FireWaterParser", () => {
  it("解析被任意分包的多帧数据", () => {
    const parser = new FireWaterParser();
    const bytes = new TextEncoder().encode("1.25,-2,3\n4,5,6\r\n");
    const frames = feedInChunks(parser, bytes, [1, 2, 5, 3, 7], 1_000);

    expect(frames).toHaveLength(2);
    expect(frames[0]?.values).toEqual([1.25, -2, 3]);
    expect(frames[1]?.values).toEqual([4, 5, 6]);
  });

  it("保留命名通道并跳过损坏行", () => {
    const parser = new FireWaterParser();
    const frames = parser.push(
      new TextEncoder().encode("temp:23.5,voltage:3.3\nbroken,1\ncurrent:0.42\n"),
      2_000,
    );

    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ labels: ["temp", "voltage"], values: [23.5, 3.3] });
    expect(frames[1]).toMatchObject({ labels: ["current"], values: [0.42] });
  });

  it("编码结果可被解析器还原", () => {
    const parser = new FireWaterParser();
    const frames = parser.push(encodeFireWaterFrame([Math.PI, -1.5]), 3_000);

    expect(frames[0]?.values[0]).toBeCloseTo(Math.PI, 4);
    expect(frames[0]?.values[1]).toBe(-1.5);
  });
});

describe("JustFloatParser", () => {
  it("处理跨 chunk 的浮点数据和帧尾", () => {
    const parser = new JustFloatParser();
    const bytes = encodeJustFloatFrame([1.25, -8.5, 0.125]);
    const frames = feedInChunks(parser, bytes, [3, 2, 1, 4, 2], 4_000);

    expect(frames).toHaveLength(1);
    expect(frames[0]?.values).toEqual([1.25, -8.5, 0.125]);
  });

  it("连续解析多个帧", () => {
    const parser = new JustFloatParser();
    const first = encodeJustFloatFrame([1, 2]);
    const second = encodeJustFloatFrame([3, 4, 5]);
    const bytes = new Uint8Array(first.length + second.length);
    bytes.set(first);
    bytes.set(second, first.length);

    const frames = parser.push(bytes, 5_000);
    expect(frames.map((frame) => frame.values)).toEqual([
      [1, 2],
      [3, 4, 5],
    ]);
  });

  it("丢弃长度损坏的帧后继续同步", () => {
    const parser = new JustFloatParser();
    const malformed = new Uint8Array([0x12, 0x34, 0x00, 0x00, 0x80, 0x7f]);
    const valid = encodeJustFloatFrame([42]);
    const bytes = new Uint8Array(malformed.length + valid.length);
    bytes.set(malformed);
    bytes.set(valid, malformed.length);

    const frames = parser.push(bytes, 6_000);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.values).toEqual([42]);
  });
});

function feedInChunks(
  parser: FireWaterParser | JustFloatParser,
  bytes: Uint8Array,
  chunkSizes: number[],
  timestamp: number,
) {
  const frames = [];
  let offset = 0;
  let chunkIndex = 0;
  while (offset < bytes.length) {
    const size = chunkSizes[chunkIndex % chunkSizes.length] ?? 1;
    frames.push(...parser.push(bytes.slice(offset, offset + size), timestamp));
    offset += size;
    chunkIndex += 1;
  }
  return frames;
}
