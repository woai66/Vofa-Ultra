import type {
  LegacyProcessingGraphConfig,
  OutputProcessingNode,
  ProcessingGraphConfig,
  ProcessingGraphSnapshot,
  ProcessingNode,
  ProcessingOutputSample,
} from "../types/processingGraph";
import type { ParsedFrame } from "../types/workbench";
import {
  decodeNumericValueFromView,
  encodeNumericValueToView,
  numericTypeByteWidth,
} from "./dataConverter";
import {
  DATA_ENDIANNESS_VALUES,
  DATA_NUMERIC_TYPES,
} from "../types/dataConversion";

export type {
  AffineProcessingNode,
  BytesToNumberProcessingNode,
  ClampProcessingNode,
  EmaProcessingNode,
  InputProcessingNode,
  LegacyProcessingGraphConfig,
  LegacyProcessingNode,
  MathProcessingNode,
  MovingAverageProcessingNode,
  NumberToByteProcessingNode,
  OutputProcessingNode,
  ProcessingGraphConfig,
  ProcessingGraphRuntimeStatus,
  ProcessingGraphSnapshot,
  ProcessingMathOperation,
  ProcessingNode,
  ProcessingOutputSample,
} from "../types/processingGraph";

export const MAX_PROCESSING_NODES = 64;
export const MAX_PROCESSING_OUTPUTS = 16;
export const MAX_PROCESSING_ID_LENGTH = 64;
export const MAX_PROCESSING_NAME_LENGTH = 64;
export const MAX_MOVING_AVERAGE_WINDOW = 256;
export const MAX_TOTAL_MOVING_AVERAGE_CAPACITY = 8_192;
export const MAX_PROCESSING_EVALUATIONS_PER_BATCH = 1_000_000;
export const MAX_PROCESSING_PARAMETER_ABS = 1_000_000_000_000;

const PROCESSING_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PROCESSING_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const GRAPH_KEYS = ["enabled", "nodes"] as const;
const NODE_KEYS = {
  input: ["id", "kind", "channelIndex"],
  affine: ["id", "kind", "input", "gain", "offset"],
  clamp: ["id", "kind", "input", "minimum", "maximum"],
  ema: ["id", "kind", "input", "alpha"],
  moving_average: ["id", "kind", "input", "windowSize"],
  math: ["id", "kind", "left", "right", "operation"],
  bytes_to_number: ["id", "kind", "inputs", "numericType", "endianness"],
  number_to_byte: ["id", "kind", "input", "numericType", "endianness", "byteIndex"],
  output: ["id", "kind", "input", "name", "color"],
} as const;
const NODE_KINDS = [
  "input",
  "affine",
  "clamp",
  "ema",
  "moving_average",
  "math",
  "bytes_to_number",
  "number_to_byte",
  "output",
] as const;
const LEGACY_NODE_KINDS = [
  "input",
  "affine",
  "clamp",
  "ema",
  "moving_average",
  "math",
  "output",
] as const;
const MATH_OPERATIONS = ["add", "subtract", "multiply", "divide"] as const;

type ReadonlyProcessingNode = Readonly<ProcessingNode>;

export interface ReadonlyProcessingGraphConfig {
  readonly enabled: boolean;
  readonly nodes: readonly ReadonlyProcessingNode[];
}

export interface CompiledProcessingOutput {
  readonly id: string;
  readonly channelId: string;
  readonly name: string;
  readonly color: string;
}

export interface CompiledProcessingGraph {
  readonly config: ReadonlyProcessingGraphConfig;
  readonly evaluationOrder: readonly string[];
  readonly outputs: readonly CompiledProcessingOutput[];
  readonly evaluationsPerFrame: number;
}

interface InternalCompiledGraph {
  readonly nodes: readonly ReadonlyProcessingNode[];
  readonly dependencies: readonly (readonly number[])[];
  readonly evaluationOrder: readonly number[];
  readonly outputIndexes: readonly number[];
}

interface MovingAverageState {
  readonly values: number[];
  nextIndex: number;
  sum: number;
}

const s_compiled_graphs = new WeakMap<CompiledProcessingGraph, InternalCompiledGraph>();

export function createDefaultProcessingGraph(): ProcessingGraphConfig {
  return {
    enabled: false,
    nodes: [],
  };
}

