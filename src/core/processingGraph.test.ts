import { describe, expect, it } from "vitest";
import type { ProcessingGraphConfig, ProcessingNode } from "../types/processingGraph";
import {
  cloneProcessingGraph,
  compileProcessingGraph,
  createDefaultProcessingGraph,
  MAX_PROCESSING_EVALUATIONS_PER_BATCH,
  parseLegacyProcessingGraphConfig,
  parseProcessingGraphConfig,
  ProcessingGraphRuntime,
  processingOutputChannelId,
} from "./processingGraph";

function outputValues(runtime: ProcessingGraphRuntime, values: number[], timestamp = 1): number[] {
  return runtime.process([{ values, timestamp }]).map((sample) => sample.value);
}

function singleOutputGraph(nodes: ProcessingNode[]): ProcessingGraphConfig {
  return {
    enabled: true,
    nodes: [
      ...nodes,
      {
        id: "result",
        kind: "output",
        input: nodes.at(-1)?.id ?? "source",
        name: "结果",
        color: "#12abef",
      },
    ],
  };
}

describe("处理图配置", () => {
  it("创建禁用的默认配置并执行深克隆", () => {
    const source: ProcessingGraphConfig = {
      enabled: true,
      nodes: [
        { id: "source", kind: "input", channelIndex: 0 },
        {
          id: "result",
          kind: "output",
          input: "source",
          name: "原始值",
          color: "#ABCDEF",
        },
      ],
    };
    const cloned = cloneProcessingGraph(source);
    cloned.enabled = false;
    cloned.nodes[0] = { id: "other", kind: "input", channelIndex: 1 };

    expect(createDefaultProcessingGraph()).toEqual({ enabled: false, nodes: [] });
    expect(source.enabled).toBe(true);
    expect(source.nodes[0]?.id).toBe("source");
    expect(cloned).not.toBe(source);
    expect(cloned.nodes).not.toBe(source.nodes);
  });

  it("严格解析字段并返回规范化的独立配置", () => {
    const value = {
      enabled: true,
      nodes: [
        { id: "source", kind: "input", channelIndex: 0 },
        {
          id: "result",
          kind: "output",
          input: "source",
          name: "  温度  ",
          color: "#AABBCC",
        },
      ],
    };
    const parsed = parseProcessingGraphConfig(value);

    expect(parsed.nodes[1]).toMatchObject({ name: "温度", color: "#aabbcc" });
    expect(parsed).not.toBe(value);
    expect(parsed.nodes).not.toBe(value.nodes);
    expect(() => parseProcessingGraphConfig({ ...value, extra: true })).toThrow("未知字段");
    expect(() =>
      parseProcessingGraphConfig({
        ...value,
        nodes: [{ id: "source", kind: "input", channelIndex: 0, extra: true }],
      }),
    ).toThrow("未知字段");
    expect(() =>
      parseProcessingGraphConfig({ enabled: true, nodes: [{ id: "source", kind: "input" }] }),
    ).toThrow("缺少字段");
  });

  it("即使配置禁用也完整校验并保持运行时无副作用", () => {
    expect(() =>
      compileProcessingGraph({
        enabled: false,
        nodes: [{ id: "bad id", kind: "input", channelIndex: 0 }],
      }),
    ).toThrow("节点 ID");

    const runtime = new ProcessingGraphRuntime({
      enabled: false,
      nodes: [{ id: "source", kind: "input", channelIndex: 0 }],
    });
    expect(runtime.process([{ values: [1], timestamp: 10 }])).toEqual([]);
    expect(runtime.getSnapshot()).toEqual({
      status: "disabled",
      processedFrames: 0,
      droppedFrames: 0,
    });
  });

  it("编译结果深冻结且输出通道 ID 稳定隔离", () => {
    const compiled = compileProcessingGraph(
      singleOutputGraph([{ id: "source", kind: "input", channelIndex: 0 }]),
    );

    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.config)).toBe(true);
    expect(Object.isFrozen(compiled.config.nodes)).toBe(true);
    expect(Object.isFrozen(compiled.config.nodes[0])).toBe(true);
    expect(compiled.outputs[0]?.channelId).toBe("derived:result");
    expect(processingOutputChannelId("result")).toBe("derived:result");
    expect(() => processingOutputChannelId("bad id")).toThrow("输出节点 ID");
  });

  it("深克隆并冻结字节输入列表，同时让旧 parser 拒绝新节点", () => {
    const sourceInputs = ["high", "low"];
    const config: ProcessingGraphConfig = {
      enabled: true,
      nodes: [
        { id: "high", kind: "input", channelIndex: 0 },
        { id: "low", kind: "input", channelIndex: 1 },
        {
          id: "decoded",
          kind: "bytes_to_number",
          inputs: sourceInputs,
          numericType: "u16",
          endianness: "be",
        },
      ],
    };
    const cloned = cloneProcessingGraph(config);
    const compiled = compileProcessingGraph(config);
    const clonedInputs = cloned.nodes[2]?.kind === "bytes_to_number"
      ? cloned.nodes[2].inputs
      : [];
    const compiledInputs = compiled.config.nodes[2]?.kind === "bytes_to_number"
      ? compiled.config.nodes[2].inputs
      : [];

    sourceInputs[0] = "low";
    expect(clonedInputs).toEqual(["high", "low"]);
    expect(compiledInputs).toEqual(["high", "low"]);
    expect(Object.isFrozen(compiledInputs)).toBe(true);
    expect(() => parseLegacyProcessingGraphConfig(config)).toThrow("kind");
  });
});

