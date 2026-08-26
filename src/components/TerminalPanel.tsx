import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDownToLine,
  Blocks,
  Bookmark,
  Braces,
  Check,
  CirclePause,
  Copy,
  Download,
  Eraser,
  FileUp,
  FolderOpen,
  History,
  Play,
  Search,
  SearchX,
  Send,
  Square,
  TerminalSquare,
  Timer,
  TriangleAlert,
  Trash2,
  X,
} from "lucide-react";
import {
  COMMAND_VARIABLE_INSERTIONS,
  compileCommandTemplate,
  MAX_COMMAND_TEMPLATE_BYTES,
  renderCommandTemplate,
} from "../core/commandTemplate";
import {
  MAX_COMMAND_INTERVAL_MS,
  MAX_COMMAND_REPEAT_COUNT,
  MIN_COMMAND_INTERVAL_MS,
} from "../core/commandWorkflow";
import { isAutoResponderActive } from "../core/autoResponder";
import { formatHex } from "../core/codec";
import {
  COMMAND_CHECKSUM_MODES,
  calculateChecksums,
  MAX_CHECKSUM_INPUT_CHARACTERS,
  type CommandChecksumMode,
  type ChecksumInputMode,
  type ChecksumResult,
} from "../core/checksum";
import {
  convertData,
  DATA_NUMERIC_TYPE_OPTIONS,
  MAX_DATA_CONVERTER_INPUT_CHARACTERS,
  numericTypeByteWidth,
  type DataConverterDirection,
  type DataConverterEndianness,
  type DataConverterResult,
  type DataNumericType,
} from "../core/dataConverter";
import { getHorizontalTabTarget } from "../core/tabNavigation";
import {
  formatTerminalTime,
  parseTerminalTimeMode,
  TERMINAL_TIME_MODE_STORAGE_KEY,
  terminalTimeDateTime,
  type TerminalTimeMode,
} from "../core/terminalTime";
import {
  filterTerminalEntries,
  findTerminalLiteralMatches,
  MAX_TERMINAL_SEARCH_CHARACTERS,
  terminalEntryPayload,
  type TerminalDirectionFilter,
} from "../core/terminalSearch";
import { formatModbusRtuFrame, type ModbusRtuRequest } from "../core/modbusRtu";
import { selectSerialFilePath } from "../services/serialClient";
import { useWorkbenchStore } from "../store/workbenchStore";
import type { DisplayMode, LineEnding, SerialFileSendStatus } from "../types/serial";
import type {
  CommandHistoryEntry,
  CommandTaskSnapshot,
  QuickCommand,
  TerminalEntry,
} from "../types/workbench";
import { ModbusRtuBuilder } from "./ModbusRtuBuilder";
import { QuickCommandPopover } from "./QuickCommandPopover";

const TerminalExportMenu = lazy(() => import("./TerminalExportMenu"));

type RepeatMode = "count" | "continuous";
const COMMAND_REFERENCE_VIEWS = ["variables", "ascii", "converter", "checksum"] as const;
type CommandReferenceView = (typeof COMMAND_REFERENCE_VIEWS)[number];

const TERMINAL_TIME_MODE_OPTIONS: readonly {
  mode: TerminalTimeMode;
  label: string;
  description: string;
}[] = [
  { mode: "absolute", label: "ABS", description: "绝对时间" },
  { mode: "relative", label: "REL", description: "相对缓存起点" },
  { mode: "interval", label: "ΔT", description: "距上一条可见记录" },
];

const TERMINAL_LATEST_THRESHOLD_PX = 24;
const MAX_ASCII_SEARCH_CHARACTERS = 32;

interface AsciiReferenceEntry {
  character: string;
  code: number;
  hex: string;
  name: string;
}

const ASCII_CONTROL_CHARACTERS = [
  ["NUL", "空字符"],
  ["SOH", "标题开始"],
  ["STX", "正文开始"],
  ["ETX", "正文结束"],
  ["EOT", "传输结束"],
  ["ENQ", "查询"],
  ["ACK", "确认"],
  ["BEL", "响铃"],
  ["BS", "退格"],
  ["HT", "水平制表"],
  ["LF", "换行"],
  ["VT", "垂直制表"],
  ["FF", "换页"],
  ["CR", "回车"],
  ["SO", "移出"],
  ["SI", "移入"],
  ["DLE", "数据链路转义"],
  ["DC1", "设备控制一"],
  ["DC2", "设备控制二"],
  ["DC3", "设备控制三"],
  ["DC4", "设备控制四"],
  ["NAK", "否认"],
  ["SYN", "同步空闲"],
  ["ETB", "传输块结束"],
  ["CAN", "取消"],
  ["EM", "介质结束"],
  ["SUB", "替换"],
  ["ESC", "转义"],
  ["FS", "文件分隔"],
  ["GS", "组分隔"],
  ["RS", "记录分隔"],
  ["US", "单元分隔"],
  ["SP", "空格"],
] as const;

const ASCII_PUNCTUATION_NAMES: Readonly<Record<string, string>> = {
  "!": "感叹号",
  "\"": "双引号",
  "#": "井号",
  "$": "美元符号",
  "%": "百分号",
  "&": "与号",
  "'": "单引号",
  "(": "左圆括号",
  ")": "右圆括号",
  "*": "星号",
  "+": "加号",
  ",": "逗号",
  "-": "连字符",
  ".": "句点",
  "/": "斜杠",
  ":": "冒号",
  ";": "分号",
  "<": "小于号",
  "=": "等号",
  ">": "大于号",
  "?": "问号",
  "@": "艾特符号",
  "[": "左方括号",
  "\\": "反斜杠",
  "]": "右方括号",
  "^": "脱字符",
  "_": "下划线",
  "`": "反引号",
  "{": "左花括号",
  "|": "竖线",
  "}": "右花括号",
  "~": "波浪号",
};

const ASCII_REFERENCE_ENTRIES: readonly AsciiReferenceEntry[] = Array.from(
  { length: 128 },
  (_, code) => {
    if (code <= 32) {
      const [character, name] = ASCII_CONTROL_CHARACTERS[code]!;
      return { character, code, hex: code.toString(16).toUpperCase().padStart(2, "0"), name };
    }
    if (code === 127) {
      return { character: "DEL", code, hex: "7F", name: "删除" };
    }
    const character = String.fromCharCode(code);
    let name = ASCII_PUNCTUATION_NAMES[character] ?? "可打印字符";
    if (code >= 48 && code <= 57) {
      name = `数字 ${character}`;
    } else if (code >= 65 && code <= 90) {
      name = `大写字母 ${character}`;
    } else if (code >= 97 && code <= 122) {
      name = `小写字母 ${character}`;
    }
    return {
      character,
      code,
      hex: code.toString(16).toUpperCase().padStart(2, "0"),
      name,
    };
  },
);

function filterAsciiReferenceEntries(query: string): readonly AsciiReferenceEntry[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return ASCII_REFERENCE_ENTRIES;
  }
  if (trimmed.length === 1) {
    const code = trimmed.charCodeAt(0);
    if (code >= 33 && code <= 126) {
      return ASCII_REFERENCE_ENTRIES.slice(code, code + 1);
    }
  }
  if (/^\d{1,3}$/.test(trimmed)) {
    const code = Number(trimmed);
    return code <= 127 ? ASCII_REFERENCE_ENTRIES.slice(code, code + 1) : [];
  }
  const normalized = trimmed.toUpperCase();
  const hexMatch = /^(?:0X)?([0-9A-F]{2})$/.exec(normalized);
  const hexDigits = hexMatch?.[1];
  if (hexDigits && (normalized.startsWith("0X") || /[A-F]/.test(hexDigits))) {
    const code = Number.parseInt(hexDigits, 16);
    return code <= 127 ? ASCII_REFERENCE_ENTRIES.slice(code, code + 1) : [];
  }
  return ASCII_REFERENCE_ENTRIES.filter((entry) => (
    entry.character.toUpperCase().includes(normalized)
    || entry.hex === normalized
    || entry.name.toUpperCase().includes(normalized)
  ));
}

function isTerminalViewportAtLatest(viewport: HTMLElement): boolean {
  const distanceFromLatest = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
  return distanceFromLatest <= TERMINAL_LATEST_THRESHOLD_PX;
}

interface CommandDraft {
  value: string;
  mode: DisplayMode;
  lineEnding: LineEnding;
  checksumMode?: CommandChecksumMode;
}

interface CommandTemplatePreview {
  byteCount: number;
  variableCount: number;
  checksumHex: string;
  error: string;
}

interface ChecksumPreview {
  result: ChecksumResult | null;
  error: string;
}

interface DataConverterPreview {
  result: DataConverterResult | null;
  error: string;
}

interface CopiedConverterOutput {
  target: "hex" | "numbers";
  value: string;
}

