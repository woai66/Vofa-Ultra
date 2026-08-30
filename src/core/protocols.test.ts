import { describe, expect, it } from "vitest";
import { PROTOCOL_IDS, type ProtocolKind } from "../types/serial";
import type { ParsedFrame, ProtocolHealthSnapshot } from "../types/workbench";
import {
  BUILTIN_PROTOCOLS,
  createProtocolParser,
  encodeFireWaterFrame,
  encodeJustFloatFrame,
  FireWaterParser,
  getProtocolDefinition,
  incrementProtocolHealthCount,
  JustFloatParser,
  MAX_PROTOCOL_CHANNELS,
  MAX_PROTOCOL_HEALTH_COUNT,
  MAX_PROTOCOL_LABEL_LENGTH,
  PROTOCOL_REGISTRY,
  protocolSupportsReplaySeek,
  type ProtocolParser,
} from "./protocols";

type StructuredProtocolKind = Exclude<ProtocolKind, "raw">;

interface StructuredProtocolFixture {
  readonly values: readonly number[];
  readonly malformedInput: Uint8Array;
  readonly oversizedInput: Uint8Array;
  readonly recoveryBoundary: Uint8Array;
  encode(values: readonly number[]): Uint8Array;
}

type StructuredProtocolFixtures = {
  readonly [Protocol in StructuredProtocolKind]: StructuredProtocolFixture & {
    readonly id: Protocol;
  };
};

const STRUCTURED_PROTOCOL_FIXTURES = {
  firewater: {
    id: "firewater",
    values: [1.25, -2, 3],
    malformedInput: new TextEncoder().encode("broken\n"),
    oversizedInput: new TextEncoder().encode("9".repeat(20 * 1024)),
    recoveryBoundary: new TextEncoder().encode("\n"),
    encode: encodeFireWaterFrame,
  },
  justfloat: {
    id: "justfloat",
    values: [1.25, -2, 3],
    malformedInput: new Uint8Array([
      0x01, 0x00, 0xc0, 0x7f, 0x00, 0x00, 0x80, 0x7f,
    ]),
    oversizedInput: new Uint8Array(80).fill(1),
    recoveryBoundary: new Uint8Array([0x00, 0x00, 0x80, 0x7f]),
    encode: encodeJustFloatFrame,
  },
} as const satisfies StructuredProtocolFixtures;

const STRUCTURED_CASES = Object.values(STRUCTURED_PROTOCOL_FIXTURES);

