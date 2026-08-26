import { useEffect, useMemo, useState } from "react";
import {
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Zap,
} from "lucide-react";
import {
  MAX_AUTO_RESPONDER_COOLDOWN_MS,
  MAX_AUTO_RESPONDER_RULES,
  MIN_AUTO_RESPONDER_COOLDOWN_MS,
  areAutoResponderRulesEqual,
  createDefaultAutoResponderRule,
  isAutoResponderActive,
} from "../core/autoResponder";
import { useWorkbenchStore } from "../store/workbenchStore";
import type { AutoResponderRule } from "../types/automation";
import type { DisplayMode, LineEnding } from "../types/serial";

export function AutomationPanel() {
  const rules = useWorkbenchStore((state) => state.autoResponderRules);
  const runtime = useWorkbenchStore((state) => state.autoResponder);
  const connectionStatus = useWorkbenchStore((state) => state.connectionStatus);
  const commandTask = useWorkbenchStore((state) => state.commandTask);
  const isSendingCommand = useWorkbenchStore((state) => state.isSendingCommand);
  const workspaceTransitionStatus = useWorkbenchStore(
    (state) => state.workspaceTransitionStatus,
  );
  const runtimeTransitionStatus = useWorkbenchStore(
    (state) => state.runtimeTransitionStatus,
  );
  const workspaceStorageStatus = useWorkbenchStore(
    (state) => state.workspaceStorageStatus,
  );
  const setRules = useWorkbenchStore((state) => state.setAutoResponderRules);
  const start = useWorkbenchStore((state) => state.startAutoResponder);
  const stop = useWorkbenchStore((state) => state.stopAutoResponder);
  const [selectedId, setSelectedId] = useState(rules[0]?.id ?? "");
  const selectedRule = rules.find((rule) => rule.id === selectedId) ?? rules[0];
  const [draft, setDraft] = useState<AutoResponderRule | null>(
    selectedRule ? { ...selectedRule } : null,
  );
  const [feedback, setFeedback] = useState("");
  const [isError, setIsError] = useState(false);
  const active = isAutoResponderActive(runtime);
  const taskActive = commandTask.status === "running" || commandTask.status === "stopping";
  const isTransitioning =
    workspaceTransitionStatus !== "idle" || runtimeTransitionStatus !== "idle";
  const editorDisabled =
    active || isTransitioning || workspaceStorageStatus === "newer-version";
  const enabledRuleCount = rules.filter((rule) => rule.enabled).length;
  const canStart =
    connectionStatus === "connected" &&
    enabledRuleCount > 0 &&
    !taskActive &&
    !isSendingCommand &&
    !isTransitioning;
  const draftDirty = useMemo(
    () => Boolean(
      draft && selectedRule && !areAutoResponderRulesEqual([draft], [selectedRule]),
    ),
    [draft, selectedRule],
  );

  useEffect(() => {
    if (!selectedRule) {
      setSelectedId("");
      setDraft(null);
      return;
    }
    if (selectedId !== selectedRule.id) {
      setSelectedId(selectedRule.id);
    }
    setDraft({ ...selectedRule });
  }, [selectedId, selectedRule]);

  const showFeedback = (message: string, error = false) => {
    setFeedback(message);
    setIsError(error);
  };

  const blockRuleMutationForDirtyDraft = () => {
    if (!draftDirty) {
      return false;
    }
    showFeedback("请先保存或还原当前规则修改");
    return true;
  };

  const updateDraft = <K extends keyof AutoResponderRule>(
    key: K,
    value: AutoResponderRule[K],
  ) => {
    setDraft((current) => current ? { ...current, [key]: value } : current);
    setFeedback("");
  };

  const selectRule = (rule: AutoResponderRule) => {
    if (blockRuleMutationForDirtyDraft()) {
      return;
    }
    setSelectedId(rule.id);
    setDraft({ ...rule });
    setFeedback("");
  };

  const addRule = () => {
    if (editorDisabled || rules.length >= MAX_AUTO_RESPONDER_RULES) {
      return;
    }
    if (blockRuleMutationForDirtyDraft()) {
      return;
    }
    const next = createDefaultAutoResponderRule(
      createRuleId(rules),
      `规则 ${rules.length + 1}`,
    );
    try {
      setRules([...rules, next]);
      setSelectedId(next.id);
      setDraft({ ...next });
      showFeedback("规则已添加");
    } catch (error) {
      showFeedback(getErrorMessage(error), true);
    }
  };

  const saveDraft = () => {
    if (!draft || editorDisabled) {
      return;
    }
    try {
      setRules(rules.map((rule) => rule.id === draft.id ? draft : rule));
      showFeedback("规则已保存");
    } catch (error) {
      showFeedback(getErrorMessage(error), true);
    }
  };

  const deleteRule = (rule: AutoResponderRule) => {
    if (editorDisabled) {
      return;
    }
    if (blockRuleMutationForDirtyDraft()) {
      return;
    }
    const index = rules.findIndex((candidate) => candidate.id === rule.id);
    const nextRules = rules.filter((candidate) => candidate.id !== rule.id);
    try {
      setRules(nextRules);
      const nextSelection = nextRules[index] ?? nextRules[index - 1];
      setSelectedId(nextSelection?.id ?? "");
      setDraft(nextSelection ? { ...nextSelection } : null);
      showFeedback("规则已删除");
    } catch (error) {
      showFeedback(getErrorMessage(error), true);
    }
  };

  const toggleRule = (rule: AutoResponderRule, enabled: boolean) => {
    if (editorDisabled) {
      return;
    }
    if (blockRuleMutationForDirtyDraft()) {
      return;
    }
    try {
      setRules(rules.map((candidate) =>
        candidate.id === rule.id ? { ...candidate, enabled } : candidate));
      showFeedback(enabled ? "规则已启用" : "规则已停用");
    } catch (error) {
      showFeedback(getErrorMessage(error), true);
    }
  };

  const toggleRuntime = (enabled: boolean) => {
    setFeedback("");
    try {
      if (enabled) {
        start();
      } else {
        stop();
      }
    } catch (error) {
      showFeedback(getErrorMessage(error), true);
    }
  };

  return (
    <div className="sidebar-panel automation-panel">
      <div className="sidebar-heading">
        <div>
          <span className="eyebrow">AUTOMATION</span>
          <h1>自动应答</h1>
        </div>
        <Zap size={20} />
      </div>

      <section className="sidebar-section automation-runtime" aria-label="自动应答运行状态">
        <label className="toggle-row automation-runtime-toggle">
          <span>启用自动应答</span>
          <input
            id="automation-runtime-enabled"
            type="checkbox"
            checked={active}
            disabled={!active && !canStart}
            onChange={(event) => toggleRuntime(event.target.checked)}
          />
        </label>
        <div
          className="automation-state"
          data-status={runtime.status}
          role={runtime.status === "error" ? "alert" : "status"}
        >
          <span className="status-dot" />
          <div>
            <strong>{runtimeStatusLabel(runtime.status)}</strong>
            <span>{runtime.message}</span>
          </div>
        </div>
        <div className="automation-counters" aria-label="自动应答计数">
          <span>命中 <strong>{runtime.matchCount}</strong></span>
          <span>队列 <strong>{runtime.queuedCount}</strong></span>
          <span>发送 <strong>{runtime.sentCount}</strong></span>
        </div>
      </section>

      {feedback && (
        <div className="automation-feedback" role={isError ? "alert" : "status"} data-error={isError}>
          {feedback}
        </div>
      )}

      <section className="automation-rules-section" aria-labelledby="automation-rules-title">
        <div className="automation-rules-heading">
          <div>
            <span id="automation-rules-title">规则</span>
            <strong>{rules.length}/{MAX_AUTO_RESPONDER_RULES}</strong>
          </div>
          <button
            className="icon-button compact"
            type="button"
            aria-label="添加自动应答规则"
            title="添加规则"
            disabled={editorDisabled || rules.length >= MAX_AUTO_RESPONDER_RULES}
            onClick={addRule}
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="automation-rule-list" role="list" aria-label="自动应答规则">
          {rules.length === 0 && (
            <div className="sidebar-empty automation-empty">
              <Zap size={22} />
              <span>暂无自动应答规则</span>
            </div>
          )}
          {rules.map((rule) => (
            <div
              key={rule.id}
              className="automation-rule-row"
              data-selected={selectedRule?.id === rule.id}
              role="listitem"
            >
              <button
                className="automation-rule-select"
                type="button"
                aria-current={selectedRule?.id === rule.id ? "true" : undefined}
                onClick={() => selectRule(rule)}
              >
                <strong>{rule.name}</strong>
                <span>{formatRuleSummary(rule)}</span>
              </button>
              <label className="automation-rule-toggle" title="启用规则">
                <span className="sr-only">启用规则 {rule.name}</span>
                <input
                  id={`automation-rule-enabled-${rule.id}`}
                  type="checkbox"
                  checked={rule.enabled}
                  disabled={editorDisabled}
                  onChange={(event) => toggleRule(rule, event.target.checked)}
                />
              </label>
              <button
                className="icon-button compact danger-icon-button"
                type="button"
                aria-label={`删除规则 ${rule.name}`}
                title="删除规则"
                disabled={editorDisabled}
                onClick={() => deleteRule(rule)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </section>

      {draft && (
        <section className="sidebar-section automation-editor" aria-label="规则编辑器">
          <label className="field-label" htmlFor="automation-rule-name">规则名称</label>
          <input
            id="automation-rule-name"
            value={draft.name}
            maxLength={64}
            disabled={editorDisabled}
            onChange={(event) => updateDraft("name", event.target.value)}
          />

          <ModeField
            id="automation-trigger-mode"
            label="触发格式"
            value={draft.triggerMode}
            disabled={editorDisabled}
            onChange={(value) => updateDraft("triggerMode", value)}
          />
          <label className="field-label" htmlFor="automation-trigger">触发内容</label>
          <textarea
            id="automation-trigger"
            rows={2}
            value={draft.trigger}
            disabled={editorDisabled}
            spellCheck={false}
            onChange={(event) => updateDraft("trigger", event.target.value)}
          />

          <ModeField
            id="automation-response-mode"
            label="响应格式"
            value={draft.responseMode}
            disabled={editorDisabled}
            onChange={(value) => updateDraft("responseMode", value)}
          />
          <label className="field-label" htmlFor="automation-response">响应模板</label>
          <textarea
            id="automation-response"
            rows={3}
            value={draft.response}
            disabled={editorDisabled}
            spellCheck={false}
            onChange={(event) => updateDraft("response", event.target.value)}
          />

          <div className="automation-field-grid">
            <label>
              <span className="field-label">响应行尾</span>
              <select
                id="automation-response-line-ending"
                aria-label="响应行尾"
                value={draft.lineEnding}
                disabled={editorDisabled}
                onChange={(event) =>
                  updateDraft("lineEnding", event.target.value as LineEnding)
                }
              >
                <option value="none">无</option>
                <option value="lf">LF</option>
                <option value="cr">CR</option>
                <option value="crlf">CRLF</option>
              </select>
            </label>
            <label>
              <span className="field-label">冷却时间</span>
              <input
                id="automation-cooldown-ms"
                type="number"
                inputMode="numeric"
                aria-label="冷却时间（毫秒）"
                min={MIN_AUTO_RESPONDER_COOLDOWN_MS}
                max={MAX_AUTO_RESPONDER_COOLDOWN_MS}
                step={1}
                value={draft.cooldownMs}
                disabled={editorDisabled}
                onChange={(event) => updateDraft("cooldownMs", Number(event.target.value))}
              />
            </label>
          </div>

          <div className="automation-editor-actions">
            <button
              className="icon-button"
              type="button"
              aria-label="还原规则修改"
              title="还原修改"
              disabled={editorDisabled || !draftDirty}
              onClick={() => {
                if (selectedRule) {
                  setDraft({ ...selectedRule });
                  setFeedback("");
                }
              }}
            >
              <RotateCcw size={15} />
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={editorDisabled || !draftDirty}
              onClick={saveDraft}
            >
              <Save size={15} />
              保存规则
            </button>
          </div>
        </section>
      )}

    </div>
  );
}

function ModeField({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: DisplayMode;
  disabled: boolean;
  onChange(value: DisplayMode): void;
}) {
  return (
    <div className="automation-mode-field">
      <span className="field-label" id={`${id}-label`}>{label}</span>
      <div className="segmented-control" role="group" aria-labelledby={`${id}-label`}>
        <button
          type="button"
          data-active={value === "text"}
          disabled={disabled}
          onClick={() => onChange("text")}
        >
          TEXT
        </button>
        <button
          type="button"
          data-active={value === "hex"}
          disabled={disabled}
          onClick={() => onChange("hex")}
        >
          HEX
        </button>
      </div>
    </div>
  );
}

function createRuleId(rules: readonly AutoResponderRule[]): string {
  const usedIds = new Set(rules.map((rule) => rule.id));
  if (typeof globalThis.crypto?.randomUUID === "function") {
    const id = `rule-${globalThis.crypto.randomUUID()}`;
    if (!usedIds.has(id)) {
      return id;
    }
  }
  for (let index = 1; index <= MAX_AUTO_RESPONDER_RULES + 1; index += 1) {
    const id = `rule-${index}`;
    if (!usedIds.has(id)) {
      return id;
    }
  }
  throw new Error("无法生成自动应答规则 ID");
}

function formatRuleSummary(rule: AutoResponderRule): string {
  const trigger = rule.trigger.replace(/\s+/g, " ").trim();
  return `${rule.triggerMode.toUpperCase()} · ${trigger || "空"} · ${rule.cooldownMs} ms`;
}

function runtimeStatusLabel(status: AutoResponderSnapshotStatus): string {
  switch (status) {
    case "armed":
      return "等待触发";
    case "sending":
      return "正在应答";
    case "stopping":
      return "正在停止";
    case "stopped":
      return "已停止";
    case "error":
      return "安全停机";
    default:
      return "未启用";
  }
}

type AutoResponderSnapshotStatus = ReturnType<
  typeof useWorkbenchStore.getState
>["autoResponder"]["status"];

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