export function TerminalPanel() {
  const entries = useWorkbenchStore((state) => state.terminalEntries);
  const displayMode = useWorkbenchStore((state) => state.displayMode);
  const sendMode = useWorkbenchStore((state) => state.sendMode);
  const lineEnding = useWorkbenchStore((state) => state.lineEnding);
  const commandChecksum = useWorkbenchStore((state) => state.commandChecksum);
  const terminalRxRecordMode = useWorkbenchStore((state) => state.terminalRxRecordMode);
  const terminalRxLineEnding = useWorkbenchStore((state) => state.terminalRxLineEnding);
  const terminalRxTextEncoding = useWorkbenchStore((state) => state.terminalRxTextEncoding);
  const commandHistory = useWorkbenchStore((state) => state.commandHistory);
  const commandTask = useWorkbenchStore((state) => state.commandTask);
  const autoResponder = useWorkbenchStore((state) => state.autoResponder);
  const modbusTransaction = useWorkbenchStore((state) => state.modbusTransaction);
  const modbusTransactions = useWorkbenchStore((state) => state.modbusTransactions);
  const serialFileSend = useWorkbenchStore((state) => state.serialFileSend);
  const serialControlLineOperation = useWorkbenchStore(
    (state) => state.serialControlLineOperation,
  );
  const isSendingCommand = useWorkbenchStore((state) => state.isSendingCommand);
  const commandSendOrigin = useWorkbenchStore((state) => state.commandSendOrigin);
  const terminalPaused = useWorkbenchStore((state) => state.terminalPaused);
  const terminalAutoScroll = useWorkbenchStore((state) => state.terminalAutoScroll);
  const connectionStatus = useWorkbenchStore((state) => state.connectionStatus);
  const source = useWorkbenchStore((state) => state.source);
  const isNativeRuntime = useWorkbenchStore((state) => state.isNativeRuntime);
  const isWorkspaceTransitioning = useWorkbenchStore(
    (state) => state.workspaceTransitionStatus !== "idle",
  );
  const setDisplayMode = useWorkbenchStore((state) => state.setDisplayMode);
  const setSendMode = useWorkbenchStore((state) => state.setSendMode);
  const setLineEnding = useWorkbenchStore((state) => state.setLineEnding);
  const setCommandChecksum = useWorkbenchStore((state) => state.setCommandChecksum);
  const setTerminalRxRecordMode = useWorkbenchStore(
    (state) => state.setTerminalRxRecordMode,
  );
  const setTerminalRxLineEnding = useWorkbenchStore(
    (state) => state.setTerminalRxLineEnding,
  );
  const setTerminalRxTextEncoding = useWorkbenchStore(
    (state) => state.setTerminalRxTextEncoding,
  );
  const setTerminalPaused = useWorkbenchStore((state) => state.setTerminalPaused);
  const clearTerminal = useWorkbenchStore((state) => state.clearTerminal);
  const clearCommandHistory = useWorkbenchStore((state) => state.clearCommandHistory);
  const send = useWorkbenchStore((state) => state.send);
  const startFileSend = useWorkbenchStore((state) => state.startFileSend);
  const cancelFileSend = useWorkbenchStore((state) => state.cancelFileSend);
  const startPeriodicSend = useWorkbenchStore((state) => state.startPeriodicSend);
  const stopPeriodicSend = useWorkbenchStore((state) => state.stopPeriodicSend);
  const startModbusTransaction = useWorkbenchStore((state) => state.startModbusTransaction);
  const cancelModbusTransaction = useWorkbenchStore((state) => state.cancelModbusTransaction);
  const clearModbusTransactions = useWorkbenchStore((state) => state.clearModbusTransactions);
  const viewportRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const fileSendTriggerRef = useRef<HTMLButtonElement>(null);
  const modbusTriggerRef = useRef<HTMLButtonElement>(null);
  const quickCommandTriggerRef = useRef<HTMLButtonElement>(null);
  const variableTriggerRef = useRef<HTMLButtonElement>(null);
  const variableListRef = useRef<HTMLDivElement>(null);
  const exportControlRef = useRef<HTMLDivElement>(null);
  const exportTriggerRef = useRef<HTMLButtonElement>(null);
  const asciiSearchRef = useRef<HTMLInputElement>(null);
  const converterInputRef = useRef<HTMLTextAreaElement>(null);
  const checksumInputRef = useRef<HTMLTextAreaElement>(null);
  const historyCursorRef = useRef<number | null>(null);
  const historyDraftRef = useRef<CommandDraft | null>(null);
  const pendingSelectionRef = useRef<number | null>(null);
  const previousTerminalAutoScrollRef = useRef(terminalAutoScroll);
  const [message, setMessage] = useState("");
  const [sendError, setSendError] = useState("");
  const [manualSendPending, setManualSendPending] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [fileSendOpen, setFileSendOpen] = useState(false);
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [selectedFileName, setSelectedFileName] = useState("");
  const [fileSelectionPending, setFileSelectionPending] = useState(false);
  const [fileStartPending, setFileStartPending] = useState(false);
  const [fileSendError, setFileSendError] = useState("");
  const [modbusOpen, setModbusOpen] = useState(false);
  const [quickCommandsOpen, setQuickCommandsOpen] = useState(false);
  const [variablesOpen, setVariablesOpen] = useState(false);
  const [commandReferenceView, setCommandReferenceView] =
    useState<CommandReferenceView>("variables");
  const [asciiSearchQuery, setAsciiSearchQuery] = useState("");
  const [converterDirection, setConverterDirection] =
    useState<DataConverterDirection>("bytes-to-numbers");
  const [converterNumericType, setConverterNumericType] = useState<DataNumericType>("f32");
  const [converterEndianness, setConverterEndianness] =
    useState<DataConverterEndianness>("le");
  const [converterInput, setConverterInput] = useState("");
  const [converterCopyError, setConverterCopyError] = useState("");
  const [copiedConverterOutput, setCopiedConverterOutput] =
    useState<CopiedConverterOutput | null>(null);
  const [checksumInputMode, setChecksumInputMode] = useState<ChecksumInputMode>("hex");
  const [checksumInput, setChecksumInput] = useState("");
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [intervalText, setIntervalText] = useState("1000");
  const [repeatMode, setRepeatMode] = useState<RepeatMode>("count");
  const [repeatCountText, setRepeatCountText] = useState("10");
  const [searchQuery, setSearchQuery] = useState("");
  const [directionFilter, setDirectionFilter] = useState<TerminalDirectionFilter>("all");
  const [exportOpen, setExportOpen] = useState(false);
  const [terminalTimeMode, setTerminalTimeMode] = useState<TerminalTimeMode>(() =>
    parseTerminalTimeMode(localStorage.getItem(TERMINAL_TIME_MODE_STORAGE_KEY)),
  );
  const [terminalFollowSuspended, setTerminalFollowSuspended] = useState(false);
  const hasPayload = message.length > 0 || lineEnding !== "none";
  const hasSendableFrame = hasPayload || commandChecksum !== "none";
  const templatePreview = useMemo(
    () => previewCommandTemplate(message, sendMode, lineEnding, commandChecksum),
    [commandChecksum, lineEnding, message, sendMode],
  );
  const availableVariables = useMemo(
    () => COMMAND_VARIABLE_INSERTIONS.filter((item) => item.mode === sendMode),
    [sendMode],
  );
  const visibleAsciiEntries = useMemo(
    () => filterAsciiReferenceEntries(asciiSearchQuery),
    [asciiSearchQuery],
  );
  const checksumPreview = useMemo(
    () => previewChecksum(checksumInput, checksumInputMode),
    [checksumInput, checksumInputMode],
  );
  const converterPreview = useMemo(
    () => previewDataConversion(
      converterInput,
      converterDirection,
      converterNumericType,
      converterEndianness,
    ),
    [converterDirection, converterEndianness, converterInput, converterNumericType],
  );
  const converterError = converterPreview.error || converterCopyError;
  const converterUsesEndianness = numericTypeByteWidth(converterNumericType) > 1;
  const converterHexCopied =
    copiedConverterOutput?.target === "hex" &&
    copiedConverterOutput.value === converterPreview.result?.normalizedHex;
  const converterNumbersCopied =
    copiedConverterOutput?.target === "numbers" &&
    copiedConverterOutput.value === converterPreview.result?.numericText;
  const visibleError = templatePreview.error || sendError;
  const taskActive = commandTask.status === "running" || commandTask.status === "stopping";
  const autoResponderActive = isAutoResponderActive(autoResponder);
  const modbusTransactionActive = modbusTransaction.status !== "idle";
  const fileSendActive = isFileSendActive(serialFileSend.status);
  const manualSendBlocked =
    serialControlLineOperation !== "idle" ||
    fileSendActive ||
    modbusTransactionActive ||
    manualSendPending ||
    (isSendingCommand && commandSendOrigin !== "auto-responder");
  const workflowVisible = workflowOpen || taskActive;
  const canStartPeriodic =
    connectionStatus === "connected" &&
    !templatePreview.error &&
    templatePreview.byteCount > 0 &&
    !isWorkspaceTransitioning &&
    !isSendingCommand &&
    !autoResponderActive &&
    serialControlLineOperation === "idle" &&
    !fileSendActive &&
    !modbusTransactionActive &&
    !taskActive;
  const canExecuteModbus =
    connectionStatus === "connected" &&
    serialControlLineOperation === "idle" &&
    !isWorkspaceTransitioning &&
    !isSendingCommand &&
    !autoResponderActive &&
    !fileSendActive &&
    !modbusTransactionActive &&
    !taskActive;
  const canStartFileSend =
    isNativeRuntime &&
    source === "serial" &&
    connectionStatus === "connected" &&
    serialControlLineOperation === "idle" &&
    selectedFilePath.length > 0 &&
    !fileSelectionPending &&
    !fileStartPending &&
    !isWorkspaceTransitioning &&
    !isSendingCommand &&
    !autoResponderActive &&
    !fileSendActive &&
    !modbusTransactionActive &&
    !taskActive;
  const fileSendHasSnapshot = serialFileSend.jobId > 0 && serialFileSend.status !== "idle";
  const fileSendProgressMax = Math.max(1, serialFileSend.totalBytes);
  const fileSendProgressValue =
    serialFileSend.totalBytes > 0
      ? Math.min(serialFileSend.transmittedBytes, serialFileSend.totalBytes)
      : serialFileSend.status === "completed"
        ? 1
        : 0;
  const fileSendPercent = (fileSendProgressValue / fileSendProgressMax) * 100;
  const visibleEntries = useMemo(
    () =>
      filterTerminalEntries(entries, {
        direction: directionFilter,
        displayMode,
        query: searchQuery,
      }),
    [directionFilter, displayMode, entries, searchQuery],
  );
  const filtersActive = searchQuery.length > 0 || directionFilter !== "all";
  const recordSummary = filtersActive
    ? `${visibleEntries.length} / ${entries.length} 条记录`
    : `${entries.length} 条记录`;
  const clearTerminalLabel = filtersActive ? "清空全部终端记录" : "清空终端";
  const lastVisibleEntryId = visibleEntries.at(-1)?.id;
  const terminalTimeOrigin = entries.at(0)?.timestamp;
  const rowVirtualizer = useVirtualizer({
    count: visibleEntries.length,
    getScrollElement: () => viewportRef.current,
    getItemKey: (index) => visibleEntries[index]?.id ?? index,
    estimateSize: () => 24,
    overscan: 12,
    useFlushSync: false,
    anchorTo: "end",
  });

  useEffect(() => {
    localStorage.setItem(TERMINAL_TIME_MODE_STORAGE_KEY, terminalTimeMode);
  }, [terminalTimeMode]);

  useEffect(() => {
    if (
      terminalAutoScroll &&
      !terminalPaused &&
      !terminalFollowSuspended &&
      visibleEntries.length > 0
    ) {
      rowVirtualizer.scrollToIndex(visibleEntries.length - 1, { align: "end" });
    }
  }, [
    lastVisibleEntryId,
    rowVirtualizer,
    terminalAutoScroll,
    terminalFollowSuspended,
    terminalPaused,
    visibleEntries.length,
  ]);

  useEffect(() => {
    if (entries.length === 0) {
      setTerminalFollowSuspended(false);
      setExportOpen(false);
    }
  }, [entries.length]);

  useEffect(() => {
    if (!exportOpen) {
      return undefined;
    }
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!exportControlRef.current?.contains(event.target as Node)) {
        setExportOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [exportOpen]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!terminalAutoScroll && viewport && visibleEntries.length > 0) {
      setTerminalFollowSuspended(!isTerminalViewportAtLatest(viewport));
    }
  }, [lastVisibleEntryId, terminalAutoScroll, visibleEntries.length]);

  useEffect(() => {
    const wasAutoScrollEnabled = previousTerminalAutoScrollRef.current;
    previousTerminalAutoScrollRef.current = terminalAutoScroll;
    if (terminalAutoScroll && !wasAutoScrollEnabled) {
      setTerminalFollowSuspended(false);
    }
  }, [terminalAutoScroll]);

  useEffect(() => {
    if (["running", "stopping", "error"].includes(commandTask.status)) {
      setWorkflowOpen(true);
    }
  }, [commandTask.status]);

  useEffect(() => {
    if (!fileSendOpen && !historyOpen && !modbusOpen && !quickCommandsOpen && !variablesOpen) {
      return undefined;
    }
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!composerRef.current?.contains(event.target as Node)) {
        setHistoryOpen(false);
        setFileSendOpen(false);
        setModbusOpen(false);
        setQuickCommandsOpen(false);
        setVariablesOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [fileSendOpen, historyOpen, modbusOpen, quickCommandsOpen, variablesOpen]);

  useEffect(() => {
    const selection = pendingSelectionRef.current;
    const textarea = textareaRef.current;
    if (selection === null || !textarea) {
      return;
    }
    pendingSelectionRef.current = null;
    textarea.focus();
    textarea.setSelectionRange(selection, selection);
  }, [message, modbusOpen, quickCommandsOpen, variablesOpen]);

  useEffect(() => {
    if (!variablesOpen) {
      return;
    }
    switch (commandReferenceView) {
      case "ascii":
        asciiSearchRef.current?.focus();
        break;
      case "checksum":
        checksumInputRef.current?.focus();
        break;
      case "converter":
        converterInputRef.current?.focus();
        break;
      case "variables":
        variableListRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
        break;
    }
  }, [availableVariables, commandReferenceView, variablesOpen]);

  useEffect(() => {
    if (isWorkspaceTransitioning) {
      setModbusOpen(false);
      setQuickCommandsOpen(false);
      setFileSendOpen(false);
      setSelectedFilePath("");
      setSelectedFileName("");
      setFileSendError("");
    }
  }, [isWorkspaceTransitioning]);

  const resetHistoryNavigation = () => {
    historyCursorRef.current = null;
    historyDraftRef.current = null;
  };

  const chooseFileToSend = async () => {
    setFileSelectionPending(true);
    setFileSendError("");
    try {
      const path = await selectSerialFilePath();
      if (path) {
        setSelectedFilePath(path);
        setSelectedFileName(fileNameFromPath(path));
      }
    } catch (error) {
      setFileSendError(error instanceof Error ? error.message : String(error));
    } finally {
      setFileSelectionPending(false);
    }
  };

  const beginFileSend = async () => {
    if (!selectedFilePath || fileStartPending) {
      return;
    }
    setFileSendError("");
    setFileStartPending(true);
    try {
      await startFileSend(selectedFilePath);
    } catch (error) {
      setFileSendError(error instanceof Error ? error.message : String(error));
    } finally {
      setFileStartPending(false);
    }
  };

  const handleCommandReferenceTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    current: CommandReferenceView,
  ) => {
    const target = getHorizontalTabTarget(COMMAND_REFERENCE_VIEWS, current, event.key);
    if (target !== undefined) {
      event.preventDefault();
      setCommandReferenceView(target);
    }
  };

  const copyConverterOutput = async (
    target: CopiedConverterOutput["target"],
    value: string,
  ) => {
    if (!value) {
      return;
    }
    setConverterCopyError("");
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("当前环境不支持剪贴板写入");
      }
      await navigator.clipboard.writeText(value);
      setCopiedConverterOutput({ target, value });
    } catch (error) {
      setCopiedConverterOutput(null);
      setConverterCopyError(
        error instanceof Error ? `复制失败：${error.message}` : "复制失败，请手动选择结果",
      );
    }
  };

  const resetConverterFeedback = () => {
    setConverterCopyError("");
    setCopiedConverterOutput(null);
  };

  const applyDraft = (draft: CommandDraft) => {
    setMessage(draft.value);
    setSendMode(draft.mode);
    setLineEnding(draft.lineEnding);
    if (draft.checksumMode !== undefined) {
      setCommandChecksum(draft.checksumMode);
    }
    setSendError("");
    setVariablesOpen(false);
  };

  const insertVariable = (token: string) => {
    const textarea = textareaRef.current;
    const selectionStart = textarea?.selectionStart ?? message.length;
    const selectionEnd = textarea?.selectionEnd ?? selectionStart;
    const nextMessage =
      message.slice(0, selectionStart) + token + message.slice(selectionEnd);
    pendingSelectionRef.current = selectionStart + token.length;
    setMessage(nextMessage);
    setSendError("");
    setVariablesOpen(false);
    resetHistoryNavigation();
  };

  const applyModbusFrame = (frame: Uint8Array) => {
    if (isWorkspaceTransitioning) {
      return;
    }
    const value = formatModbusRtuFrame(frame);
    pendingSelectionRef.current = value.length;
    resetHistoryNavigation();
    setHistoryOpen(false);
    setModbusOpen(false);
    applyDraft({ value, mode: "hex", lineEnding: "none", checksumMode: "none" });
  };

  const executeModbusTransaction = (request: ModbusRtuRequest, timeoutMs: number) =>
    startModbusTransaction(request, timeoutMs);

  const applyQuickCommand = (command: QuickCommand) => {
    if (isWorkspaceTransitioning) {
      return;
    }
    pendingSelectionRef.current = command.template.length;
    resetHistoryNavigation();
    setHistoryOpen(false);
    setModbusOpen(false);
    setQuickCommandsOpen(false);
    applyDraft({
      value: command.template,
      mode: command.mode,
      lineEnding: command.lineEnding,
    });
  };

  const recallHistory = (index: number) => {
    const entry = commandHistory[index];
    if (!entry) {
      return;
    }
    if (historyCursorRef.current === null) {
      historyDraftRef.current = {
        value: message,
        mode: sendMode,
        lineEnding,
        checksumMode: commandChecksum,
      };
    }
    historyCursorRef.current = index;
    applyDraft(entry);
  };

  const navigateHistory = (direction: "previous" | "next"): boolean => {
    if (commandHistory.length === 0) {
      return false;
    }
    const cursor = historyCursorRef.current;
    if (direction === "previous") {
      if (cursor === null) {
        historyDraftRef.current = {
          value: message,
          mode: sendMode,
          lineEnding,
          checksumMode: commandChecksum,
        };
        historyCursorRef.current = commandHistory.length - 1;
      } else {
        historyCursorRef.current = Math.max(0, cursor - 1);
      }
      const entry = commandHistory[historyCursorRef.current];
      if (entry) {
        applyDraft(entry);
      }
      return true;
    }
    if (cursor === null) {
      return false;
    }
    if (cursor < commandHistory.length - 1) {
      historyCursorRef.current = cursor + 1;
      const entry = commandHistory[historyCursorRef.current];
      if (entry) {
        applyDraft(entry);
      }
    } else {
      const draft = historyDraftRef.current;
      resetHistoryNavigation();
      if (draft) {
        applyDraft(draft);
      }
    }
    return true;
  };

  const submit = async () => {
    if (!hasSendableFrame || templatePreview.error || taskActive || manualSendBlocked) {
      return;
    }
    setSendError("");
    setManualSendPending(true);
    try {
      await send(message, sendMode, lineEnding);
      setMessage("");
      resetHistoryNavigation();
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      setManualSendPending(false);
    }
  };

  const startTask = () => {
    setSendError("");
    try {
      startPeriodicSend(
        message,
        sendMode,
        lineEnding,
        Number(intervalText),
        repeatMode === "continuous" ? null : Number(repeatCountText),
      );
      setWorkflowOpen(true);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    const textarea = event.currentTarget;
    if (textarea.selectionStart !== textarea.selectionEnd) {
      return;
    }
    const onFirstLine = message.lastIndexOf("\n", textarea.selectionStart - 1) < 0;
    const onLastLine = message.indexOf("\n", textarea.selectionEnd) < 0;
    if (
      (event.key === "ArrowUp" && onFirstLine && navigateHistory("previous")) ||
      (event.key === "ArrowDown" && onLastLine && navigateHistory("next"))
    ) {
      event.preventDefault();
    }
  };

  const handleTerminalScroll = () => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    setTerminalFollowSuspended(!isTerminalViewportAtLatest(viewport));
  };

  const resumeTerminalFollow = () => {
    setTerminalFollowSuspended(false);
    if (visibleEntries.length > 0) {
      rowVirtualizer.scrollToIndex(visibleEntries.length - 1, { align: "end" });
    }
    viewportRef.current?.focus({ preventScroll: true });
  };

  const closeExportMenu = (returnFocus: boolean) => {
    setExportOpen(false);
    if (returnFocus) {
      exportTriggerRef.current?.focus({ preventScroll: true });
    }
  };

  return (
    <section
      id="workspace-terminal-panel"
      className="workspace-panel terminal-panel"
      aria-labelledby="terminal-title"
    >
      <header className="panel-toolbar terminal-toolbar">
        <div className="panel-title-group">
          <TerminalSquare size={17} />
          <div>
            <h2 id="terminal-title">数据终端</h2>
            <span className="panel-subtitle">{recordSummary}</span>
          </div>
        </div>
        <div className="panel-actions">
          <div className="segmented-control compact-segments" role="group" aria-label="接收显示格式">
            <button
              type="button"
              aria-pressed={displayMode === "text"}
              data-active={displayMode === "text"}
              disabled={isWorkspaceTransitioning}
              onClick={() => setDisplayMode("text")}
            >
              TEXT
            </button>
            <button
              type="button"
              aria-pressed={displayMode === "hex"}
              data-active={displayMode === "hex"}
              disabled={isWorkspaceTransitioning}
              onClick={() => setDisplayMode("hex")}
            >
              HEX
            </button>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label={terminalPaused ? "继续终端显示" : "暂停终端显示"}
            title={terminalPaused ? "继续终端显示" : "暂停终端显示"}
            onClick={() => setTerminalPaused(!terminalPaused)}
          >
            {terminalPaused ? <Play size={16} /> : <CirclePause size={16} />}
          </button>
          <div
            className="terminal-export-control"
            ref={exportControlRef}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setExportOpen(false);
              }
            }}
          >
            <button
              className="icon-button"
              type="button"
              aria-label="导出终端记录"
              title="导出终端记录"
              aria-haspopup="menu"
              aria-controls="terminal-export-menu"
              aria-expanded={exportOpen}
              data-active={exportOpen}
              disabled={!entries.length}
              ref={exportTriggerRef}
              onClick={() => setExportOpen((open) => !open)}
            >
              <Download size={16} />
            </button>
            {exportOpen && (
              <Suspense fallback={null}>
                <TerminalExportMenu
                  allEntries={entries}
                  currentViewEntries={visibleEntries}
                  displayMode={displayMode}
                  filtersActive={filtersActive}
                  onClose={() => closeExportMenu(true)}
                />
              </Suspense>
            )}
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label={clearTerminalLabel}
            title={clearTerminalLabel}
            disabled={!entries.length}
            onClick={clearTerminal}
          >
            <Eraser size={16} />
          </button>
        </div>
      </header>

      <div className="terminal-filter-bar" role="search" aria-label="终端记录筛选">
        <div className="terminal-rx-record-controls">
          <div
            className="segmented-control compact-segments terminal-rx-record-mode"
            role="group"
            aria-label="接收记录方式"
          >
            <button
              type="button"
              data-active={terminalRxRecordMode === "chunk"}
              aria-pressed={terminalRxRecordMode === "chunk"}
              aria-label="按读取块记录"
              title="按读取块记录"
              disabled={isWorkspaceTransitioning}
              onClick={() => setTerminalRxRecordMode("chunk")}
            >
              块
            </button>
            <button
              type="button"
              data-active={terminalRxRecordMode === "line"}
              aria-pressed={terminalRxRecordMode === "line"}
              aria-label="按文本行记录"
              title="按文本行记录"
              disabled={isWorkspaceTransitioning}
              onClick={() => setTerminalRxRecordMode("line")}
            >
              行
            </button>
          </div>
          <label className="terminal-rx-line-ending">
            <span className="sr-only">接收行尾</span>
            <select
              id="terminal-rx-line-ending"
              name="terminal-rx-line-ending"
              aria-label="接收行尾"
              title={terminalRxRecordMode === "line" ? "接收行尾" : "按文本行记录时使用"}
              value={terminalRxLineEnding}
              disabled={terminalRxRecordMode !== "line" || isWorkspaceTransitioning}
              onChange={(event) =>
                setTerminalRxLineEnding(event.target.value as typeof terminalRxLineEnding)
              }
            >
              <option value="lf">LF</option>
              <option value="crlf">CRLF</option>
              <option value="cr">CR</option>
            </select>
          </label>
          <label className="terminal-rx-text-encoding">
            <span className="sr-only">接收文本编码</span>
            <select
              id="terminal-rx-text-encoding"
              name="terminal-rx-text-encoding"
              aria-label="接收文本编码"
              title="接收文本编码"
              value={terminalRxTextEncoding}
              disabled={isWorkspaceTransitioning}
              onChange={(event) =>
                setTerminalRxTextEncoding(event.target.value as typeof terminalRxTextEncoding)
              }
            >
              <option value="utf-8">UTF-8</option>
              <option value="gb18030">GB18030</option>
              <option value="windows-1252">Windows-1252</option>
            </select>
          </label>
        </div>
        <div className="terminal-search-field">
          <Search size={15} aria-hidden="true" />
          <input
            id="terminal-search-query"
            name="terminal-search-query"
            type="search"
            aria-label="搜索终端记录"
            aria-controls="terminal-record-list"
            maxLength={MAX_TERMINAL_SEARCH_CHARACTERS}
            value={searchQuery}
            spellCheck={false}
            placeholder={displayMode === "text" ? "搜索 TEXT 内容" : "搜索 HEX 内容"}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          <button
            type="button"
            aria-label="清空终端搜索"
            title="清空终端搜索"
            disabled={!searchQuery}
            onClick={() => setSearchQuery("")}
          >
            <X size={14} />
          </button>
        </div>
        <div
          className="segmented-control compact-segments terminal-direction-filter"
          role="group"
          aria-label="终端方向筛选"
        >
          <button
            type="button"
            data-active={directionFilter === "all"}
            aria-pressed={directionFilter === "all"}
            onClick={() => setDirectionFilter("all")}
          >
            全部
          </button>
          <button
            type="button"
            data-active={directionFilter === "rx"}
            aria-pressed={directionFilter === "rx"}
            onClick={() => setDirectionFilter("rx")}
          >
            RX
          </button>
          <button
            type="button"
            data-active={directionFilter === "tx"}
            aria-pressed={directionFilter === "tx"}
            onClick={() => setDirectionFilter("tx")}
          >
            TX
          </button>
        </div>
        <div
          className="segmented-control compact-segments terminal-time-mode"
          role="group"
          aria-label="终端时间基准"
        >
          {TERMINAL_TIME_MODE_OPTIONS.map((option) => (
            <button
              key={option.mode}
              type="button"
              data-active={terminalTimeMode === option.mode}
              aria-pressed={terminalTimeMode === option.mode}
              aria-label={`${option.label}，${option.description}`}
              title={option.description}
              onClick={() => setTerminalTimeMode(option.mode)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="terminal-mobile-filter-selects">
          <label>
            <span className="sr-only">终端时间基准</span>
            <select
              id="terminal-mobile-time-mode"
              name="terminal-mobile-time-mode"
              aria-label="终端时间基准"
              title="终端时间基准"
              value={terminalTimeMode}
              onChange={(event) =>
                setTerminalTimeMode(event.target.value as TerminalTimeMode)
              }
            >
              {TERMINAL_TIME_MODE_OPTIONS.map((option) => (
                <option key={option.mode} value={option.mode}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">终端方向筛选</span>
            <select
              id="terminal-mobile-direction-filter"
              name="terminal-mobile-direction-filter"
              aria-label="终端方向筛选"
              title="终端方向筛选"
              value={directionFilter}
              onChange={(event) =>
                setDirectionFilter(event.target.value as TerminalDirectionFilter)
              }
            >
              <option value="all">全部</option>
              <option value="rx">RX</option>
              <option value="tx">TX</option>
            </select>
          </label>
        </div>
      </div>

      <div className="terminal-log-shell">
        <div
          ref={viewportRef}
          id="terminal-record-list"
          className="terminal-viewport"
          role="log"
          aria-label="终端记录"
          aria-live="off"
          tabIndex={0}
          onScroll={handleTerminalScroll}
        >
          {entries.length === 0 ? (
            <div className="terminal-empty">
              <ArrowDownToLine size={24} />
              <span>接收数据将在这里显示</span>
            </div>
          ) : visibleEntries.length === 0 ? (
            <div className="terminal-empty">
              <SearchX size={24} />
              <span>没有匹配的终端记录</span>
            </div>
          ) : (
            <div
              className="terminal-virtualizer"
              style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const entry = visibleEntries[virtualRow.index];
                if (!entry) {
                  return null;
                }
                const timeLabel = formatTerminalTime(
                  entry.timestamp,
                  terminalTimeMode,
                  terminalTimeOrigin,
                  visibleEntries[virtualRow.index - 1]?.timestamp,
                );
                const timeDescription = terminalTimeDescription(terminalTimeMode, timeLabel);
                return (
                  <div
                    key={entry.id}
                    ref={rowVirtualizer.measureElement}
                    className="terminal-line"
                    data-direction={entry.direction}
                    data-index={virtualRow.index}
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <time
                      data-time-mode={terminalTimeMode}
                      dateTime={terminalTimeDateTime(entry.timestamp)}
                      aria-label={timeDescription}
                      title={timeDescription}
                    >
                      {timeLabel}
                    </time>
                    <span className="direction-label">{entry.direction.toUpperCase()}</span>
                    <code>
                      <HighlightedTerminalPayload
                        value={terminalEntryPayload(entry, displayMode)}
                        query={searchQuery}
                      />
                    </code>
                    <small>
                      {entry.byteCount} B
                      {entry.rxBoundary ? (
                        <span
                          className="terminal-rx-boundary"
                          title={terminalRxBoundaryLabel(entry.rxBoundary)}
                        >
                          <TriangleAlert
                            size={12}
                            role="img"
                            aria-label={terminalRxBoundaryLabel(entry.rxBoundary)}
                          />
                        </span>
                      ) : null}
                    </small>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {terminalFollowSuspended && visibleEntries.length > 0 ? (
          <button
            className="icon-button terminal-jump-latest"
            type="button"
            aria-label="回到最新记录"
            title="回到最新记录"
            onClick={resumeTerminalFollow}
          >
            <ArrowDownToLine size={17} />
          </button>
        ) : null}
      </div>

      <div
        ref={composerRef}
        className="send-composer"
        data-workflow-open={workflowVisible}
        onKeyDown={(event) => {
          if (fileSendOpen && event.key === "Escape") {
            event.preventDefault();
            setFileSendOpen(false);
            fileSendTriggerRef.current?.focus();
          }
        }}
      >
        <div className="send-main-row">
          <div className="send-options">
            <div className="segmented-control compact-segments" role="group" aria-label="发送格式">
              <button
                type="button"
                aria-pressed={sendMode === "text"}
                data-active={sendMode === "text"}
                disabled={isWorkspaceTransitioning}
                onClick={() => {
                  resetHistoryNavigation();
                  setSendError("");
                  setVariablesOpen(false);
                  setSendMode("text");
                }}
              >
                文本
              </button>
              <button
                type="button"
                aria-pressed={sendMode === "hex"}
                data-active={sendMode === "hex"}
                disabled={isWorkspaceTransitioning}
                onClick={() => {
                  resetHistoryNavigation();
                  setSendError("");
                  setVariablesOpen(false);
                  setSendMode("hex");
                }}
              >
                HEX
              </button>
            </div>
            <div className="send-checksum-field">
              <label className="send-field-caption" htmlFor="send-checksum">
                校验
              </label>
              <select
                id="send-checksum"
                name="send-checksum"
                aria-label="校验"
                value={commandChecksum}
                disabled={isWorkspaceTransitioning}
                onChange={(event) => {
                  resetHistoryNavigation();
                  setSendError("");
                  setCommandChecksum(event.target.value as CommandChecksumMode);
                }}
              >
                {COMMAND_CHECKSUM_MODES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="send-line-ending-field">
              <label className="send-field-caption" htmlFor="send-line-ending">
                行尾
              </label>
              <select
                id="send-line-ending"
                name="send-line-ending"
                aria-label="行尾"
                value={lineEnding}
                disabled={isWorkspaceTransitioning}
                onChange={(event) => {
                  resetHistoryNavigation();
                  setSendError("");
                  setLineEnding(event.target.value as LineEnding);
                }}
              >
                <option value="none">无行尾</option>
                <option value="lf">LF</option>
                <option value="cr">CR</option>
                <option value="crlf">CRLF</option>
              </select>
            </div>
          </div>
          <div className="send-payload-field">
            <label className="send-field-caption" htmlFor="send-payload">
              发送内容
            </label>
            <textarea
              ref={textareaRef}
              id="send-payload"
              name="send-payload"
              aria-label="发送内容"
              aria-invalid={Boolean(templatePreview.error)}
              aria-describedby={
                visibleError
                  ? "command-send-error"
                  : hasSendableFrame
                    ? "command-template-summary"
                    : undefined
              }
              rows={1}
              maxLength={MAX_COMMAND_TEMPLATE_BYTES}
              value={message}
              spellCheck={false}
              placeholder={sendMode === "hex" ? "01 03 00 00 00 02 C4 0B" : "输入要发送的内容"}
              onChange={(event) => {
                setMessage(event.target.value);
                setSendError("");
                resetHistoryNavigation();
              }}
              onKeyDown={handleKeyDown}
            />
          </div>
          <button
            ref={fileSendTriggerRef}
            className="icon-button composer-icon-button command-file-trigger"
            type="button"
            aria-label={fileSendOpen ? "关闭文件发送" : "打开文件发送"}
            title={
              isNativeRuntime && source === "serial"
                ? "发送原始文件"
                : "原始文件发送仅支持桌面串口"
            }
            aria-haspopup="dialog"
            aria-controls="serial-file-send-popover"
            aria-expanded={fileSendOpen}
            data-active={fileSendOpen || fileSendActive}
            disabled={!isNativeRuntime || source !== "serial"}
            onClick={() => {
              setHistoryOpen(false);
              setModbusOpen(false);
              setQuickCommandsOpen(false);
              setVariablesOpen(false);
              setFileSendOpen((open) => !open);
            }}
          >
            <FileUp size={16} />
            {fileSendActive ? <span className="file-send-activity-dot" /> : null}
          </button>
          <button
            ref={modbusTriggerRef}
            className="icon-button composer-icon-button command-modbus-trigger"
            type="button"
            aria-label={modbusOpen ? "关闭 Modbus RTU 构帧器" : "打开 Modbus RTU 构帧器"}
            title="Modbus RTU 构帧器"
            aria-haspopup="dialog"
            aria-expanded={modbusOpen}
            data-active={modbusOpen}
            disabled={isWorkspaceTransitioning || fileSendActive}
            onClick={() => {
              setHistoryOpen(false);
              setFileSendOpen(false);
              setQuickCommandsOpen(false);
              setVariablesOpen(false);
              setModbusOpen((open) => !open);
            }}
          >
            <Blocks size={16} />
          </button>
          <button
            ref={variableTriggerRef}
            className="icon-button composer-icon-button command-variable-trigger"
            type="button"
            aria-label={variablesOpen ? "关闭命令参考与校验" : "打开命令参考与校验"}
            title="命令参考与校验"
            aria-haspopup="dialog"
            aria-controls="command-variable-popover"
            aria-expanded={variablesOpen}
            data-active={variablesOpen}
            onClick={() => {
              setHistoryOpen(false);
              setFileSendOpen(false);
              setModbusOpen(false);
              setQuickCommandsOpen(false);
              setVariablesOpen((open) => !open);
            }}
          >
            <Braces size={16} />
          </button>
          <button
            ref={quickCommandTriggerRef}
            className="icon-button composer-icon-button command-quick-trigger"
            type="button"
            aria-label={quickCommandsOpen ? "关闭快捷命令" : "打开快捷命令"}
            title="快捷命令"
            aria-haspopup="dialog"
            aria-expanded={quickCommandsOpen}
            data-active={quickCommandsOpen}
            disabled={isWorkspaceTransitioning}
            onClick={() => {
              setHistoryOpen(false);
              setFileSendOpen(false);
              setModbusOpen(false);
              setVariablesOpen(false);
              setQuickCommandsOpen((open) => !open);
            }}
          >
            <Bookmark size={16} />
          </button>
          <button
            className="icon-button composer-icon-button command-history-trigger"
            type="button"
            aria-label={`命令历史，${commandHistory.length} 条`}
            title="命令历史"
            aria-expanded={historyOpen}
            disabled={commandHistory.length === 0}
            onClick={() => {
              setFileSendOpen(false);
              setModbusOpen(false);
              setQuickCommandsOpen(false);
              setVariablesOpen(false);
              setHistoryOpen((open) => !open);
            }}
          >
            <History size={16} />
            {commandHistory.length > 0 && (
              <span className="command-count-badge">{Math.min(commandHistory.length, 99)}</span>
            )}
          </button>
          <button
            className="icon-button composer-icon-button command-workflow-trigger"
            type="button"
            aria-label={workflowOpen ? "收起周期发送设置" : "展开周期发送设置"}
            title={workflowOpen ? "收起周期发送设置" : "周期发送设置"}
            aria-expanded={workflowVisible}
            data-active={workflowVisible}
            disabled={taskActive || fileSendActive}
            onClick={() => {
              setHistoryOpen(false);
              setFileSendOpen(false);
              setModbusOpen(false);
              setQuickCommandsOpen(false);
              setVariablesOpen(false);
              setWorkflowOpen((open) => !open);
            }}
          >
            <Timer size={16} />
          </button>
          {taskActive ? (
            <button
              className="primary-button send-button"
              type="button"
              data-action="stop"
              disabled={commandTask.status === "stopping"}
              onClick={stopPeriodicSend}
            >
              <Square size={15} />
              {commandTask.status === "stopping" ? "停止中" : "停止"}
            </button>
          ) : (
            <button
              className="primary-button send-button"
              type="button"
              disabled={
                connectionStatus !== "connected" ||
                !hasSendableFrame ||
                Boolean(templatePreview.error) ||
                isWorkspaceTransitioning ||
                manualSendBlocked
              }
              onClick={() => void submit()}
            >
              <Send size={16} />
              发送
            </button>
          )}
        </div>

        {hasSendableFrame && !templatePreview.error && (
          <span
            id="command-template-summary"
            className="command-template-summary"
            data-dynamic={
              templatePreview.variableCount > 0 || Boolean(templatePreview.checksumHex)
            }
            aria-label={commandTemplateSummaryLabel(templatePreview)}
          >
            {templatePreview.variableCount} 个变量 · {templatePreview.byteCount} B
            {templatePreview.checksumHex ? ` · 校验 ${templatePreview.checksumHex}` : ""}
          </span>
        )}

        {fileSendOpen && (
          <div
            id="serial-file-send-popover"
            className="serial-file-send-popover"
            role="dialog"
            aria-label="原始文件发送"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setFileSendOpen(false);
                fileSendTriggerRef.current?.focus();
              }
            }}
          >
            <header className="serial-file-send-header">
              <div>
                <FileUp size={15} />
                <strong>原始文件发送</strong>
              </div>
              <button
                className="icon-button compact"
                type="button"
                aria-label="关闭文件发送"
                title="关闭"
                onClick={() => {
                  setFileSendOpen(false);
                  fileSendTriggerRef.current?.focus();
                }}
              >
                <X size={14} />
              </button>
            </header>

            <div className="serial-file-send-body">
              <div className="serial-file-selection" data-empty={!selectedFileName}>
                <FileUp size={19} aria-hidden="true" />
                <div>
                  <strong title={selectedFileName || "尚未选择文件"}>
                    {selectedFileName || "尚未选择文件"}
                  </strong>
                  <span>{selectedFileName ? "已选择，等待开始" : "选择一个本机文件"}</span>
                </div>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={fileSelectionPending || fileStartPending || fileSendActive}
                  onClick={() => void chooseFileToSend()}
                >
                  <FolderOpen size={15} />
                  {fileSelectionPending ? "选择中" : "选择"}
                </button>
              </div>

              {fileSendHasSnapshot ? (
                <div
                  className="serial-file-send-progress"
                  data-status={serialFileSend.status}
                  role={serialFileSend.status === "error" ? "alert" : "status"}
                >
                  <div>
                    <span>{fileSendStatusLabel(serialFileSend.status)}</span>
                    <strong>{fileSendPercent.toFixed(1)}%</strong>
                  </div>
                  <progress
                    aria-label={`${serialFileSend.fileName} 发送进度`}
                    max={fileSendProgressMax}
                    value={fileSendProgressValue}
                  />
                  <div>
                    <span title={serialFileSend.fileName}>{serialFileSend.fileName}</span>
                    <span>
                      {formatFileBytes(serialFileSend.transmittedBytes)} /{" "}
                      {formatFileBytes(serialFileSend.totalBytes)}
                    </span>
                  </div>
                </div>
              ) : null}

              {fileSendError || serialFileSend.message ? (
                <p
                  className="serial-file-send-message"
                  data-error={Boolean(fileSendError) || serialFileSend.status === "error"}
                  role={fileSendError || serialFileSend.status === "error" ? "alert" : "status"}
                >
                  {fileSendError || serialFileSend.message}
                </p>
              ) : null}
            </div>

            <footer className="serial-file-send-actions">
              <span>桌面串口 · 原始字节</span>
              {fileSendActive ? (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={serialFileSend.status === "cancelling"}
                  onClick={() => void cancelFileSend()}
                >
                  <Square size={14} />
                  {serialFileSend.status === "cancelling" ? "取消中" : "取消"}
                </button>
              ) : (
                <button
                  className="primary-button"
                  type="button"
                  disabled={!canStartFileSend}
                  onClick={() => void beginFileSend()}
                >
                  <FileUp size={15} />
                  {fileStartPending ? "启动中" : "开始发送"}
                </button>
              )}
            </footer>
          </div>
        )}

        {modbusOpen && (
          <ModbusRtuBuilder
            canExecute={canExecuteModbus}
            transaction={modbusTransaction}
            transactions={modbusTransactions}
            onApply={applyModbusFrame}
            onExecute={executeModbusTransaction}
            onCancel={cancelModbusTransaction}
            onClearHistory={clearModbusTransactions}
            onClose={() => {
              setModbusOpen(false);
              modbusTriggerRef.current?.focus();
            }}
          />
        )}

        {quickCommandsOpen && (
          <QuickCommandPopover
            draft={{ template: message, mode: sendMode, lineEnding }}
            canSaveDraft={hasPayload && !templatePreview.error}
            onApply={applyQuickCommand}
            onClose={() => {
              setQuickCommandsOpen(false);
              quickCommandTriggerRef.current?.focus();
            }}
          />
        )}

        {workflowVisible && (
          <div className="command-workflow" aria-label="周期发送设置">
            <div className="command-interval-field">
              <label className="send-field-caption" htmlFor="command-interval">
                间隔
              </label>
              <input
                id="command-interval"
                type="number"
                inputMode="numeric"
                aria-label="发送间隔（毫秒）"
                min={MIN_COMMAND_INTERVAL_MS}
                max={MAX_COMMAND_INTERVAL_MS}
                step={1}
                value={intervalText}
                disabled={taskActive}
                onChange={(event) => setIntervalText(event.target.value)}
              />
              <span>ms</span>
              <small title="下一次发送在上一次完成后开始计时">非实时</small>
            </div>
            <div
              className="segmented-control compact-segments command-repeat-mode"
              role="group"
              aria-label="发送次数模式"
            >
              <button
                type="button"
                aria-pressed={repeatMode === "count"}
                data-active={repeatMode === "count"}
                disabled={taskActive}
                onClick={() => setRepeatMode("count")}
              >
                次数
              </button>
              <button
                type="button"
                aria-pressed={repeatMode === "continuous"}
                data-active={repeatMode === "continuous"}
                disabled={taskActive}
                onClick={() => setRepeatMode("continuous")}
              >
                持续
              </button>
            </div>
            {repeatMode === "count" && (
              <div className="command-repeat-count-field">
                <label className="send-field-caption" htmlFor="command-repeat-count">
                  次数
                </label>
                <input
                  id="command-repeat-count"
                  type="number"
                  inputMode="numeric"
                  aria-label="发送次数"
                  min={1}
                  max={MAX_COMMAND_REPEAT_COUNT}
                  step={1}
                  value={repeatCountText}
                  disabled={taskActive}
                  onChange={(event) => setRepeatCountText(event.target.value)}
                />
              </div>
            )}
            <div
              className="command-task-status"
              data-status={commandTask.status}
              role={commandTask.status === "error" ? "alert" : "status"}
              aria-label="周期发送状态"
            >
              <span className="command-task-dot" />
              <span>{formatTaskSummary(commandTask)}</span>
            </div>
            {!taskActive && (
              <button
                className="primary-button command-task-button"
                type="button"
                disabled={!canStartPeriodic}
                onClick={startTask}
              >
                <Play size={15} />
                启动
              </button>
            )}
          </div>
        )}

        {historyOpen && (
          <div className="command-history-popover" role="dialog" aria-label="命令历史">
            <div className="command-history-header">
              <div>
                <History size={14} />
                <strong>命令历史</strong>
                <span>{commandHistory.length}/100</span>
              </div>
              <button
                className="icon-button compact"
                type="button"
                aria-label="清空命令历史"
                title="清空命令历史"
                onClick={() => {
                  clearCommandHistory();
                  resetHistoryNavigation();
                  setHistoryOpen(false);
                  textareaRef.current?.focus();
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="command-history-list">
              {commandHistory
                .map((entry, index) => ({ entry, index }))
                .reverse()
                .map(({ entry, index }) => (
                  <button
                    key={`${entry.sentAt}-${index}`}
                    type="button"
                    onClick={() => {
                      recallHistory(index);
                      setHistoryOpen(false);
                      textareaRef.current?.focus();
                    }}
                  >
                    <code>{historyPreview(entry)}</code>
                    <span>
                      {entry.mode.toUpperCase()} · {lineEndingLabel(entry.lineEnding)} ·{" "}
                      {entry.checksumMode === "none"
                        ? "无校验"
                        : entry.checksumMode.toUpperCase()} ·{" "}
                      {entry.variableCount > 0
                        ? `最近 ${entry.encodedBytes} B`
                        : `${entry.encodedBytes} B`}
                      {entry.repeatCount > 1 ? ` · ×${entry.repeatCount}` : ""}
                    </span>
                  </button>
                ))}
            </div>
          </div>
        )}

        {variablesOpen && (
          <div
            id="command-variable-popover"
            className="command-variable-popover"
            data-view={commandReferenceView}
            role="dialog"
            aria-label="命令参考与校验"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setVariablesOpen(false);
                variableTriggerRef.current?.focus();
              }
            }}
          >
            <div className="command-variable-header">
              <div>
                <Braces size={14} />
                <strong>命令参考与校验</strong>
              </div>
            </div>
            <div
              className="command-reference-tabs segmented-control"
              role="tablist"
              aria-label="命令参考类型"
            >
              <button
                id="command-reference-variables-tab"
                type="button"
                role="tab"
                aria-controls="command-reference-variables-panel"
                aria-selected={commandReferenceView === "variables"}
                tabIndex={commandReferenceView === "variables" ? 0 : -1}
                data-active={commandReferenceView === "variables"}
                onKeyDown={(event) => handleCommandReferenceTabKeyDown(event, "variables")}
                onClick={() => setCommandReferenceView("variables")}
              >
                变量
              </button>
              <button
                id="command-reference-ascii-tab"
                type="button"
                role="tab"
                aria-controls="command-reference-ascii-panel"
                aria-selected={commandReferenceView === "ascii"}
                tabIndex={commandReferenceView === "ascii" ? 0 : -1}
                data-active={commandReferenceView === "ascii"}
                onKeyDown={(event) => handleCommandReferenceTabKeyDown(event, "ascii")}
                onClick={() => setCommandReferenceView("ascii")}
              >
                ASCII
              </button>
              <button
                id="command-reference-converter-tab"
                type="button"
                role="tab"
                aria-controls="command-reference-converter-panel"
                aria-selected={commandReferenceView === "converter"}
                tabIndex={commandReferenceView === "converter" ? 0 : -1}
                data-active={commandReferenceView === "converter"}
                onKeyDown={(event) => handleCommandReferenceTabKeyDown(event, "converter")}
                onClick={() => setCommandReferenceView("converter")}
              >
                转换
              </button>
              <button
                id="command-reference-checksum-tab"
                type="button"
                role="tab"
                aria-controls="command-reference-checksum-panel"
                aria-selected={commandReferenceView === "checksum"}
                tabIndex={commandReferenceView === "checksum" ? 0 : -1}
                data-active={commandReferenceView === "checksum"}
                onKeyDown={(event) => handleCommandReferenceTabKeyDown(event, "checksum")}
                onClick={() => setCommandReferenceView("checksum")}
              >
                校验
              </button>
            </div>
            {commandReferenceView === "variables" ? (
              <div
                id="command-reference-variables-panel"
                role="tabpanel"
                aria-labelledby="command-reference-variables-tab"
                ref={variableListRef}
                className="command-variable-list"
              >
                {availableVariables.map((item) => (
                  <button
                    key={item.token}
                    type="button"
                    aria-label={`插入${item.label} ${item.token}`}
                    onClick={() => insertVariable(item.token)}
                  >
                    <code>{item.token}</code>
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            ) : commandReferenceView === "ascii" ? (
              <div
                id="command-reference-ascii-panel"
                role="tabpanel"
                aria-labelledby="command-reference-ascii-tab"
                className="ascii-reference-panel"
              >
                <label className="ascii-reference-search">
                  <Search size={14} aria-hidden="true" />
                  <input
                    ref={asciiSearchRef}
                    type="search"
                    aria-label="搜索 ASCII 字符"
                    placeholder="字符、缩写、DEC、HEX 或中文名称"
                    value={asciiSearchQuery}
                    maxLength={MAX_ASCII_SEARCH_CHARACTERS}
                    onChange={(event) => setAsciiSearchQuery(event.target.value)}
                  />
                  <button
                    type="button"
                    aria-label="清空 ASCII 搜索"
                    title="清空 ASCII 搜索"
                    data-visible={asciiSearchQuery.length > 0}
                    aria-hidden={asciiSearchQuery.length === 0}
                    disabled={asciiSearchQuery.length === 0}
                    tabIndex={asciiSearchQuery.length > 0 ? 0 : -1}
                    onClick={() => setAsciiSearchQuery("")}
                  >
                    <X size={14} />
                  </button>
                </label>
                <div className="ascii-reference-table-scroll">
                  {visibleAsciiEntries.length > 0 ? (
                    <table aria-label="ASCII 字符表">
                      <thead>
                        <tr>
                          <th scope="col">字符 / 缩写</th>
                          <th scope="col">DEC</th>
                          <th scope="col">HEX</th>
                          <th scope="col">中文名称</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleAsciiEntries.map((entry) => (
                          <tr key={entry.code}>
                            <td><code>{entry.character}</code></td>
                            <td>{entry.code}</td>
                            <td><code>{entry.hex}</code></td>
                            <td>{entry.name}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="ascii-reference-empty" role="status">
                      <SearchX size={18} />
                      <span>没有匹配的 ASCII 字符</span>
                    </div>
                  )}
                </div>
              </div>
            ) : commandReferenceView === "converter" ? (
              <div
                id="command-reference-converter-panel"
                role="tabpanel"
                aria-labelledby="command-reference-converter-tab"
                className="data-converter-panel"
              >
                <div className="data-converter-toolbar">
                  <div>
                    <span>转换方向</span>
                    <div
                      className="segmented-control data-converter-direction"
                      role="group"
                      aria-label="转换方向"
                    >
                      <button
                        type="button"
                        aria-pressed={converterDirection === "bytes-to-numbers"}
                        data-active={converterDirection === "bytes-to-numbers"}
                        onClick={() => {
                          setConverterDirection("bytes-to-numbers");
                          resetConverterFeedback();
                        }}
                      >
                        字节转数值
                      </button>
                      <button
                        type="button"
                        aria-pressed={converterDirection === "numbers-to-bytes"}
                        data-active={converterDirection === "numbers-to-bytes"}
                        onClick={() => {
                          setConverterDirection("numbers-to-bytes");
                          resetConverterFeedback();
                        }}
                      >
                        数值转字节
                      </button>
                    </div>
                  </div>
                  <label>
                    <span>数值类型</span>
                    <select
                      id="data-converter-numeric-type"
                      name="data-converter-numeric-type"
                      aria-label="数值类型"
                      value={converterNumericType}
                      onChange={(event) => {
                        setConverterNumericType(event.target.value as DataNumericType);
                        resetConverterFeedback();
                      }}
                    >
                      {DATA_NUMERIC_TYPE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div>
                    <span>字节序</span>
                    <div
                      className="segmented-control data-converter-endianness"
                      role="group"
                      aria-label="字节序"
                    >
                      <button
                        type="button"
                        disabled={!converterUsesEndianness}
                        aria-pressed={converterEndianness === "le"}
                        data-active={converterEndianness === "le"}
                        onClick={() => {
                          setConverterEndianness("le");
                          resetConverterFeedback();
                        }}
                      >
                        小端 LE
                      </button>
                      <button
                        type="button"
                        disabled={!converterUsesEndianness}
                        aria-pressed={converterEndianness === "be"}
                        data-active={converterEndianness === "be"}
                        onClick={() => {
                          setConverterEndianness("be");
                          resetConverterFeedback();
                        }}
                      >
                        大端 BE
                      </button>
                    </div>
                  </div>
                </div>
                <label className="data-converter-input">
                  <span className="sr-only">转换输入</span>
                  <textarea
                    id="data-converter-input"
                    name="data-converter-input"
                    ref={converterInputRef}
                    aria-label="转换输入"
                    aria-invalid={converterPreview.error ? "true" : "false"}
                    aria-describedby="data-converter-error"
                    placeholder={
                      converterDirection === "bytes-to-numbers"
                        ? "输入 HEX 字节，如 00 00 80 3F"
                        : "输入十进制数值，以空格、逗号或分号分隔"
                    }
                    value={converterInput}
                    maxLength={MAX_DATA_CONVERTER_INPUT_CHARACTERS}
                    spellCheck={false}
                    onChange={(event) => {
                      setConverterInput(event.target.value);
                      resetConverterFeedback();
                    }}
                  />
                </label>
                <span
                  id="data-converter-error"
                  className="data-converter-error"
                  role={converterError ? "alert" : undefined}
                >
                  {converterError || "\u00a0"}
                </span>
                <div className="data-converter-results" aria-label="转换结果">
                  <label>
                    <span>规范化 HEX</span>
                    <span className="data-converter-result-field">
                      <textarea
                        id="data-converter-normalized-hex"
                        name="data-converter-normalized-hex"
                        aria-label="规范化 HEX"
                        value={converterPreview.result?.normalizedHex ?? ""}
                        placeholder="--"
                        readOnly
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        className="icon-button compact"
                        aria-label={converterHexCopied ? "HEX 结果已复制" : "复制 HEX 结果"}
                        title={converterHexCopied ? "已复制" : "复制 HEX 结果"}
                        disabled={!converterPreview.result?.normalizedHex}
                        onClick={() => void copyConverterOutput(
                          "hex",
                          converterPreview.result?.normalizedHex ?? "",
                        )}
                      >
                        {converterHexCopied ? <Check size={13} /> : <Copy size={13} />}
                      </button>
                    </span>
                  </label>
                  <label>
                    <span>数值结果</span>
                    <span className="data-converter-result-field">
                      <textarea
                        id="data-converter-numeric-output"
                        name="data-converter-numeric-output"
                        aria-label="数值结果"
                        value={converterPreview.result?.numericText ?? ""}
                        placeholder="--"
                        readOnly
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        className="icon-button compact"
                        aria-label={converterNumbersCopied ? "数值结果已复制" : "复制数值结果"}
                        title={converterNumbersCopied ? "已复制" : "复制数值结果"}
                        disabled={!converterPreview.result?.numericText}
                        onClick={() => void copyConverterOutput(
                          "numbers",
                          converterPreview.result?.numericText ?? "",
                        )}
                      >
                        {converterNumbersCopied ? <Check size={13} /> : <Copy size={13} />}
                      </button>
                    </span>
                  </label>
                </div>
                <output
                  className="data-converter-summary"
                  aria-label={
                    `转换结果 ${converterPreview.result?.byteCount ?? 0} 字节，` +
                    `${converterPreview.result?.valueCount ?? 0} 个数值`
                  }
                >
                  {converterPreview.result?.byteCount ?? 0} B ·{" "}
                  {converterPreview.result?.valueCount ?? 0} 个数值
                </output>
              </div>
            ) : (
              <div
                id="command-reference-checksum-panel"
                role="tabpanel"
                aria-labelledby="command-reference-checksum-tab"
                className="checksum-reference-panel"
              >
                <div className="checksum-reference-toolbar">
                  <div
                    className="segmented-control checksum-reference-modes"
                    role="group"
                    aria-label="校验输入格式"
                  >
                    <button
                      type="button"
                      aria-pressed={checksumInputMode === "text"}
                      data-active={checksumInputMode === "text"}
                      onClick={() => setChecksumInputMode("text")}
                    >
                      TEXT
                    </button>
                    <button
                      type="button"
                      aria-pressed={checksumInputMode === "hex"}
                      data-active={checksumInputMode === "hex"}
                      onClick={() => setChecksumInputMode("hex")}
                    >
                      HEX
                    </button>
                  </div>
                  <output aria-label={`校验输入 ${checksumPreview.result?.byteCount ?? 0} 字节`}>
                    {checksumPreview.result?.byteCount ?? 0} B
                  </output>
                </div>
                <label className="checksum-reference-input">
                  <span className="sr-only">校验输入</span>
                  <textarea
                    ref={checksumInputRef}
                    aria-label="校验输入"
                    aria-invalid={checksumPreview.error ? "true" : "false"}
                    aria-describedby="checksum-reference-error"
                    placeholder={checksumInputMode === "text" ? "输入 UTF-8 文本" : "输入 HEX 字节"}
                    value={checksumInput}
                    maxLength={MAX_CHECKSUM_INPUT_CHARACTERS}
                    spellCheck={false}
                    onChange={(event) => setChecksumInput(event.target.value)}
                  />
                </label>
                <span
                  id="checksum-reference-error"
                  className="checksum-reference-error"
                  role={checksumPreview.error ? "alert" : undefined}
                >
                  {checksumPreview.error || "\u00a0"}
                </span>
                <dl className="checksum-reference-results" aria-label="校验结果">
                  <div>
                    <dt>CRC-16/MODBUS</dt>
                    <dd>
                      <code>{formatChecksumHex(checksumPreview.result?.crc16Modbus, 4)}</code>
                      <span>
                        {checksumPreview.result
                          ? `低字节在前 ${formatModbusCrcBytes(checksumPreview.result.crc16Modbus)}`
                          : "低字节在前"}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>CRC-32</dt>
                    <dd>
                      <code>{formatChecksumHex(checksumPreview.result?.crc32, 8)}</code>
                      <span>32 位</span>
                    </dd>
                  </div>
                  <div>
                    <dt>XOR-8</dt>
                    <dd>
                      <code>{formatChecksumHex(checksumPreview.result?.xor8, 2)}</code>
                      <span>逐字节异或</span>
                    </dd>
                  </div>
                  <div>
                    <dt>SUM-8</dt>
                    <dd>
                      <code>{formatChecksumHex(checksumPreview.result?.sum8, 2)}</code>
                      <span>累加低 8 位</span>
                    </dd>
                  </div>
                </dl>
              </div>
            )}
          </div>
        )}

        {visibleError && (
          <span id="command-send-error" className="send-error" role="alert">
            {visibleError}
          </span>
        )}
      </div>
    </section>
  );
}

function HighlightedTerminalPayload({ value, query }: { value: string; query: string }) {
  const matches = findTerminalLiteralMatches(value, query);
  if (matches.length === 0) {
    return value;
  }
  const content: ReactNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) {
      content.push(value.slice(cursor, match.start));
    }
    content.push(
      <mark className="terminal-search-match" key={`${match.start}-${match.end}`}>
        {value.slice(match.start, match.end)}
      </mark>,
    );
    cursor = match.end;
  }
  if (cursor < value.length) {
    content.push(value.slice(cursor));
  }
  return content;
}

function previewCommandTemplate(
  value: string,
  mode: DisplayMode,
  lineEnding: LineEnding,
  checksumMode: CommandChecksumMode,
): CommandTemplatePreview {
  try {
    const template = compileCommandTemplate(value, mode);
    const nowMs = Date.now();
    const rendered = renderCommandTemplate(
      template,
      { sequence: 1, nowMs, taskStartedAtMs: nowMs },
      lineEnding,
      checksumMode,
    );
    return {
      byteCount: rendered.bytes.length,
      variableCount: rendered.variableCount,
      checksumHex: formatHex(rendered.checksumBytes),
      error: "",
    };
  } catch (error) {
    return {
      byteCount: 0,
      variableCount: 0,
      checksumHex: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function commandTemplateSummaryLabel(preview: CommandTemplatePreview): string {
  const summary = `命令模板包含 ${preview.variableCount} 个变量，最终 ${preview.byteCount} 字节`;
  return preview.checksumHex ? `${summary}，校验尾 ${preview.checksumHex}` : summary;
}

function previewChecksum(value: string, mode: ChecksumInputMode): ChecksumPreview {
  try {
    const result = calculateChecksums(value, mode);
    return {
      result: result.byteCount > 0 ? result : null,
      error: "",
    };
  } catch (error) {
    return {
      result: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function previewDataConversion(
  value: string,
  direction: DataConverterDirection,
  numericType: DataNumericType,
  endianness: DataConverterEndianness,
): DataConverterPreview {
  try {
    const result = convertData(value, direction, numericType, endianness);
    return {
      result: result.byteCount > 0 ? result : null,
      error: "",
    };
  } catch (error) {
    return {
      result: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatChecksumHex(value: number | undefined, width: number): string {
  return value === undefined
    ? "--"
    : `0x${value.toString(16).toUpperCase().padStart(width, "0")}`;
}

function formatModbusCrcBytes(value: number): string {
  const low = value & 0xff;
  const high = (value >>> 8) & 0xff;
  return [low, high]
    .map((byte) => byte.toString(16).toUpperCase().padStart(2, "0"))
    .join(" ");
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function fileSendStatusLabel(status: SerialFileSendStatus): string {
  switch (status) {
    case "queued":
      return "等待发送";
    case "sending":
      return "正在发送";
    case "cancelling":
      return "正在取消";
    case "completed":
      return "发送完成";
    case "cancelled":
      return "已取消";
    case "error":
      return "发送失败";
    case "idle":
      return "等待开始";
  }
}

function isFileSendActive(status: SerialFileSendStatus): boolean {
  return status === "queued" || status === "sending" || status === "cancelling";
}

function formatFileBytes(value: number): string {
  if (value < 1_024) {
    return `${value} B`;
  }
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let amount = value / 1_024;
  let unitIndex = 0;
  while (amount >= 1_024 && unitIndex < units.length - 1) {
    amount /= 1_024;
    unitIndex += 1;
  }
  return `${amount.toFixed(amount < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

function formatTaskSummary(task: CommandTaskSnapshot): string {
  if (task.status === "idle") {
    return "等待启动";
  }
  const progress =
    task.repeatCount === null ? `${task.sentCount} 次` : `${task.sentCount}/${task.repeatCount}`;
  if (task.status === "running") {
    return `运行中 · ${progress} · ${task.intervalMs} ms`;
  }
  if (task.status === "stopping") {
    return `停止中 · ${progress}`;
  }
  return `${task.message} · ${progress}`;
}

function historyPreview(entry: CommandHistoryEntry): string {
  const value = entry.value.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  return value || `<${lineEndingLabel(entry.lineEnding)}>`;
}

function lineEndingLabel(lineEnding: LineEnding): string {
  switch (lineEnding) {
    case "lf":
      return "LF";
    case "cr":
      return "CR";
    case "crlf":
      return "CRLF";
    default:
      return "无行尾";
  }
}

function terminalTimeDescription(mode: TerminalTimeMode, label: string): string {
  switch (mode) {
    case "relative":
      return `相对缓存起点 ${label}`;
    case "interval":
      return label === "--" ? "没有上一条可见记录" : `距上一条可见记录 ${label}`;
    default:
      return `绝对时间 ${label}`;
  }
}

function terminalRxBoundaryLabel(boundary: NonNullable<TerminalEntry["rxBoundary"]>): string {
  return boundary === "overflow"
    ? "未遇接收行尾，已按 2048 字节分段"
    : "记录已在边界处结束，未包含配置的接收行尾";
}
