import { useState } from "react";
import { X } from "lucide-react";
import { parseChartSampleRate } from "../core/waveformTimebase";

interface WaveformTimebaseControlsProps {
  sampleRateHz: number | null;
  disabled: boolean;
  onApply(sampleRateHz: number | null): void;
  onClose(): void;
}

export default function WaveformTimebaseControls({
  sampleRateHz, disabled, onApply, onClose,
}: WaveformTimebaseControlsProps) {
  const [mode, setMode] = useState(sampleRateHz === null ? "arrival" : "fixed");
  const [rate, setRate] = useState(String(sampleRateHz ?? 1000));
  const [error, setError] = useState("");
  const apply = () => {
    try {
      onApply(mode === "arrival" ? null : parseChartSampleRate(Number(rate)));
      onClose();
    } catch (failure) {
      setError(failure instanceof DOMException &&
        (failure.name === "QuotaExceededError" || failure.name === "SecurityError")
        ? "本次时基已应用，但未能保存到本机；重启前请导出工作区。"
        : failure instanceof Error ? failure.message : "时基设置失败");
    }
  };

  return (
    <div
      className="waveform-timebase-controls"
      id="waveform-timebase-controls"
      role="region"
      aria-label="波形时基"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <label>
        <span>时基</span>
        <select
          autoFocus
          id="waveform-timebase-mode"
          name="waveform-timebase-mode"
          value={mode}
          disabled={disabled}
          onChange={(event) => { setMode(event.target.value); setError(""); }}
        >
          <option value="arrival">主机接收时间</option>
          <option value="fixed">固定采样率</option>
        </select>
      </label>
      {mode === "fixed" && (
        <label>
          <span>设备采样率 (Hz)</span>
          <input
            id="waveform-sample-rate"
            name="waveform-sample-rate"
            type="text"
            inputMode="decimal"
            value={rate}
            disabled={disabled}
            aria-invalid={!!error}
            onChange={(event) => { setRate(event.target.value); setError(""); }}
          />
        </label>
      )}
      <button type="button" className="secondary-button" disabled={disabled} onClick={apply}>
        应用并清空波形
      </button>
      <button type="button" className="icon-button" aria-label="关闭时基设置" onClick={onClose}>
        <X size={16} />
      </button>
      <span className="waveform-timebase-note">
        {mode === "arrival"
          ? "主机到达时刻；同批数据可共享时间，不代表设备采样间隔。"
          : "从当前片段起点按匀速采样推算；实际采样率和丢样情况需另行核对。"}
      </span>
      {error && <span className="waveform-timebase-error" role="alert">{error}</span>}
    </div>
  );
}