describe("处理图编译", () => {
  it("支持前向引用并使用稳定拓扑顺序", () => {
    const compiled = compileProcessingGraph({
      enabled: true,
      nodes: [
        {
          id: "result",
          kind: "output",
          input: "scaled",
          name: "结果",
          color: "#123456",
        },
        { id: "unrelated", kind: "input", channelIndex: 1 },
        { id: "scaled", kind: "affine", input: "source", gain: 2, offset: 1 },
        { id: "source", kind: "input", channelIndex: 0 },
      ],
    });

    expect(compiled.evaluationOrder).toEqual(["unrelated", "source", "scaled", "result"]);
    expect(outputValues(new ProcessingGraphRuntime(compiled), [2, 9])).toEqual([5]);
  });

  it("稳定 Kahn 队列不会让新就绪节点越过已排队节点", () => {
    const compiled = compileProcessingGraph({
      enabled: true,
      nodes: [
        { id: "scaled", kind: "affine", input: "source", gain: 1, offset: 0 },
        { id: "source", kind: "input", channelIndex: 0 },
        { id: "independent", kind: "input", channelIndex: 1 },
      ],
    });

    expect(compiled.evaluationOrder).toEqual(["source", "independent", "scaled"]);
  });

  it("拒绝重复、未知、自引用、输出依赖和环", () => {
    expect(() =>
      compileProcessingGraph({
        enabled: true,
        nodes: [
          { id: "same", kind: "input", channelIndex: 0 },
          { id: "same", kind: "input", channelIndex: 1 },
        ],
      }),
    ).toThrow("重复节点 ID");
    expect(() =>
      compileProcessingGraph(
        singleOutputGraph([{ id: "scale", kind: "affine", input: "missing", gain: 1, offset: 0 }]),
      ),
    ).toThrow("未知节点");
    expect(() =>
      compileProcessingGraph(
        singleOutputGraph([{ id: "self", kind: "affine", input: "self", gain: 1, offset: 0 }]),
      ),
    ).toThrow("不能引用自身");
    expect(() =>
      compileProcessingGraph({
        enabled: true,
        nodes: [
          { id: "a", kind: "affine", input: "b", gain: 1, offset: 0 },
          { id: "b", kind: "affine", input: "a", gain: 1, offset: 0 },
        ],
      }),
    ).toThrow("存在循环");
    expect(() =>
      compileProcessingGraph({
        enabled: true,
        nodes: [
          { id: "source", kind: "input", channelIndex: 0 },
          {
            id: "published",
            kind: "output",
            input: "source",
            name: "输出",
            color: "#123456",
          },
          { id: "invalid", kind: "affine", input: "published", gain: 1, offset: 0 },
        ],
      }),
    ).toThrow("不能依赖输出节点");
  });

  it("拒绝非法节点参数、名称、颜色和运算", () => {
    const invalidNodes: ProcessingNode[] = [
      { id: "source", kind: "input", channelIndex: 16 },
      { id: "gain", kind: "affine", input: "source", gain: Number.POSITIVE_INFINITY, offset: 0 },
      { id: "offset", kind: "affine", input: "source", gain: 1, offset: 1e12 + 1 },
      { id: "clamp", kind: "clamp", input: "source", minimum: 2, maximum: 1 },
      { id: "ema", kind: "ema", input: "source", alpha: 0 },
      { id: "average", kind: "moving_average", input: "source", windowSize: 257 },
    ];
    for (const node of invalidNodes) {
      expect(() => compileProcessingGraph({ enabled: true, nodes: [node] })).toThrow();
    }

    expect(() =>
      compileProcessingGraph({
        enabled: true,
        nodes: [
          { id: "source", kind: "input", channelIndex: 0 },
          { id: "result", kind: "output", input: "source", name: "", color: "#123456" },
        ],
      }),
    ).toThrow("名称无效");
    expect(() =>
      compileProcessingGraph({
        enabled: true,
        nodes: [
          { id: "source", kind: "input", channelIndex: 0 },
          {
            id: "result",
            kind: "output",
            input: "source",
            name: ` ${"x".repeat(64)}`,
            color: "#123456",
          },
        ],
      }),
    ).toThrow("名称无效");
    expect(() =>
      compileProcessingGraph({
        enabled: true,
        nodes: [
          { id: "source", kind: "input", channelIndex: 0 },
          { id: "result", kind: "output", input: "source", name: "值", color: "red" },
        ],
      }),
    ).toThrow("#RRGGBB");
    expect(() =>
      parseProcessingGraphConfig({
        enabled: true,
        nodes: [{ id: "math", kind: "math", left: "a", right: "b", operation: "power" }],
      }),
    ).toThrow("operation");

    expect(() =>
      compileProcessingGraph({
        enabled: true,
        nodes: [
          { id: "source", kind: "input", channelIndex: 0 },
          {
            id: "decoded",
            kind: "bytes_to_number",
            inputs: ["source"],
            numericType: "u16",
            endianness: "le",
          },
        ],
      }),
    ).toThrow("输入数量必须为 2");
    expect(() =>
      compileProcessingGraph({
        enabled: true,
        nodes: [
          { id: "source", kind: "input", channelIndex: 0 },
          {
            id: "encoded",
            kind: "number_to_byte",
            input: "source",
            numericType: "u16",
            endianness: "le",
            byteIndex: 2,
          },
        ],
      }),
    ).toThrow("字节索引必须在 0 到 1 之间");
  });

  it("执行节点数、输出数和移动窗口总容量上限", () => {
    const tooManyNodes: ProcessingNode[] = Array.from({ length: 65 }, (_, index) => ({
      id: `input-${index}`,
      kind: "input",
      channelIndex: index % 16,
    }));
    expect(() => compileProcessingGraph({ enabled: true, nodes: tooManyNodes })).toThrow("64");

    const tooManyOutputs: ProcessingNode[] = [{ id: "source", kind: "input", channelIndex: 0 }];
    for (let index = 0; index < 17; index += 1) {
      tooManyOutputs.push({
        id: `output-${index}`,
        kind: "output",
        input: "source",
        name: `输出 ${index}`,
        color: "#123456",
      });
    }
    expect(() => compileProcessingGraph({ enabled: true, nodes: tooManyOutputs })).toThrow("16");

    const excessiveWindows: ProcessingNode[] = [{ id: "source", kind: "input", channelIndex: 0 }];
    for (let index = 0; index < 33; index += 1) {
      excessiveWindows.push({
        id: `average-${index}`,
        kind: "moving_average",
        input: "source",
        windowSize: 256,
      });
    }
    expect(() => compileProcessingGraph({ enabled: true, nodes: excessiveWindows })).toThrow("8192");
  });
});