export function cloneProcessingGraphConfig(
  config: ProcessingGraphConfig | ReadonlyProcessingGraphConfig,
): ProcessingGraphConfig {
  return {
    enabled: config.enabled,
    nodes: config.nodes.map((node) => cloneProcessingNode(node)),
  };
}

export const cloneProcessingGraph = cloneProcessingGraphConfig;

export function cloneLegacyProcessingGraphConfig(
  config: LegacyProcessingGraphConfig,
): LegacyProcessingGraphConfig {
  return cloneProcessingGraphConfig(config) as LegacyProcessingGraphConfig;
}

export function parseProcessingGraphConfig(value: unknown): ProcessingGraphConfig {
  const config = normalizeProcessingGraphConfig(value, true);
  compileProcessingGraph(config);
  return cloneProcessingGraphConfig(config);
}

export function parseLegacyProcessingGraphConfig(value: unknown): LegacyProcessingGraphConfig {
  const config = normalizeProcessingGraphConfig(value, true, LEGACY_NODE_KINDS);
  compileProcessingGraph(config);
  return cloneProcessingGraphConfig(config) as LegacyProcessingGraphConfig;
}

export function compileProcessingGraph(config: ProcessingGraphConfig): CompiledProcessingGraph {
  const normalized = normalizeProcessingGraphConfig(config, false);
  if (normalized.nodes.length > MAX_PROCESSING_NODES) {
    throw new Error(`处理图最多包含 ${MAX_PROCESSING_NODES} 个节点`);
  }

  const nodeIndexes = new Map<string, number>();
  let outputCount = 0;
  let movingAverageCapacity = 0;
  normalized.nodes.forEach((node, index) => {
    validateProcessingId(node.id, "节点 ID");
    if (nodeIndexes.has(node.id)) {
      throw new Error(`处理图包含重复节点 ID：${node.id}`);
    }
    nodeIndexes.set(node.id, index);

    switch (node.kind) {
      case "input":
        if (!Number.isInteger(node.channelIndex) || node.channelIndex < 0 || node.channelIndex > 15) {
          throw new Error(`输入节点 ${node.id} 的通道索引必须在 0 到 15 之间`);
        }
        break;
      case "affine":
        validateBoundedParameter(node.gain, `${node.id}.gain`);
        validateBoundedParameter(node.offset, `${node.id}.offset`);
        break;
      case "clamp":
        validateBoundedParameter(node.minimum, `${node.id}.minimum`);
        validateBoundedParameter(node.maximum, `${node.id}.maximum`);
        if (node.minimum > node.maximum) {
          throw new Error(`限幅节点 ${node.id} 的 minimum 不能大于 maximum`);
        }
        break;
      case "ema":
        if (!Number.isFinite(node.alpha) || node.alpha <= 0 || node.alpha > 1) {
          throw new Error(`EMA 节点 ${node.id} 的 alpha 必须大于 0 且不超过 1`);
        }
        break;
      case "moving_average":
        if (
          !Number.isInteger(node.windowSize) ||
          node.windowSize < 1 ||
          node.windowSize > MAX_MOVING_AVERAGE_WINDOW
        ) {
          throw new Error(
            `移动平均节点 ${node.id} 的窗口必须是 1 到 ${MAX_MOVING_AVERAGE_WINDOW} 的整数`,
          );
        }
        movingAverageCapacity += node.windowSize;
        break;
      case "math":
        break;
      case "bytes_to_number": {
        const byteWidth = numericTypeByteWidth(node.numericType);
        if (node.inputs.length !== byteWidth) {
          throw new Error(
            `字节转数值节点 ${node.id} 的输入数量必须为 ${byteWidth}`,
          );
        }
        break;
      }
      case "number_to_byte": {
        const byteWidth = numericTypeByteWidth(node.numericType);
        if (!Number.isInteger(node.byteIndex) || node.byteIndex < 0 || node.byteIndex >= byteWidth) {
          throw new Error(
            `数值转字节节点 ${node.id} 的字节索引必须在 0 到 ${byteWidth - 1} 之间`,
          );
        }
        break;
      }
      case "output":
        outputCount += 1;
        validateOutputName(node.name, node.id);
        if (!PROCESSING_COLOR_PATTERN.test(node.color)) {
          throw new Error(`输出节点 ${node.id} 的颜色必须是 #RRGGBB`);
        }
        break;
    }
  });

  if (outputCount > MAX_PROCESSING_OUTPUTS) {
    throw new Error(`处理图最多包含 ${MAX_PROCESSING_OUTPUTS} 个输出节点`);
  }
  if (movingAverageCapacity > MAX_TOTAL_MOVING_AVERAGE_CAPACITY) {
    throw new Error(
      `移动平均总窗口容量不能超过 ${MAX_TOTAL_MOVING_AVERAGE_CAPACITY}`,
    );
  }

  const dependencies: number[][] = normalized.nodes.map(() => []);
  const dependents: number[][] = normalized.nodes.map(() => []);
  const indegrees = normalized.nodes.map(() => 0);
  normalized.nodes.forEach((node, nodeIndex) => {
    for (const dependencyId of processingNodeDependencies(node)) {
      validateProcessingId(dependencyId, `${node.id} 的引用`);
      if (dependencyId === node.id) {
        throw new Error(`节点 ${node.id} 不能引用自身`);
      }
      const dependencyIndex = nodeIndexes.get(dependencyId);
      if (dependencyIndex === undefined) {
        throw new Error(`节点 ${node.id} 引用了未知节点：${dependencyId}`);
      }
      const dependency = normalized.nodes[dependencyIndex];
      if (dependency?.kind === "output") {
        throw new Error(`节点 ${node.id} 不能依赖输出节点 ${dependencyId}`);
      }
      dependencies[nodeIndex]?.push(dependencyIndex);
      dependents[dependencyIndex]?.push(nodeIndex);
      indegrees[nodeIndex] = (indegrees[nodeIndex] ?? 0) + 1;
    }
  });

  const evaluationOrder = stableTopologicalSort(indegrees, dependents, normalized.nodes);
  const frozenNodes = normalized.nodes.map((node) => freezeProcessingNode(node));
  const frozenConfig = Object.freeze({
    enabled: normalized.enabled,
    nodes: Object.freeze(frozenNodes),
  });
  const outputIndexes = normalized.nodes.flatMap((node, index) =>
    node.kind === "output" ? [index] : [],
  );
  const outputs = outputIndexes.map((index) => {
    const node = frozenNodes[index] as Readonly<OutputProcessingNode>;
    return Object.freeze({
      id: node.id,
      channelId: processingOutputChannelId(node.id),
      name: node.name,
      color: node.color,
    });
  });
  const compiled = Object.freeze({
    config: frozenConfig,
    evaluationOrder: Object.freeze(evaluationOrder.map((index) => frozenNodes[index]?.id ?? "")),
    outputs: Object.freeze(outputs),
    evaluationsPerFrame: frozenNodes.length,
  });
  s_compiled_graphs.set(compiled, {
    nodes: frozenNodes,
    dependencies: dependencies.map((indexes) => Object.freeze([...indexes])),
    evaluationOrder: Object.freeze([...evaluationOrder]),
    outputIndexes: Object.freeze(outputIndexes),
  });
  return compiled;
}

