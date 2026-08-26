import { useEffect, useState } from "react";
import { Plus, RotateCcw, Trash2, Workflow } from "lucide-react";
import { getChannelPresentationOverride } from "../core/channelPresentation";
import {
  MAX_PROCESSING_NODES,
  MAX_PROCESSING_OUTPUTS,
  type ProcessingGraphConfig,
  type ProcessingNode,
} from "../core/processingGraph";
import {
  DATA_NUMERIC_TYPE_OPTIONS,
  numericTypeByteWidth,
  type DataConverterEndianness,
  type DataNumericType,
} from "../core/dataConverter";
import {
  selectActiveProtocol,
  useWorkbenchStore,
} from "../store/workbenchStore";

type NodeKind = ProcessingNode["kind"];

const NODE_KINDS: readonly { kind: NodeKind; label: string }[] = [
  { kind: "input", label: "通道输入" },
  { kind: "affine", label: "缩放偏移" },
  { kind: "clamp", label: "限幅" },
  { kind: "ema", label: "EMA" },
  { kind: "moving_average", label: "移动平均" },
  { kind: "math", label: "双路运算" },
  { kind: "bytes_to_number", label: "字节转数值" },
  { kind: "number_to_byte", label: "数值拆字节" },
  { kind: "output", label: "输出路由" },
];

const OUTPUT_COLORS = [
  "#46d89c",
  "#55bde8",
  "#f0b35a",
  "#f06d76",
  "#b69cf6",
  "#8bd450",
] as const;