describe("处理图运行时", () => {
  it("在单帧内完成字节与数值双向转换", () => {
    const runtime = new ProcessingGraphRuntime({
      enabled: true,
      nodes: [
        { id: "low", kind: "input", channelIndex: 0 },
        { id: "high", kind: "input", channelIndex: 1 },
        { id: "number", kind: "input", channelIndex: 2 },
        {
          id: "decoded",
          kind: "bytes_to_number",
          inputs: ["low", "high"],
          numericType: "u16",
          endianness: "le",
        },
        {
          id: "encoded-low",
          kind: "number_to_byte",
          input: "number",
          numericType: "u16",
          endianness: "le",
          byteIndex: 0,
        },
        {
          id: "encoded-high",
          kind: "number_to_byte",
          input: "number",
          numericType: "u16",
          endianness: "le",
          byteIndex: 1,
        },
        { id: "out-number", kind: "output", input: "decoded", name: "数值", color: "#111111" },
        { id: "out-low", kind: "output", input: "encoded-low", name: "低字节", color: "#222222" },
        { id: "out-high", kind: "output", input: "encoded-high", name: "高字节", color: "#333333" },
      ],
    });

    expect(outputValues(runtime, [0x34, 0x12, 0xabcd])).toEqual([0x1234, 0xcd, 0xab]);
  });

  it("不跨帧拼接字节，非法输入只让受影响输出形成 gap", () => {
    const runtime = new ProcessingGraphRuntime({
      enabled: true,
      nodes: [
        { id: "first", kind: "input", channelIndex: 0 },
        { id: "second", kind: "input", channelIndex: 1 },
        { id: "number", kind: "input", channelIndex: 2 },
        { id: "stable", kind: "input", channelIndex: 3 },
        {
          id: "decoded",
          kind: "bytes_to_number",
          inputs: ["first", "second"],
          numericType: "u16",
          endianness: "be",
        },
        {
          id: "encoded",
          kind: "number_to_byte",
          input: "number",
          numericType: "u16",
          endianness: "be",
          byteIndex: 0,
        },
        { id: "out-decoded", kind: "output", input: "decoded", name: "解码", color: "#111111" },
        { id: "out-encoded", kind: "output", input: "encoded", name: "编码", color: "#222222" },
        { id: "out-stable", kind: "output", input: "stable", name: "稳定", color: "#333333" },
      ],
    });

    const samples = runtime.process([
      { values: [0x12, Number.NaN, 1.5, 7], timestamp: 1 },
      { values: [256, 0x34, 65_536, 8], timestamp: 2 },
    ]);

    expect(samples.map((sample) => [sample.value, sample.frameIndex])).toEqual([
      [7, 0],
      [8, 1],
    ]);
    expect(runtime.getSnapshot()).toMatchObject({ status: "ready", processedFrames: 2 });
  });

  it("执行 affine、clamp 与四种数学节点", () => {
    const runtime = new ProcessingGraphRuntime({
      enabled: true,
      nodes: [
        { id: "left", kind: "input", channelIndex: 0 },
        { id: "right", kind: "input", channelIndex: 1 },
        { id: "scaled", kind: "affine", input: "left", gain: 3, offset: 1 },
        { id: "limited", kind: "clamp", input: "scaled", minimum: -5, maximum: 10 },
        { id: "add", kind: "math", left: "limited", right: "right", operation: "add" },
        { id: "subtract", kind: "math", left: "limited", right: "right", operation: "subtract" },
        { id: "multiply", kind: "math", left: "limited", right: "right", operation: "multiply" },
        { id: "divide", kind: "math", left: "limited", right: "right", operation: "divide" },
        { id: "out-add", kind: "output", input: "add", name: "加", color: "#111111" },
        { id: "out-sub", kind: "output", input: "subtract", name: "减", color: "#222222" },
        { id: "out-mul", kind: "output", input: "multiply", name: "乘", color: "#333333" },
        { id: "out-div", kind: "output", input: "divide", name: "除", color: "#444444" },
      ],
    });

    const samples = runtime.process([{ values: [4, 2], timestamp: 99 }]);
    expect(samples.map((sample) => sample.value)).toEqual([12, 8, 20, 5]);
    expect(samples.map((sample) => sample.timestamp)).toEqual([99, 99, 99, 99]);
    expect(samples.map((sample) => sample.frameIndex)).toEqual([0, 0, 0, 0]);
  });

  it("为同一批中时间戳相同的帧保留独立帧序号", () => {
    const runtime = new ProcessingGraphRuntime({
      enabled: true,
      nodes: [
        { id: "source", kind: "input", channelIndex: 0 },
        { id: "output", kind: "output", input: "source", name: "输出", color: "#123456" },
      ],
    });

    const samples = runtime.process([
      { values: [1], timestamp: 99 },
      { values: [2], timestamp: 99 },
    ]);

    expect(samples.map((sample) => [sample.value, sample.frameIndex])).toEqual([
      [1, 0],
      [2, 1],
    ]);
  });

  it("跨批维护 EMA 与移动平均状态，并在 gap 时不更新", () => {
    const compiled = compileProcessingGraph({
      enabled: true,
      nodes: [
        { id: "source", kind: "input", channelIndex: 0 },
        { id: "ema", kind: "ema", input: "source", alpha: 0.5 },
        { id: "average", kind: "moving_average", input: "source", windowSize: 3 },
        { id: "out-ema", kind: "output", input: "ema", name: "EMA", color: "#123456" },
        { id: "out-average", kind: "output", input: "average", name: "平均", color: "#654321" },
      ],
    });
    const live = new ProcessingGraphRuntime(compiled);
    const replay = new ProcessingGraphRuntime(compiled);

    expect(outputValues(live, [2], 1)).toEqual([2, 2]);
    expect(outputValues(live, [4], 2)).toEqual([3, 3]);
    expect(outputValues(live, [], 3)).toEqual([]);
    expect(outputValues(live, [Number.NaN], 4)).toEqual([]);
    expect(outputValues(live, [6], 5)).toEqual([4.5, 4]);
    expect(outputValues(replay, [10], 6)).toEqual([10, 10]);
    live.reset();
    expect(outputValues(live, [10], 7)).toEqual([10, 10]);
  });

  it("除零和非有限中间结果只让受影响输出形成 gap", () => {
    const runtime = new ProcessingGraphRuntime({
      enabled: true,
      nodes: [
        { id: "left", kind: "input", channelIndex: 0 },
        { id: "right", kind: "input", channelIndex: 1 },
        { id: "divide", kind: "math", left: "left", right: "right", operation: "divide" },
        { id: "overflow", kind: "affine", input: "left", gain: 1e12, offset: 0 },
        { id: "valid", kind: "output", input: "right", name: "有效", color: "#111111" },
        { id: "divided", kind: "output", input: "divide", name: "除法", color: "#222222" },
        { id: "large", kind: "output", input: "overflow", name: "溢出", color: "#333333" },
      ],
    });

    const samples = runtime.process([{ values: [Number.MAX_VALUE, 0], timestamp: 1 }]);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ outputId: "valid", value: 0 });
    expect(runtime.getSnapshot()).toMatchObject({ status: "ready", processedFrames: 1 });
  });

  it("非有限上游不会污染滤波状态", () => {
    const runtime = new ProcessingGraphRuntime({
      enabled: true,
      nodes: [
        { id: "source", kind: "input", channelIndex: 0 },
        { id: "scaled", kind: "affine", input: "source", gain: 1e12, offset: 0 },
        { id: "ema", kind: "ema", input: "scaled", alpha: 0.5 },
        { id: "average", kind: "moving_average", input: "scaled", windowSize: 2 },
        { id: "out-ema", kind: "output", input: "ema", name: "EMA", color: "#111111" },
        { id: "out-average", kind: "output", input: "average", name: "平均", color: "#222222" },
      ],
    });

    expect(outputValues(runtime, [Number.MAX_VALUE], 1)).toEqual([]);
    expect(outputValues(runtime, [2], 2)).toEqual([2e12, 2e12]);
  });

  it("移动平均求和溢出时不写入窗口", () => {
    const runtime = new ProcessingGraphRuntime({
      enabled: true,
      nodes: [
        { id: "source", kind: "input", channelIndex: 0 },
        { id: "average", kind: "moving_average", input: "source", windowSize: 2 },
        { id: "result", kind: "output", input: "average", name: "平均", color: "#123456" },
      ],
    });

    expect(outputValues(runtime, [Number.MAX_VALUE], 1)).toEqual([Number.MAX_VALUE]);
    expect(outputValues(runtime, [Number.MAX_VALUE], 2)).toEqual([]);
    expect(outputValues(runtime, [0], 3)).toEqual([Number.MAX_VALUE / 2]);
  });

  it("批次预算超限后熔断，reset 后恢复并清空计数", () => {
    const nodes: ProcessingNode[] = [{ id: "source", kind: "input", channelIndex: 0 }];
    let dependency = "source";
    for (let index = 0; index < 62; index += 1) {
      const id = `scale-${index}`;
      nodes.push({ id, kind: "affine", input: dependency, gain: 1, offset: 0 });
      dependency = id;
    }
    nodes.push({
      id: "result",
      kind: "output",
      input: dependency,
      name: "结果",
      color: "#123456",
    });
    const runtime = new ProcessingGraphRuntime({ enabled: true, nodes });
    const frameCount = Math.floor(MAX_PROCESSING_EVALUATIONS_PER_BATCH / nodes.length) + 1;
    const frames = Array.from({ length: frameCount }, (_, timestamp) => ({ values: [1], timestamp }));

    expect(runtime.process(frames)).toEqual([]);
    expect(runtime.getSnapshot()).toMatchObject({
      status: "suspended",
      processedFrames: 0,
      droppedFrames: frameCount,
    });
    expect(runtime.process([{ values: [1], timestamp: 1 }])).toEqual([]);
    expect(runtime.getSnapshot().droppedFrames).toBe(frameCount + 1);

    runtime.reset();
    expect(runtime.getSnapshot()).toEqual({ status: "ready", processedFrames: 0, droppedFrames: 0 });
    expect(outputValues(runtime, [7], 7)).toEqual([7]);
  });

  it("意外异常会熔断且不向调用方抛出", () => {
    const runtime = new ProcessingGraphRuntime(
      singleOutputGraph([{ id: "source", kind: "input", channelIndex: 0 }]),
    );
    const frame = { timestamp: 1 } as { values: number[]; timestamp: number };
    Object.defineProperty(frame, "values", {
      get: () => {
        throw new Error("unexpected");
      },
    });

    expect(runtime.process([frame])).toEqual([]);
    expect(runtime.getSnapshot()).toMatchObject({
      status: "suspended",
      processedFrames: 0,
      droppedFrames: 1,
      lastError: "处理图运行时发生意外错误",
    });
  });
});