export function processingOutputChannelId(outputNodeId: string): string {
  validateProcessingId(outputNodeId, "输出节点 ID");
  return `derived:${outputNodeId}`;
}

export class ProcessingGraphRuntime {
  private readonly compiled: CompiledProcessingGraph;
  private readonly internal: InternalCompiledGraph;
  private readonly emaValues = new Map<number, number>();
  private readonly movingAverageStates = new Map<number, MovingAverageState>();
  private readonly conversionBytes = new Uint8Array(8);
  private readonly conversionView = new DataView(
    this.conversionBytes.buffer,
    this.conversionBytes.byteOffset,
    this.conversionBytes.byteLength,
  );
  private statusValue: ProcessingGraphSnapshot["status"];
  private processedFramesValue = 0;
  private droppedFramesValue = 0;
  private lastErrorValue: string | undefined;

  constructor(config: ProcessingGraphConfig | CompiledProcessingGraph) {
    const knownInternal = s_compiled_graphs.get(config as CompiledProcessingGraph);
    this.compiled = knownInternal
      ? (config as CompiledProcessingGraph)
      : compileProcessingGraph(config as ProcessingGraphConfig);
    const internal = s_compiled_graphs.get(this.compiled);
    if (!internal) {
      throw new Error("处理图编译结果无效");
    }
    this.internal = internal;
    this.statusValue = this.compiled.config.enabled ? "ready" : "disabled";
  }