export function ProcessingPanel() {
  const graph = useWorkbenchStore((state) => state.processingGraph);
  const status = useWorkbenchStore((state) => state.processingStatus);
  const channels = useWorkbenchStore((state) => state.channels);
  const channelPresentations = useWorkbenchStore((state) => state.channelPresentations);
  const activeProtocol = useWorkbenchStore(selectActiveProtocol);
  const setProcessingGraph = useWorkbenchStore((state) => state.setProcessingGraph);
  const retryProcessingGraph = useWorkbenchStore((state) => state.retryProcessingGraph);
  const isTransitioning = useWorkbenchStore(
    (state) => state.workspaceTransitionStatus !== "idle",
  );
  const [nodeKind, setNodeKind] = useState<NodeKind>("input");
  const [editError, setEditError] = useState("");
  const outputCount = graph.nodes.filter((node) => node.kind === "output").length;
  const visibleError = editError || status.lastError || "";
  const inputChannelLabels = Array.from({ length: 16 }, (_, index) => {
    const id = `channel-${index}`;
    const sourceName = channels.find((channel) => channel.id === id)?.name ?? `CH ${index + 1}`;
    return (
      getChannelPresentationOverride(channelPresentations, activeProtocol, id)?.alias ||
      sourceName
    );
  });
  const addDisabled =
    isTransitioning ||
    graph.nodes.length >= MAX_PROCESSING_NODES ||
    (nodeKind === "output" && outputCount >= MAX_PROCESSING_OUTPUTS);

  const applyGraph = (nextGraph: ProcessingGraphConfig) => {
    try {
      setProcessingGraph(nextGraph);
      setEditError("");
    } catch (error) {
      setEditError(error instanceof Error ? error.message : "处理图配置无效");
    }
  };

  const updateNode = (nextNode: ProcessingNode) => {
    applyGraph({
      ...graph,
      nodes: graph.nodes.map((node) => (node.id === nextNode.id ? nextNode : node)),
    });
  };

  const removeNode = (nodeId: string) => {
    const dependent = graph.nodes.find((node) => nodeDependencies(node).includes(nodeId));
    if (dependent) {
      setEditError(`节点 ${nodeId} 正被 ${dependent.id} 引用`);
      return;
    }
    applyGraph({
      ...graph,
      nodes: graph.nodes.filter((node) => node.id !== nodeId),
    });
  };

  const addNode = () => {
    const node = createProcessingNode(nodeKind, graph.nodes);
    if (!node) {
      setEditError("请先添加可用的上游节点");
      return;
    }
    applyGraph({ ...graph, nodes: [...graph.nodes, node] });
  };

  return (
    <div className="sidebar-panel processing-panel">
      <div className="sidebar-heading">
        <div>
          <span className="eyebrow">PROCESSING</span>
          <h1>数据处理</h1>
        </div>
        <Workflow size={20} />
      </div>

      <section className="sidebar-section processing-status-section">
        <label className="toggle-row processing-toggle">
          <span>启用处理图</span>
          <input
            type="checkbox"
            name="processing-enabled"
            checked={graph.enabled}
            disabled={isTransitioning}
            onChange={(event) => applyGraph({ ...graph, enabled: event.target.checked })}
          />
        </label>
        <div className="processing-summary" data-status={status.status}>
          <span className="status-dot" />
          <span role="status" aria-live="polite">
            {processingStatusLabel(status.status)}
          </span>
          <code>
            {graph.nodes.length} N · {outputCount} OUT
          </code>
          {status.status === "suspended" && (
            <button
              className="icon-button compact"
              type="button"
              aria-label="重试处理图"
              title="重试处理图"
              disabled={isTransitioning}
              onClick={() => {
                retryProcessingGraph();
                setEditError("");
              }}
            >
              <RotateCcw size={14} />
            </button>
          )}
        </div>
        <div className="processing-counters">
          <span>{status.processedFrames.toLocaleString()} 已处理</span>
          <span>{status.droppedFrames.toLocaleString()} 已跳过</span>
        </div>
        {visibleError && (
          <div className="inline-error processing-error" role="alert">
            {visibleError}
          </div>
        )}
      </section>

      <section className="processing-node-list" aria-label="处理图节点">
        {graph.nodes.length === 0 ? (
          <div className="sidebar-empty processing-empty">
            <Workflow size={24} strokeWidth={1.4} />
            <span>尚未配置处理节点</span>
          </div>
        ) : (
          graph.nodes.map((node) => (
            <ProcessingNodeEditor
              key={node.id}
              node={node}
              nodes={graph.nodes}
              inputChannelLabels={inputChannelLabels}
              disabled={isTransitioning}
              onChange={updateNode}
              onRemove={() => removeNode(node.id)}
            />
          ))
        )}
      </section>

      <div className="processing-add-bar">
        <select
          aria-label="新增节点类型"
          name="processing-node-kind"
          value={nodeKind}
          disabled={isTransitioning || graph.nodes.length >= MAX_PROCESSING_NODES}
          onChange={(event) => setNodeKind(event.target.value as NodeKind)}
        >
          {NODE_KINDS.map((item) => (
            <option key={item.kind} value={item.kind}>
              {item.label}
            </option>
          ))}
        </select>
        <button
          className="icon-button"
          type="button"
          aria-label="添加处理节点"
          title="添加处理节点"
          disabled={addDisabled}
          onClick={addNode}
        >
          <Plus size={17} />
        </button>
      </div>
    </div>
  );
}

interface ProcessingNodeEditorProps {
  node: ProcessingNode;
  nodes: readonly ProcessingNode[];
  inputChannelLabels: readonly string[];
  disabled: boolean;
  onChange(node: ProcessingNode): void;
  onRemove(): void;
}