describe("FireWaterParser", () => {
  it("解析被任意分包的多帧数据", () => {
    const parser = new FireWaterParser();
    const bytes = new TextEncoder().encode("1.25,-2,3\n4,5,6\r\n");
    const frames = feedInChunks(parser, bytes, [1, 2, 5, 3, 7], 1_000);

    expect(frames).toHaveLength(2);
    expect(frames[0]?.values).toEqual([1.25, -2, 3]);
    expect(frames[1]?.values).toEqual([4, 5, 6]);
    expect(parser.getHealthSnapshot()).toMatchObject({
      acceptedFrames: 2,
      droppedFrames: 0,
      resyncCount: 0,
    });
  });

  it("保留对齐的命名通道并跳过损坏行", () => {
    const parser = new FireWaterParser();
    const frames = parser.push(
      new TextEncoder().encode(
        "temp:23.5,voltage:3.3\nbroken,1\ncurrent:0.42\na:b:1\n",
      ),
      2_000,
    );

    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ labels: ["temp", "voltage"], values: [23.5, 3.3] });
    expect(frames[1]).toMatchObject({ labels: ["current"], values: [0.42] });
    expect(parser.getHealthSnapshot()).toMatchObject({
      acceptedFrames: 2,
      droppedFrames: 2,
      reasonCounts: {
        "invalid-format": 1,
        "non-finite-value": 1,
      },
      lastDropReason: "invalid-format",
      lastDropAt: 2_000,
    });
  });

  it("解析等号命名通道并在所有单切点保持一致", () => {
    const bytes = new TextEncoder().encode("yaw=1.234 pitch=0.567,cur=0.8\n");

    for (let split = 0; split <= bytes.length; split += 1) {
      const parser = new FireWaterParser();
      const frames = [
        ...parser.push(bytes.slice(0, split), 2_100),
        ...parser.push(bytes.slice(split), 2_100),
      ];

      expect(frames, `split=${split}`).toEqual([
        {
          labels: ["yaw", "pitch", "cur"],
          values: [1.234, 0.567, 0.8],
          timestamp: 2_100,
        },
      ]);
      expect(parser.getHealthSnapshot()).toMatchObject({
        acceptedFrames: 1,
        droppedFrames: 0,
      });
    }
  });

  it("拒绝重复、混用或缺失的命名分隔符并在后续行恢复", () => {
    const parser = new FireWaterParser();
    const frames = parser.push(
      new TextEncoder().encode(
        "a=1=2\na:1 b=2\n=1\na=\na=b:1\nvalid=3\n",
      ),
      2_200,
    );

    expect(frames).toEqual([
      { labels: ["valid"], values: [3], timestamp: 2_200 },
    ]);
    expect(parser.getHealthSnapshot()).toMatchObject({
      acceptedFrames: 1,
      droppedFrames: 5,
      reasonCounts: { "invalid-format": 5 },
      lastDropReason: "invalid-format",
    });
  });

  it("拒绝超出通道、标签和有限数值边界的行", () => {
    const parser = new FireWaterParser();
    const tooManyValues = Array.from(
      { length: MAX_PROTOCOL_CHANNELS + 1 },
      (_, index) => index,
    ).join(",");
    const longLabel = "x".repeat(MAX_PROTOCOL_LABEL_LENGTH + 1);
    const bytes = new TextEncoder().encode(
      `${tooManyValues}\n${longLabel}=1\nbad\u0085label:1\nNaN,1\nInfinity,2\n1,2\n`,
    );

    expect(parser.push(bytes, 2_500).map((frame) => frame.values)).toEqual([[1, 2]]);
    expect(parser.getHealthSnapshot()).toMatchObject({
      acceptedFrames: 1,
      droppedFrames: 5,
      reasonCounts: {
        "too-many-channels": 1,
        "invalid-label": 2,
        "non-finite-value": 2,
      },
    });
  });

  it("拒绝空逗号字段而不是把它静默转换为零", () => {
    const parser = new FireWaterParser();

    expect(parser.push(new TextEncoder().encode(",1\n1,,2\n1,\n"), 2_550)).toEqual([]);
    expect(parser.getHealthSnapshot()).toMatchObject({
      acceptedFrames: 0,
      droppedFrames: 3,
      reasonCounts: { "invalid-format": 3 },
      lastDropReason: "invalid-format",
    });
  });

  it("丢弃超长未闭合行并在下一个换行后恢复", () => {
    const parser = new FireWaterParser();
    const oversized = new TextEncoder().encode("9".repeat(20 * 1024));

    expect(parser.push(oversized, 2_600)).toEqual([]);
    expect(parser.getHealthSnapshot()).toMatchObject({
      droppedFrames: 1,
      resyncCount: 0,
      lastDropReason: "unit-too-long",
    });
    expect(
      parser.push(concatBytes(new TextEncoder().encode("\n"), encodeFireWaterFrame([42])), 2_700),
    ).toEqual([{ values: [42], timestamp: 2_700 }]);
    expect(parser.getHealthSnapshot()).toMatchObject({
      acceptedFrames: 1,
      droppedFrames: 1,
      resyncCount: 1,
    });
  });

  it("编码器拒绝无法满足解析契约的帧", () => {
    expect(() => encodeFireWaterFrame([])).toThrow(/1 到 16/);
    expect(() => encodeFireWaterFrame([Number.NaN])).toThrow(/有限数值/);
    expect(() => encodeFireWaterFrame(new Array(17).fill(1))).toThrow(/1 到 16/);
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
    const bytes = concatBytes(
      encodeJustFloatFrame([1, 2]),
      encodeJustFloatFrame([3, 4, 5]),
    );

    expect(parser.push(bytes, 5_000).map((frame) => frame.values)).toEqual([
      [1, 2],
      [3, 4, 5],
    ]);
  });

  it("丢弃长度损坏和非有限帧后继续同步", () => {
    const parser = new JustFloatParser();
    const malformed = new Uint8Array([0x12, 0x34, 0x00, 0x00, 0x80, 0x7f]);
    const notFinite = new Uint8Array([0x01, 0x00, 0xc0, 0x7f, 0x00, 0x00, 0x80, 0x7f]);
    const bytes = concatBytes(malformed, notFinite, encodeJustFloatFrame([42]));

    expect(parser.push(bytes, 6_000)).toEqual([{ values: [42], timestamp: 6_000 }]);
    expect(parser.getHealthSnapshot()).toMatchObject({
      acceptedFrames: 1,
      droppedFrames: 2,
      reasonCounts: {
        "misaligned-length": 1,
        "non-finite-value": 1,
      },
      lastDropReason: "non-finite-value",
    });
  });

  it("保留 16 通道帧的跨 chunk 帧尾", () => {
    const parser = new JustFloatParser();
    const values = Array.from({ length: MAX_PROTOCOL_CHANNELS }, (_, index) => index + 0.5);
    const bytes = encodeJustFloatFrame(values);

    expect(parser.push(bytes.slice(0, -1), 6_100)).toEqual([]);
    expect(parser.push(bytes.slice(-1), 6_200)).toEqual([{ values, timestamp: 6_200 }]);
  });

  it("忽略合法浮点载荷中未对齐的伪帧尾", () => {
    const parser = new JustFloatParser();
    const payload = new Uint8Array([0x01, 0x00, 0x00, 0x80, 0x7f, 0x00, 0x00, 0x00]);
    const frame = concatBytes(payload, new Uint8Array([0x00, 0x00, 0x80, 0x7f]));
    const view = new DataView(payload.buffer);
    const expected = [view.getFloat32(0, true), view.getFloat32(4, true)];

    expect(parser.push(frame.slice(0, 5), 6_250)).toEqual([]);
    expect(parser.push(frame.slice(5), 6_260)).toEqual([
      { values: expected, timestamp: 6_260 },
    ]);
    expect(parser.getHealthSnapshot()).toMatchObject({
      acceptedFrames: 1,
      droppedFrames: 0,
    });
  });

  it("丢弃超长未闭合帧并在下一个帧尾后恢复", () => {
    const parser = new JustFloatParser();

    expect(parser.push(new Uint8Array(80).fill(1), 6_300)).toEqual([]);
    expect(parser.getHealthSnapshot()).toMatchObject({
      droppedFrames: 1,
      resyncCount: 0,
      lastDropReason: "unit-too-long",
    });
    expect(
      parser.push(
        concatBytes(
          new Uint8Array([0x00, 0x00, 0x80, 0x7f]),
          encodeJustFloatFrame([7]),
        ),
        6_400,
      ),
    ).toEqual([{ values: [7], timestamp: 6_400 }]);
    expect(parser.getHealthSnapshot()).toMatchObject({
      acceptedFrames: 1,
      droppedFrames: 1,
      resyncCount: 1,
    });
  });

  it("编码器拒绝无法满足解析契约的帧", () => {
    expect(() => encodeJustFloatFrame([])).toThrow(/1 到 16/);
    expect(() => encodeJustFloatFrame([Number.POSITIVE_INFINITY])).toThrow(/有限数值/);
    expect(() => encodeJustFloatFrame([Number.MAX_VALUE])).toThrow(/float32/);
    expect(() => encodeJustFloatFrame(new Array(17).fill(1))).toThrow(/1 到 16/);
  });
});