  get snapshot(): Readonly<ProcessingGraphSnapshot> {
    return this.getSnapshot();
  }

  getSnapshot(): Readonly<ProcessingGraphSnapshot> {
    return Object.freeze({
      status: this.statusValue,
      processedFrames: this.processedFramesValue,
      droppedFrames: this.droppedFramesValue,
      ...(this.lastErrorValue === undefined ? {} : { lastError: this.lastErrorValue }),
    });
  }

  process(frames: readonly ParsedFrame[]): ProcessingOutputSample[] {
    if (this.statusValue === "disabled") {
      return [];
    }
    if (this.statusValue === "suspended") {
      this.droppedFramesValue = addCounter(this.droppedFramesValue, frames.length);
      return [];
    }
    if (
      this.internal.nodes.length > 0 &&
      frames.length > Math.floor(MAX_PROCESSING_EVALUATIONS_PER_BATCH / this.internal.nodes.length)
    ) {
      this.suspend(
        `处理图单批最多执行 ${MAX_PROCESSING_EVALUATIONS_PER_BATCH} 次节点求值`,
        frames.length,
      );
      return [];
    }

    const samples: ProcessingOutputSample[] = [];
    let completedFrames = 0;
    try {
      for (const [frameIndex, frame] of frames.entries()) {
        samples.push(...this.processFrame(frame, frameIndex));
        completedFrames += 1;
      }
      this.processedFramesValue = addCounter(this.processedFramesValue, completedFrames);
      return samples;
    } catch {
      this.processedFramesValue = addCounter(this.processedFramesValue, completedFrames);
      this.suspend("处理图运行时发生意外错误", frames.length - completedFrames);
      return [];
    }
  }

  reset(): void {
    this.emaValues.clear();
    this.movingAverageStates.clear();
    this.processedFramesValue = 0;
    this.droppedFramesValue = 0;
    this.lastErrorValue = undefined;
    this.statusValue = this.compiled.config.enabled ? "ready" : "disabled";
  }

  private processFrame(frame: ParsedFrame, frameIndex: number): ProcessingOutputSample[] {
    if (!Number.isFinite(frame.timestamp) || !Array.isArray(frame.values)) {
      return [];
    }

    const values = new Array<number | undefined>(this.internal.nodes.length);
    for (const nodeIndex of this.internal.evaluationOrder) {
      const node = this.internal.nodes[nodeIndex];
      if (!node) {
        throw new Error("处理图节点索引无效");
      }
      values[nodeIndex] = this.evaluateNode(nodeIndex, node, values, frame.values);
    }

    const samples: ProcessingOutputSample[] = [];
    for (const outputIndex of this.internal.outputIndexes) {
      const value = values[outputIndex];
      const node = this.internal.nodes[outputIndex];
      if (value === undefined || node?.kind !== "output") {
        continue;
      }
      samples.push({
        channelId: processingOutputChannelId(node.id),
        outputId: node.id,
        name: node.name,
        color: node.color,
        value,
        timestamp: frame.timestamp,
        frameIndex,
      });
    }
    return samples;
  }