function ProcessingNodeEditor({
  node,
  nodes,
  inputChannelLabels,
  disabled,
  onChange,
  onRemove,
}: ProcessingNodeEditorProps) {
  return (
    <article className="processing-node" data-kind={node.kind}>
      <header>
        <span>{nodeKindLabel(node.kind)}</span>
        <code>{node.id}</code>
        <button
          className="icon-button compact"
          type="button"
          aria-label={`删除节点 ${node.id}`}
          title="删除节点"
          disabled={disabled}
          onClick={onRemove}
        >
          <Trash2 size={13} />
        </button>
      </header>
      <div className="processing-node-fields">
        {node.kind === "input" && (
          <label>
            <span className="field-label">原始通道</span>
            <select
              aria-label={`${node.id} 原始通道`}
              name={`processing-${node.id}-channel`}
              value={node.channelIndex}
              disabled={disabled}
              onChange={(event) =>
                onChange({ ...node, channelIndex: Number(event.target.value) })
              }
            >
              {Array.from({ length: 16 }, (_, index) => (
                <option key={index} value={index}>
                  {inputChannelLabels[index] ?? `CH ${index + 1}`}
                </option>
              ))}
            </select>
          </label>
        )}
        {node.kind === "affine" && (
          <>
            <SourceSelect
              node={node}
              nodes={nodes}
              value={node.input}
              disabled={disabled}
              onChange={(input) => onChange({ ...node, input })}
            />
            <NumberField
              nodeId={node.id}
              label="增益"
              value={node.gain}
              disabled={disabled}
              onChange={(gain) => onChange({ ...node, gain })}
            />
            <NumberField
              nodeId={node.id}
              label="偏移"
              value={node.offset}
              disabled={disabled}
              onChange={(offset) => onChange({ ...node, offset })}
            />
          </>
        )}
        {node.kind === "clamp" && (
          <>
            <SourceSelect
              node={node}
              nodes={nodes}
              value={node.input}
              disabled={disabled}
              onChange={(input) => onChange({ ...node, input })}
            />
            <NumberField
              nodeId={node.id}
              label="下限"
              value={node.minimum}
              disabled={disabled}
              onChange={(minimum) => onChange({ ...node, minimum })}
            />
            <NumberField
              nodeId={node.id}
              label="上限"
              value={node.maximum}
              disabled={disabled}
              onChange={(maximum) => onChange({ ...node, maximum })}
            />
          </>
        )}
        {node.kind === "ema" && (
          <>
            <SourceSelect
              node={node}
              nodes={nodes}
              value={node.input}
              disabled={disabled}
              onChange={(input) => onChange({ ...node, input })}
            />
            <NumberField
              nodeId={node.id}
              label="Alpha"
              value={node.alpha}
              min={0.001}
              max={1}
              step={0.001}
              disabled={disabled}
              onChange={(alpha) => onChange({ ...node, alpha })}
            />
          </>
        )}
        {node.kind === "moving_average" && (
          <>
            <SourceSelect
              node={node}
              nodes={nodes}
              value={node.input}
              disabled={disabled}
              onChange={(input) => onChange({ ...node, input })}
            />
            <NumberField
              nodeId={node.id}
              label="窗口"
              value={node.windowSize}
              min={1}
              max={256}
              step={1}
              disabled={disabled}
              onChange={(windowSize) => onChange({ ...node, windowSize })}
            />
          </>
        )}
        {node.kind === "math" && (
          <>
            <SourceSelect
              label="左输入"
              node={node}
              nodes={nodes}
              value={node.left}
              disabled={disabled}
              onChange={(left) => onChange({ ...node, left })}
            />
            <label>
              <span className="field-label">运算</span>
              <select
                aria-label={`${node.id} 运算`}
                name={`processing-${node.id}-operation`}
                value={node.operation}
                disabled={disabled}
                onChange={(event) =>
                  onChange({
                    ...node,
                    operation: event.target.value as typeof node.operation,
                  })
                }
              >
                <option value="add">加</option>
                <option value="subtract">减</option>
                <option value="multiply">乘</option>
                <option value="divide">除</option>
              </select>
            </label>
            <SourceSelect
              label="右输入"
              node={node}
              nodes={nodes}
              value={node.right}
              disabled={disabled}
              onChange={(right) => onChange({ ...node, right })}
            />
          </>
        )}
        {node.kind === "bytes_to_number" && (
          <>
            <NumericTypeField
              nodeId={node.id}
              value={node.numericType}
              disabled={disabled}
              onChange={(numericType) => {
                const byteWidth = numericTypeByteWidth(numericType);
                const fallback = node.inputs.at(-1) ?? "";
                onChange({
                  ...node,
                  numericType,
                  inputs: Array.from(
                    { length: byteWidth },
                    (_, index) => node.inputs[index] ?? fallback,
                  ),
                });
              }}
            />
            <EndiannessField
              nodeId={node.id}
              value={node.endianness}
              disabled={disabled}
              onChange={(endianness) => onChange({ ...node, endianness })}
            />
            {node.inputs.map((input, index) => (
              <SourceSelect
                key={index}
                label={`字节 ${index + 1}`}
                node={node}
                nodes={nodes}
                value={input}
                disabled={disabled}
                onChange={(nextInput) =>
                  onChange({
                    ...node,
                    inputs: node.inputs.map((value, inputIndex) =>
                      inputIndex === index ? nextInput : value,
                    ),
                  })
                }
              />
            ))}
          </>
        )}
        {node.kind === "number_to_byte" && (
          <>
            <SourceSelect
              node={node}
              nodes={nodes}
              value={node.input}
              disabled={disabled}
              onChange={(input) => onChange({ ...node, input })}
            />
            <NumericTypeField
              nodeId={node.id}
              value={node.numericType}
              disabled={disabled}
              onChange={(numericType) =>
                onChange({
                  ...node,
                  numericType,
                  byteIndex: Math.min(node.byteIndex, numericTypeByteWidth(numericType) - 1),
                })
              }
            />
            <EndiannessField
              nodeId={node.id}
              value={node.endianness}
              disabled={disabled}
              onChange={(endianness) => onChange({ ...node, endianness })}
            />
            <label>
              <span className="field-label">输出字节</span>
              <select
                aria-label={`${node.id} 输出字节`}
                name={`processing-${node.id}-byte-index`}
                value={node.byteIndex}
                disabled={disabled}
                onChange={(event) =>
                  onChange({ ...node, byteIndex: Number(event.target.value) })
                }
              >
                {Array.from(
                  { length: numericTypeByteWidth(node.numericType) },
                  (_, index) => (
                    <option key={index} value={index}>
                      B{index} · 第 {index + 1} 字节
                    </option>
                  ),
                )}
              </select>
            </label>
          </>
        )}
        {node.kind === "output" && (
          <>
            <SourceSelect
              node={node}
              nodes={nodes}
              value={node.input}
              disabled={disabled}
              onChange={(input) => onChange({ ...node, input })}
            />
            <TextField
              label="名称"
              ariaLabel={`${node.id} 输出名称`}
              value={node.name}
              maxLength={64}
              disabled={disabled}
              onChange={(name) => onChange({ ...node, name })}
            />
            <label className="processing-color-field">
              <span className="field-label">颜色</span>
              <input
                type="color"
                aria-label={`${node.id} 输出颜色`}
                value={node.color}
                disabled={disabled}
                onChange={(event) => onChange({ ...node, color: event.target.value })}
              />
            </label>
          </>
        )}
      </div>
    </article>
  );
}