describe("内置协议贡献契约", () => {
  it("注册表完整、顺序稳定且回放定位能力显式声明", () => {
    expect(BUILTIN_PROTOCOLS.map(({ id }) => id)).toEqual(PROTOCOL_IDS);
    expect(Object.keys(PROTOCOL_REGISTRY)).toEqual(PROTOCOL_IDS);
    expect(protocolSupportsReplaySeek("raw")).toBe(true);
    expect(protocolSupportsReplaySeek("firewater")).toBe(true);
    expect(protocolSupportsReplaySeek("justfloat")).toBe(true);
    expect(getProtocolDefinition("raw").replaySeekMode).toBe("record-boundary");
    expect(getProtocolDefinition("firewater").replaySeekMode).toBe("protocol-boundary");
    expect(getProtocolDefinition("justfloat").replaySeekMode).toBe("protocol-boundary");
    expect(getProtocolDefinition("raw").encodeSimulatorSample).toBeUndefined();
    expect(getProtocolDefinition("firewater").encodeSimulatorSample).toBeTypeOf("function");
    expect(getProtocolDefinition("justfloat").encodeSimulatorSample).toBeTypeOf("function");

    for (const definition of BUILTIN_PROTOCOLS) {
      expect(definition).toBe(getProtocolDefinition(definition.id));
      expect(definition.displayName).not.toBe("");
      expect(definition.description).not.toBe("");
      expect(definition.createParser()).not.toBe(definition.createParser());
    }
  });

  it.each(STRUCTURED_CASES)("$id 在所有单切点产生相同结果", ({ id, values, encode }) => {
    const bytes = encode(values);
    for (let split = 0; split <= bytes.length; split += 1) {
      const parser = createProtocolParser(id);
      const frames = [
        ...parser.push(bytes.slice(0, split), 7_000),
        ...parser.push(bytes.slice(split), 7_100),
      ];

      expect(frames, `split=${split}`).toEqual([
        {
          values: [...values],
          timestamp: split === bytes.length ? 7_000 : 7_100,
        },
      ]);
    }
  });

  it.each(STRUCTURED_CASES)("$id 支持逐字节和固定种子随机分包", ({ id, values, encode }) => {
    const bytes = encode(values);
    const bytewise = feedInChunks(createProtocolParser(id), bytes, [1], 7_200);
    const randomized = feedInChunks(
      createProtocolParser(id),
      bytes,
      seededChunkSizes(bytes.length, 0x5eed),
      7_300,
    );

    expect(bytewise).toEqual([{ values: [...values], timestamp: 7_200 }]);
    expect(randomized).toEqual([{ values: [...values], timestamp: 7_300 }]);
  });

  it.each(STRUCTURED_CASES)("$id 的同批多帧保留读取块时间戳", ({ id, values, encode }) => {
    const parser = createProtocolParser(id);
    const frames = parser.push(concatBytes(encode(values), encode(values)), 7_350);

    expect(frames).toHaveLength(2);
    expect(frames.map((frame) => frame.timestamp)).toEqual([7_350, 7_350]);
  });

  it.each(STRUCTURED_CASES)("$id 的 reset 幂等且实例残片相互隔离", ({ id, values, encode }) => {
    const bytes = encode(values);
    const split = bytes.length - 1;
    const first = createProtocolParser(id);
    const second = createProtocolParser(id);

    expect(first.push(bytes.slice(0, split), 7_400)).toEqual([]);
    expect(second.push(bytes, 7_500)).toEqual([{ values: [...values], timestamp: 7_500 }]);
    expect(first.push(bytes.slice(split), 7_600)).toEqual([
      { values: [...values], timestamp: 7_600 },
    ]);

    first.push(bytes.slice(0, split), 7_700);
    first.reset();
    first.reset();
    expect(first.push(bytes.slice(split), 7_800)).toEqual([]);
    first.reset();
    expect(first.push(bytes, 7_900)).toEqual([{ values: [...values], timestamp: 7_900 }]);
  });

  it.each(STRUCTURED_CASES)(
    "$id 丢弃损坏与超长单元后在同步边界恢复",
    ({ id, values, malformedInput, oversizedInput, recoveryBoundary, encode }) => {
      const parser = createProtocolParser(id);

      expect(parser.push(malformedInput, 7_950)).toEqual([]);
      expect(parser.push(encode(values), 7_960)).toEqual([
        { values: [...values], timestamp: 7_960 },
      ]);

      parser.reset();
      expect(parser.push(oversizedInput, 7_970)).toEqual([]);
      expect(parser.push(concatBytes(recoveryBoundary, encode(values)), 7_980)).toEqual([
        { values: [...values], timestamp: 7_980 },
      ]);
    },
  );

  it.each(STRUCTURED_CASES)(
    "$id 的诊断计数不受任意单切点影响",
    ({ id, values, malformedInput, oversizedInput, recoveryBoundary, encode }) => {
      const bytes = concatBytes(
        malformedInput,
        oversizedInput,
        recoveryBoundary,
        encode(values),
      );
      const baseline = createProtocolParser(id);
      baseline.push(bytes, 7_990);
      const expectedHealth = baseline.getHealthSnapshot();

      expect(expectedHealth).toMatchObject({
        acceptedFrames: 1,
        droppedFrames: 2,
        resyncCount: 1,
      });
      for (let split = 0; split <= bytes.length; split += 1) {
        const parser = createProtocolParser(id);
        parser.push(bytes.slice(0, split), 7_990);
        parser.push(bytes.slice(split), 7_990);
        expect(parser.getHealthSnapshot(), `split=${split}`).toEqual(expectedHealth);
      }
    },
  );

  it.each(STRUCTURED_CASES)(
    "$id 的 clearHealth 保留半帧，reset 同时清空半帧与诊断",
    ({ id, values, malformedInput, encode }) => {
      const parser = createProtocolParser(id);
      const valid = encode(values);
      const split = valid.length - 1;

      parser.push(malformedInput, 8_000);
      parser.push(valid.slice(0, split), 8_010);
      expect(parser.getHealthSnapshot().droppedFrames).toBe(1);

      parser.clearHealth();
      expectEmptyProtocolHealth(parser.getHealthSnapshot());
      expect(parser.push(valid.slice(split), 8_020)).toEqual([
        { values: [...values], timestamp: 8_020 },
      ]);
      expect(parser.getHealthSnapshot().acceptedFrames).toBe(1);

      parser.push(valid.slice(0, split), 8_030);
      parser.reset();
      expectEmptyProtocolHealth(parser.getHealthSnapshot());
      expect(parser.push(valid.slice(split), 8_040)).toEqual([]);
    },
  );

  it.each(STRUCTURED_CASES)(
    "$id 在诊断未变化时复用只读快照",
    ({ id, values, encode }) => {
      const parser = createProtocolParser(id);
      const bytes = encode(values);
      const initial = parser.getHealthSnapshot();

      expect(Object.isFrozen(initial)).toBe(true);
      expect(Object.isFrozen(initial.reasonCounts)).toBe(true);
      expect(parser.getHealthSnapshot()).toBe(initial);
      expect(parser.push(bytes.slice(0, -1), 8_045)).toEqual([]);
      expect(parser.getHealthSnapshot()).toBe(initial);

      expect(parser.push(bytes.slice(-1), 8_046)).toHaveLength(1);
      const accepted = parser.getHealthSnapshot();
      expect(accepted).not.toBe(initial);
      expect(accepted.acceptedFrames).toBe(1);
      expect(parser.getHealthSnapshot()).toBe(accepted);
    },
  );

  it("Raw Data 的健康状态始终为空且操作幂等", () => {
    const parser = createProtocolParser("raw");
    const health = parser.getHealthSnapshot();

    expect(parser.push(seededBytes(128, 0x1234), 8_050)).toEqual([]);
    expectEmptyProtocolHealth(parser.getHealthSnapshot());
    expect(parser.getHealthSnapshot()).toBe(health);
    expect(Object.isFrozen(health)).toBe(true);
    expect(Object.isFrozen(health.reasonCounts)).toBe(true);
    parser.clearHealth();
    parser.reset();
    expectEmptyProtocolHealth(parser.getHealthSnapshot());
    expect(parser.getHealthSnapshot()).toBe(health);
  });

  it("健康计数达到 32 位无符号上限后保持饱和", () => {
    expect(incrementProtocolHealthCount(MAX_PROTOCOL_HEALTH_COUNT - 1)).toBe(
      MAX_PROTOCOL_HEALTH_COUNT,
    );
    expect(incrementProtocolHealthCount(MAX_PROTOCOL_HEALTH_COUNT)).toBe(
      MAX_PROTOCOL_HEALTH_COUNT,
    );
  });

  it("所有已声明的模拟器编码器都能由对应解析器消费", () => {
    const supportedProtocols: ProtocolKind[] = [];
    for (const definition of BUILTIN_PROTOCOLS) {
      const encodeSimulatorSample = definition.encodeSimulatorSample;
      if (!encodeSimulatorSample) {
        continue;
      }

      supportedProtocols.push(definition.id);
      const bytes = encodeSimulatorSample([1.5, -2.25, 3], 12);
      const frames = definition.createParser().push(bytes, 8_000);
      expect(frames).toHaveLength(1);
      expectFrameContract(frames[0]);
    }
    expect(supportedProtocols).toEqual(["firewater", "justfloat"]);
  });

  it("固定规模随机字节不抛错，reset 后仍能恢复", () => {
    const randomBytes = seededBytes(8 * 1024, 0xc0ffee);
    for (const definition of BUILTIN_PROTOCOLS) {
      const parser = definition.createParser();
      const frames = feedInChunks(parser, randomBytes, [1, 7, 31, 127], 8_100);
      frames.forEach(expectFrameContract);

      parser.reset();
      const encodeSimulatorSample = definition.encodeSimulatorSample;
      if (!encodeSimulatorSample) {
        expect(definition.id).toBe("raw");
        continue;
      }

      const recovered = parser.push(encodeSimulatorSample([1, 2, 3], 1), 8_200);
      expect(recovered).toHaveLength(1);
      expectFrameContract(recovered[0]);
    }
  });
});