  private evaluateNode(
    nodeIndex: number,
    node: ReadonlyProcessingNode,
    values: readonly (number | undefined)[],
    rawValues: readonly number[],
  ): number | undefined {
    const dependencies = this.internal.dependencies[nodeIndex] ?? [];
    switch (node.kind) {
      case "input":
        return finiteValue(rawValues[node.channelIndex]);
      case "affine": {
        const input = values[dependencies[0] ?? -1];
        if (input === undefined) {
          return undefined;
        }
        const scaled = input * node.gain;
        if (!Number.isFinite(scaled)) {
          return undefined;
        }
        return finiteValue(scaled + node.offset);
      }
      case "clamp": {
        const input = values[dependencies[0] ?? -1];
        return input === undefined
          ? undefined
          : finiteValue(Math.min(node.maximum, Math.max(node.minimum, input)));
      }
      case "ema":
        return this.evaluateEma(nodeIndex, values[dependencies[0] ?? -1], node.alpha);
      case "moving_average":
        return this.evaluateMovingAverage(
          nodeIndex,
          values[dependencies[0] ?? -1],
          node.windowSize,
        );
      case "math":
        return evaluateMath(
          values[dependencies[0] ?? -1],
          values[dependencies[1] ?? -1],
          node.operation,
        );
      case "bytes_to_number": {
        for (let byteIndex = 0; byteIndex < dependencies.length; byteIndex += 1) {
          const byte = values[dependencies[byteIndex] ?? -1];
          if (byte === undefined || !Number.isInteger(byte) || byte < 0 || byte > 0xff) {
            return undefined;
          }
          this.conversionBytes[byteIndex] = byte;
        }
        return decodeNumericValueFromView(
          this.conversionView,
          node.numericType,
          node.endianness,
        );
      }
      case "number_to_byte": {
        const input = values[dependencies[0] ?? -1];
        if (input === undefined) {
          return undefined;
        }
        if (
          !encodeNumericValueToView(
            this.conversionView,
            input,
            node.numericType,
            node.endianness,
          )
        ) {
          return undefined;
        }
        return this.conversionBytes[node.byteIndex];
      }
      case "output":
        return values[dependencies[0] ?? -1];
    }
  }

  private evaluateEma(
    nodeIndex: number,
    input: number | undefined,
    alpha: number,
  ): number | undefined {
    if (input === undefined) {
      return undefined;
    }
    const previous = this.emaValues.get(nodeIndex);
    if (previous === undefined) {
      this.emaValues.set(nodeIndex, input);
      return input;
    }
    const currentPart = input * alpha;
    const previousPart = previous * (1 - alpha);
    if (!Number.isFinite(currentPart) || !Number.isFinite(previousPart)) {
      return undefined;
    }
    const next = finiteValue(currentPart + previousPart);
    if (next !== undefined) {
      this.emaValues.set(nodeIndex, next);
    }
    return next;
  }

  private evaluateMovingAverage(
    nodeIndex: number,
    input: number | undefined,
    windowSize: number,
  ): number | undefined {
    if (input === undefined) {
      return undefined;
    }
    const state = this.movingAverageStates.get(nodeIndex);
    if (!state) {
      this.movingAverageStates.set(nodeIndex, {
        values: [input],
        nextIndex: 0,
        sum: input,
      });
      return input;
    }

    if (state.values.length < windowSize) {
      const nextSum = finiteValue(state.sum + input);
      if (nextSum === undefined) {
        return undefined;
      }
      const average = finiteValue(nextSum / (state.values.length + 1));
      if (average === undefined) {
        return undefined;
      }
      state.values.push(input);
      state.sum = nextSum;
      return average;
    }

    const oldest = state.values[state.nextIndex];
    if (oldest === undefined) {
      throw new Error("移动平均状态无效");
    }
    const reducedSum = finiteValue(state.sum - oldest);
    const nextSum = reducedSum === undefined ? undefined : finiteValue(reducedSum + input);
    const average = nextSum === undefined ? undefined : finiteValue(nextSum / windowSize);
    if (nextSum === undefined || average === undefined) {
      return undefined;
    }
    state.values[state.nextIndex] = input;
    state.nextIndex = (state.nextIndex + 1) % windowSize;
    state.sum = nextSum;
    return average;
  }

  private suspend(message: string, droppedFrames: number): void {
    this.statusValue = "suspended";
    this.lastErrorValue = message;
    this.droppedFramesValue = addCounter(this.droppedFramesValue, droppedFrames);
  }
}

function normalizeProcessingGraphConfig(
  value: unknown,
  exactKeys: boolean,
  allowedNodeKinds: readonly ProcessingNode["kind"][] = NODE_KINDS,
): ProcessingGraphConfig {
  const graph = requireRecord(value, "处理图配置");
  if (exactKeys) {
    assertExactKeys(graph, GRAPH_KEYS, "处理图配置");
  }
  if (typeof graph.enabled !== "boolean") {
    throw new Error("处理图 enabled 必须是布尔值");
  }
  if (!Array.isArray(graph.nodes)) {
    throw new Error("处理图 nodes 必须是数组");
  }
  if (graph.nodes.length > MAX_PROCESSING_NODES) {
    throw new Error(`处理图最多包含 ${MAX_PROCESSING_NODES} 个节点`);
  }
  return {
    enabled: graph.enabled,
    nodes: graph.nodes.map((node, index) =>
      parseProcessingNode(node, index, exactKeys, allowedNodeKinds),
    ),
  };
}