interface NumericTypeFieldProps {
  nodeId: string;
  value: DataNumericType;
  disabled: boolean;
  onChange(value: DataNumericType): void;
}

function NumericTypeField({ nodeId, value, disabled, onChange }: NumericTypeFieldProps) {
  return (
    <label>
      <span className="field-label">数值类型</span>
      <select
        aria-label={`${nodeId} 数值类型`}
        name={`processing-${nodeId}-numeric-type`}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as DataNumericType)}
      >
        {DATA_NUMERIC_TYPE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

interface EndiannessFieldProps {
  nodeId: string;
  value: DataConverterEndianness;
  disabled: boolean;
  onChange(value: DataConverterEndianness): void;
}

function EndiannessField({ nodeId, value, disabled, onChange }: EndiannessFieldProps) {
  return (
    <label>
      <span className="field-label">字节序</span>
      <select
        aria-label={`${nodeId} 字节序`}
        name={`processing-${nodeId}-endianness`}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as DataConverterEndianness)}
      >
        <option value="le">Little Endian</option>
        <option value="be">Big Endian</option>
      </select>
    </label>
  );
}

interface SourceSelectProps {
  label?: string;
  node: ProcessingNode;
  nodes: readonly ProcessingNode[];
  value: string;
  disabled: boolean;
  onChange(value: string): void;
}

function SourceSelect({
  label = "输入",
  node,
  nodes,
  value,
  disabled,
  onChange,
}: SourceSelectProps) {
  const options = nodes.filter(
    (candidate) => candidate.id !== node.id && candidate.kind !== "output",
  );
  return (
    <label>
      <span className="field-label">{label}</span>
      <select
        aria-label={`${node.id} ${label}`}
        name={`processing-${node.id}-${label}`}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.id} · {nodeKindLabel(candidate.kind)}
          </option>
        ))}
      </select>
    </label>
  );
}

