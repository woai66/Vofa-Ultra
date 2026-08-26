import type { DataEndianness, DataNumericType } from "./dataConversion";

export type ProcessingMathOperation = "add" | "subtract" | "multiply" | "divide";

export interface InputProcessingNode {
  id: string;
  kind: "input";
  channelIndex: number;
}

export interface AffineProcessingNode {
  id: string;
  kind: "affine";
  input: string;
  gain: number;
  offset: number;
}

export interface ClampProcessingNode {
  id: string;
  kind: "clamp";
  input: string;
  minimum: number;
  maximum: number;
}

export interface EmaProcessingNode {
  id: string;
  kind: "ema";
  input: string;
  alpha: number;
}

export interface MovingAverageProcessingNode {
  id: string;
  kind: "moving_average";
  input: string;
  windowSize: number;
}

export interface MathProcessingNode {
  id: string;
  kind: "math";
  left: string;
  right: string;
  operation: ProcessingMathOperation;
}

export interface BytesToNumberProcessingNode {
  id: string;
  kind: "bytes_to_number";
  inputs: readonly string[];
  numericType: DataNumericType;
  endianness: DataEndianness;
}

export interface NumberToByteProcessingNode {
  id: string;
  kind: "number_to_byte";
  input: string;
  numericType: DataNumericType;
  endianness: DataEndianness;
  byteIndex: number;
}

export interface OutputProcessingNode {
  id: string;
  kind: "output";
  input: string;
  name: string;
  color: string;
}

export type ProcessingNode =
  | InputProcessingNode
  | AffineProcessingNode
  | ClampProcessingNode
  | EmaProcessingNode
  | MovingAverageProcessingNode
  | MathProcessingNode
  | BytesToNumberProcessingNode
  | NumberToByteProcessingNode
  | OutputProcessingNode;

export type LegacyProcessingNode = Exclude<
  ProcessingNode,
  BytesToNumberProcessingNode | NumberToByteProcessingNode
>;

export interface ProcessingGraphConfig {
  enabled: boolean;
  nodes: ProcessingNode[];
}

export interface LegacyProcessingGraphConfig {
  enabled: boolean;
  nodes: LegacyProcessingNode[];
}

export interface ProcessingOutputSample {
  readonly channelId: string;
  readonly outputId: string;
  readonly name: string;
  readonly color: string;
  readonly value: number;
  readonly timestamp: number;
  readonly frameIndex: number;
}

export type ProcessingGraphRuntimeStatus = "disabled" | "ready" | "suspended";

export interface ProcessingGraphSnapshot {
  readonly status: ProcessingGraphRuntimeStatus;
  readonly processedFrames: number;
  readonly droppedFrames: number;
  readonly lastError?: string;
}