function parseProcessingNode(
  value: unknown,
  index: number,
  exactKeys: boolean,
  allowedNodeKinds: readonly ProcessingNode["kind"][],
): ProcessingNode {
  const record = requireRecord(value, `处理图节点 ${index}`);
  const kind = requireEnum(record.kind, allowedNodeKinds, `处理图节点 ${index} kind`);
  if (exactKeys) {
    assertExactKeys(record, NODE_KEYS[kind], `处理图节点 ${index}`);
  }
  const id = requireString(record.id, `处理图节点 ${index} ID`);

  switch (kind) {
    case "input":
      return { id, kind, channelIndex: requireNumber(record.channelIndex, `${id}.channelIndex`) };
    case "affine":
      return {
        id,
        kind,
        input: requireString(record.input, `${id}.input`),
        gain: requireNumber(record.gain, `${id}.gain`),
        offset: requireNumber(record.offset, `${id}.offset`),
      };
    case "clamp":
      return {
        id,
        kind,
        input: requireString(record.input, `${id}.input`),
        minimum: requireNumber(record.minimum, `${id}.minimum`),
        maximum: requireNumber(record.maximum, `${id}.maximum`),
      };
    case "ema":
      return {
        id,
        kind,
        input: requireString(record.input, `${id}.input`),
        alpha: requireNumber(record.alpha, `${id}.alpha`),
      };
    case "moving_average":
      return {
        id,
        kind,
        input: requireString(record.input, `${id}.input`),
        windowSize: requireNumber(record.windowSize, `${id}.windowSize`),
      };
    case "math":
      return {
        id,
        kind,
        left: requireString(record.left, `${id}.left`),
        right: requireString(record.right, `${id}.right`),
        operation: requireEnum(record.operation, MATH_OPERATIONS, `${id}.operation`),
      };
    case "bytes_to_number":
      return {
        id,
        kind,
        inputs: requireStringArray(record.inputs, `${id}.inputs`, 8),
        numericType: requireEnum(record.numericType, DATA_NUMERIC_TYPES, `${id}.numericType`),
        endianness: requireEnum(record.endianness, DATA_ENDIANNESS_VALUES, `${id}.endianness`),
      };
    case "number_to_byte":
      return {
        id,
        kind,
        input: requireString(record.input, `${id}.input`),
        numericType: requireEnum(record.numericType, DATA_NUMERIC_TYPES, `${id}.numericType`),
        endianness: requireEnum(record.endianness, DATA_ENDIANNESS_VALUES, `${id}.endianness`),
        byteIndex: requireNumber(record.byteIndex, `${id}.byteIndex`),
      };
    case "output":
      return {
        id,
        kind,
        input: requireString(record.input, `${id}.input`),
        name: normalizeOutputName(requireString(record.name, `${id}.name`), id),
        color: requireString(record.color, `${id}.color`).toLowerCase(),
      };
  }
}

function processingNodeDependencies(node: ProcessingNode): readonly string[] {
  switch (node.kind) {
    case "input":
      return [];
    case "math":
      return [node.left, node.right];
    case "bytes_to_number":
      return node.inputs;
    case "affine":
    case "clamp":
    case "ema":
    case "moving_average":
    case "number_to_byte":
    case "output":
      return [node.input];
  }
}