function feedInChunks(
  parser: ProtocolParser,
  bytes: Uint8Array,
  chunkSizes: readonly number[],
  timestamp: number,
): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
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

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function seededChunkSizes(byteLength: number, seed: number): number[] {
  const sizes: number[] = [];
  let state = seed >>> 0;
  let remaining = byteLength;
  while (remaining > 0) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const size = Math.min(remaining, (state % 7) + 1);
    sizes.push(size);
    remaining -= size;
  }
  return sizes;
}

function seededBytes(byteLength: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  let state = seed >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

function expectFrameContract(frame: ParsedFrame | undefined): void {
  expect(frame).toBeDefined();
  if (!frame) {
    return;
  }
  expect(frame.values.length).toBeGreaterThan(0);
  expect(frame.values.length).toBeLessThanOrEqual(MAX_PROTOCOL_CHANNELS);
  expect(frame.values.every(Number.isFinite)).toBe(true);
  expect(Number.isFinite(frame.timestamp)).toBe(true);
  if (frame.labels) {
    expect(frame.labels).toHaveLength(frame.values.length);
    expect(
      frame.labels.every(
        (label) => label === "" || label.length <= MAX_PROTOCOL_LABEL_LENGTH,
      ),
    ).toBe(true);
  }
}

function expectEmptyProtocolHealth(snapshot: ProtocolHealthSnapshot): void {
  expect(snapshot).toMatchObject({
    acceptedFrames: 0,
    droppedFrames: 0,
    resyncCount: 0,
    lastDropReason: null,
    lastDropAt: null,
  });
  expect(Object.values(snapshot.reasonCounts).every((count) => count === 0)).toBe(true);
}