interface NumberFieldProps {
  nodeId: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number | "any";
  disabled: boolean;
  onChange(value: number): void;
}

function NumberField({
  nodeId,
  label,
  value,
  min,
  max,
  step = "any",
  disabled,
  onChange,
}: NumberFieldProps) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    if (draft.trim() === "") {
      setDraft(String(value));
      return;
    }
    const nextValue = Number(draft);
    if (!Number.isFinite(nextValue)) {
      setDraft(String(value));
      return;
    }
    if (nextValue !== value) {
      onChange(nextValue);
    }
  };

  return (
    <label>
      <span className="field-label">{label}</span>
      <input
        type="number"
        aria-label={`${nodeId} ${label}`}
        name={`processing-${nodeId}-${label}`}
        value={draft}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

interface TextFieldProps {
  label: string;
  ariaLabel: string;
  value: string;
  maxLength: number;
  disabled: boolean;
  onChange(value: string): void;
}

function TextField({
  label,
  ariaLabel,
  value,
  maxLength,
  disabled,
  onChange,
}: TextFieldProps) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = () => {
    if (draft !== value) {
      onChange(draft);
    }
  };

  return (
    <label>
      <span className="field-label">{label}</span>
      <input
        aria-label={ariaLabel}
        maxLength={maxLength}
        value={draft}
        disabled={disabled}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

function createProcessingNode(
  kind: NodeKind,
  nodes: readonly ProcessingNode[],
): ProcessingNode | null {
  const id = nextNodeId(nodes);
  const sources = nodes.filter((node) => node.kind !== "output");
  const source = sources.at(-1)?.id;
  if (kind !== "input" && !source) {
    return null;
  }
  const input = source ?? "";
  switch (kind) {
    case "input":
      return { id, kind, channelIndex: nextInputChannel(nodes) };
    case "affine":
      return { id, kind, input, gain: 1, offset: 0 };
    case "clamp":
      return { id, kind, input, minimum: -1, maximum: 1 };
    case "ema":
      return { id, kind, input, alpha: 0.2 };
    case "moving_average":
      return { id, kind, input, windowSize: 8 };
    case "math":
      return { id, kind, left: input, right: input, operation: "add" };
    case "bytes_to_number":
      return {
        id,
        kind,
        inputs: [input, input],
        numericType: "u16",
        endianness: "le",
      };
    case "number_to_byte":
      return {
        id,
        kind,
        input,
        numericType: "u16",
        endianness: "le",
        byteIndex: 0,
      };
    case "output": {
      const outputIndex = nodes.filter((node) => node.kind === "output").length;
      return {
        id,
        kind,
        input,
        name: `OUT ${outputIndex + 1}`,
        color: OUTPUT_COLORS[outputIndex % OUTPUT_COLORS.length] ?? "#46d89c",
      };
    }
  }
}

function nextNodeId(nodes: readonly ProcessingNode[]): string {
  const usedIds = new Set(nodes.map((node) => node.id));
  for (let index = 1; index <= MAX_PROCESSING_NODES + 1; index += 1) {
    const id = `node-${index}`;
    if (!usedIds.has(id)) {
      return id;
    }
  }
  return `node-${nodes.length + 1}`;
}

function nextInputChannel(nodes: readonly ProcessingNode[]): number {
  const usedChannels = new Set(
    nodes.filter((node) => node.kind === "input").map((node) => node.channelIndex),
  );
  for (let index = 0; index < 16; index += 1) {
    if (!usedChannels.has(index)) {
      return index;
    }
  }
  return 0;
}

function nodeDependencies(node: ProcessingNode): string[] {
  switch (node.kind) {
    case "input":
      return [];
    case "math":
      return [node.left, node.right];
    case "bytes_to_number":
      return [...node.inputs];
    default:
      return [node.input];
  }
}

function nodeKindLabel(kind: NodeKind): string {
  return NODE_KINDS.find((item) => item.kind === kind)?.label ?? kind;
}

function processingStatusLabel(status: "disabled" | "ready" | "suspended"): string {
  switch (status) {
    case "ready":
      return "运行中";
    case "suspended":
      return "已熔断";
    default:
      return "未启用";
  }
}