function stableTopologicalSort(
  indegrees: readonly number[],
  dependents: readonly (readonly number[])[],
  nodes: readonly ProcessingNode[],
): number[] {
  const remainingIndegrees = [...indegrees];
  const emitted = nodes.map(() => false);
  const ready = remainingIndegrees.flatMap((indegree, index) => (indegree === 0 ? [index] : []));
  const order: number[] = [];
  let readyIndex = 0;

  while (readyIndex < ready.length) {
    const nextIndex = ready[readyIndex];
    readyIndex += 1;
    if (nextIndex === undefined) {
      throw new Error("处理图拓扑队列无效");
    }
    emitted[nextIndex] = true;
    order.push(nextIndex);
    for (const dependentIndex of dependents[nextIndex] ?? []) {
      remainingIndegrees[dependentIndex] = (remainingIndegrees[dependentIndex] ?? 0) - 1;
      if (remainingIndegrees[dependentIndex] === 0) {
        ready.push(dependentIndex);
      }
    }
  }
  if (order.length < nodes.length) {
    const cyclicIds = nodes.filter((_, index) => !emitted[index]).map((node) => node.id);
    throw new Error(`处理图存在循环：${cyclicIds.join(", ")}`);
  }
  return order;
}

function evaluateMath(
  left: number | undefined,
  right: number | undefined,
  operation: "add" | "subtract" | "multiply" | "divide",
): number | undefined {
  if (left === undefined || right === undefined || (operation === "divide" && right === 0)) {
    return undefined;
  }
  switch (operation) {
    case "add":
      return finiteValue(left + right);
    case "subtract":
      return finiteValue(left - right);
    case "multiply":
      return finiteValue(left * right);
    case "divide":
      return finiteValue(left / right);
  }
}

function finiteValue(value: number | undefined): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}

function validateBoundedParameter(value: number, field: string): void {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_PROCESSING_PARAMETER_ABS) {
    throw new Error(`${field} 必须是绝对值不超过 ${MAX_PROCESSING_PARAMETER_ABS} 的有限数值`);
  }
}

function validateProcessingId(value: string, field: string): void {
  if (value.length > MAX_PROCESSING_ID_LENGTH || !PROCESSING_ID_PATTERN.test(value)) {
    throw new Error(`${field} 必须以字母开头且仅包含字母、数字、下划线或连字符`);
  }
}

function validateOutputName(value: string, nodeId: string): void {
  if (
    value.length === 0 ||
    value.length > MAX_PROCESSING_NAME_LENGTH ||
    containsControlCharacter(value)
  ) {
    throw new Error(`输出节点 ${nodeId} 的名称无效`);
  }
}

function normalizeOutputName(value: string, nodeId: string): string {
  if (value.length > MAX_PROCESSING_NAME_LENGTH || containsControlCharacter(value)) {
    throw new Error(`输出节点 ${nodeId} 的名称无效`);
  }
  const normalized = value.trim();
  validateOutputName(normalized, nodeId);
  return normalized;
}

function cloneProcessingNode(node: ReadonlyProcessingNode): ProcessingNode {
  return node.kind === "bytes_to_number"
    ? { ...node, inputs: [...node.inputs] }
    : ({ ...node } as ProcessingNode);
}

function freezeProcessingNode(node: ReadonlyProcessingNode): ReadonlyProcessingNode {
  const cloned = cloneProcessingNode(node);
  if (cloned.kind === "bytes_to_number") {
    Object.freeze(cloned.inputs);
  }
  return Object.freeze(cloned);
}

function addCounter(current: number, increment: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, current + increment);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} 必须是字符串`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number") {
    throw new Error(`${field} 必须是数值`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string, maximumLength: number): string[] {
  if (!Array.isArray(value) || value.length > maximumLength) {
    throw new Error(`${field} 必须是最多包含 ${maximumLength} 项的数组`);
  }
  return value.map((item, index) => requireString(item, `${field}[${index}]`));
}

function requireEnum<const T>(value: unknown, values: readonly T[], field: string): T {
  const matched = values.find((candidate) => candidate === value);
  if (matched === undefined) {
    throw new Error(`${field} 的值无效`);
  }
  return matched;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || (code >= 127 && code <= 159);
  });
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  field: string,
): void {
  const actualKeys = Object.keys(value);
  const missingKey = expectedKeys.find((key) => !Object.hasOwn(value, key));
  const unknownKey = actualKeys.find((key) => !expectedKeys.includes(key));
  if (missingKey) {
    throw new Error(`${field} 缺少字段：${missingKey}`);
  }
  if (unknownKey) {
    throw new Error(`${field} 包含未知字段：${unknownKey}`);
  }
}
