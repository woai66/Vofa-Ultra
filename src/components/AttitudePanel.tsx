import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CirclePause,
  Crosshair,
  Orbit,
  Play,
  Scan,
  SlidersHorizontal,
  TriangleAlert,
  WandSparkles,
  X,
} from "lucide-react";
import type { ThemeMode } from "../App";
import {
  cloneAttitudeConfig,
  getNeutralSceneQuaternion,
  isAttitudeConfigComplete,
  quaternionInvert,
  quaternionMultiply,
} from "../core/attitude";
import {
  getChannelPresentationOverride,
  presentChannelSeries,
  type PresentedChannelSeries,
} from "../core/channelPresentation";
import {
  selectActiveProtocol,
  useWorkbenchStore,
} from "../store/workbenchStore";
import type {
  AttitudeChannels,
  AttitudeConfig,
  AttitudeInputMode,
  AttitudeSample,
  Quaternion,
} from "../types/attitude";
import type { ProtocolKind } from "../types/serial";
import type { ChannelPresentations } from "../types/workspace";
import { AttitudeScene } from "./AttitudeScene";

interface AttitudePanelProps {
  theme: ThemeMode;
}

interface FrozenSample {
  key: string;
  sample: AttitudeSample & { readonly receivedAt: number };
}

interface ZeroReference {
  key: string;
  quaternion: Quaternion;
}

interface ChannelOption {
  id: string;
  name: string;
  sourceName: string;
}

const EULER_CHANNELS = [
  ["roll", "Roll"],
  ["pitch", "Pitch"],
  ["yaw", "Yaw"],
] as const;
const QUATERNION_CHANNELS = [
  ["w", "W"],
  ["x", "X"],
  ["y", "Y"],
  ["z", "Z"],
] as const;

export function AttitudePanel({ theme }: AttitudePanelProps) {
  const channels = useWorkbenchStore((state) => state.channels);
  const processedChannels = useWorkbenchStore((state) => state.processedChannels);
  const channelPresentations = useWorkbenchStore((state) => state.channelPresentations);
  const activeProtocol = useWorkbenchStore(selectActiveProtocol);
  const processingGraph = useWorkbenchStore((state) => state.processingGraph);
  const attitudeConfig = useWorkbenchStore((state) => state.attitudeConfig);
  const attitudeSample = useWorkbenchStore((state) => state.attitudeSample);
  const setAttitudeConfig = useWorkbenchStore((state) => state.setAttitudeConfig);
  const source = useWorkbenchStore((state) => state.source);
  const protocol = useWorkbenchStore((state) => state.protocol);
  const serialGeneration = useWorkbenchStore((state) => state.serialGeneration);
  const replaySessionId = useWorkbenchStore((state) => state.replaySessionId);
  const replayTimelineRevision = useWorkbenchStore((state) => state.replayTimelineRevision);
  const workspaceTransitioning = useWorkbenchStore(
    (state) => state.workspaceTransitionStatus !== "idle",
  );
  const complete = isAttitudeConfigComplete(attitudeConfig);
  const [configOpen, setConfigOpen] = useState(() => !complete);
  const [frozenSample, setFrozenSample] = useState<FrozenSample | null>(null);
  const [zeroReference, setZeroReference] = useState<ZeroReference | null>(null);
  const [cameraResetToken, setCameraResetToken] = useState(0);
  const [rendererError, setRendererError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const presentedChannels = useMemo(
    () =>
      channels.map((channel) =>
        presentChannelSeries(channel, activeProtocol, channelPresentations),
      ),
    [activeProtocol, channelPresentations, channels],
  );
  const presentedProcessedChannels = useMemo(
    () =>
      processedChannels.map((channel) =>
        presentChannelSeries(channel, activeProtocol, channelPresentations),
      ),
    [activeProtocol, channelPresentations, processedChannels],
  );
  const channelOptions = useMemo(
    () =>
      createChannelOptions(
        presentedChannels,
        presentedProcessedChannels,
        processingGraph,
        activeProtocol,
        channelPresentations,
      ),
    [
      activeProtocol,
      channelPresentations,
      presentedChannels,
      presentedProcessedChannels,
      processingGraph,
    ],
  );
  const runtimeKey = useMemo(
    () =>
      [
        source,
        protocol,
        serialGeneration,
        replaySessionId,
        replayTimelineRevision,
        attitudeConfigSignature(attitudeConfig),
      ].join("|"),
    [
      attitudeConfig,
      protocol,
      replaySessionId,
      replayTimelineRevision,
      serialGeneration,
      source,
    ],
  );
  const frozen = frozenSample?.key === runtimeKey;
  const visibleSample = frozen ? frozenSample.sample : attitudeSample;
  const activeZeroReference = zeroReference?.key === runtimeKey ? zeroReference : null;
  const neutralQuaternion = getNeutralSceneQuaternion(attitudeConfig.coordinateFrame);
  const displayQuaternion = visibleSample
    ? applyZeroReference(
        visibleSample.sceneQuaternion,
        activeZeroReference?.quaternion ?? null,
        neutralQuaternion,
      )
    : neutralQuaternion;
  const fresh = Boolean(
    attitudeSample && Math.max(0, now - attitudeSample.receivedAt) < 1_500,
  );

  useEffect(() => {
    if (!attitudeSample || frozen) {
      return undefined;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [attitudeSample, frozen]);

  const updateConfig = useCallback(
    (update: (next: AttitudeConfig) => void) => {
      const next = cloneAttitudeConfig(attitudeConfig);
      update(next);
      setAttitudeConfig(next);
      setFrozenSample(null);
      setZeroReference(null);
    },
    [attitudeConfig, setAttitudeConfig],
  );
  const handleRendererError = useCallback((message: string | null) => {
    setRendererError(message);
  }, []);
  const toggleFrozen = () => {
    if (frozen) {
      setFrozenSample(null);
      return;
    }
    if (attitudeSample) {
      setFrozenSample({ key: runtimeKey, sample: attitudeSample });
    }
  };
  const toggleZeroReference = () => {
    if (activeZeroReference) {
      setZeroReference(null);
      return;
    }
    if (visibleSample) {
      setZeroReference({ key: runtimeKey, quaternion: visibleSample.sceneQuaternion });
    }
  };
  const liveState = attitudeLiveState(complete, Boolean(visibleSample), frozen, fresh);

  return (
    <section className="workspace-panel attitude-panel" data-config-open={configOpen}>
      <header className="panel-toolbar">
        <div className="panel-title-group">
          <Orbit size={17} />
          <div>
            <h2>3D 姿态</h2>
            <span className="panel-subtitle">
              {attitudeConfig.inputMode === "euler" ? "Euler ZYX" : "Quaternion WXYZ"}
            </span>
          </div>
          <span className="live-state" data-paused={liveState !== "LIVE"}>
            <span />
            {liveState}
          </span>
        </div>
        <div className="panel-actions">
          <button
            className="icon-button"
            type="button"
            aria-label={frozen ? "继续姿态显示" : "冻结姿态显示"}
            title={frozen ? "继续姿态显示" : "冻结姿态显示"}
            aria-pressed={frozen}
            data-active={frozen}
            disabled={!attitudeSample}
            onClick={toggleFrozen}
          >
            {frozen ? <Play size={16} /> : <CirclePause size={16} />}
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label={activeZeroReference ? "取消姿态归零" : "以当前姿态归零"}
            title={activeZeroReference ? "取消姿态归零" : "以当前姿态归零"}
            aria-pressed={Boolean(activeZeroReference)}
            data-active={Boolean(activeZeroReference)}
            disabled={!visibleSample}
            onClick={toggleZeroReference}
          >
            <Crosshair size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="复位三维视角"
            title="复位三维视角"
            onClick={() => setCameraResetToken((token) => token + 1)}
          >
            <Scan size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="配置姿态通道"
            title="配置姿态通道"
            aria-expanded={configOpen}
            aria-controls="attitude-configuration"
            data-active={configOpen}
            onClick={() => setConfigOpen((open) => !open)}
          >
            <SlidersHorizontal size={16} />
          </button>
        </div>
      </header>

      <div className="attitude-viewport">
        <AttitudeScene
          orientation={displayQuaternion}
          coordinateFrame={attitudeConfig.coordinateFrame}
          theme={theme}
          resetToken={cameraResetToken}
          onRendererError={handleRendererError}
        />

        <div className="attitude-axis-legend" aria-label="场景坐标轴">
          <span data-axis="x">X · E</span>
          <span data-axis="y">
            Y · {attitudeConfig.coordinateFrame === "enu-flu" ? "U" : "-D"}
          </span>
          <span data-axis="z">-Z · N</span>
        </div>

        {rendererError && (
          <div className="attitude-state-overlay" role="alert">
            <TriangleAlert size={28} />
            <strong>3D 渲染不可用</strong>
            <span>{rendererError}</span>
          </div>
        )}
        {!rendererError && !complete && (
          <div className="attitude-state-overlay">
            <Orbit size={28} />
            <strong>姿态映射未完成</strong>
            <button className="secondary-button" type="button" onClick={() => setConfigOpen(true)}>
              <SlidersHorizontal size={15} />
              配置通道
            </button>
          </div>
        )}
        {!rendererError && complete && !visibleSample && (
          <div className="attitude-state-overlay" aria-live="polite">
            <Orbit size={28} />
            <strong>等待完整姿态帧</strong>
          </div>
        )}

        <AttitudeReadouts sample={visibleSample} config={attitudeConfig} />

        {configOpen && (
          <AttitudeConfiguration
            config={attitudeConfig}
            channelOptions={channelOptions}
            disabled={workspaceTransitioning}
            onChange={updateConfig}
            onClose={() => setConfigOpen(false)}
          />
        )}
      </div>
    </section>
  );
}

function AttitudeConfiguration({
  config,
  channelOptions,
  disabled,
  onChange,
  onClose,
}: {
  config: AttitudeConfig;
  channelOptions: ChannelOption[];
  disabled: boolean;
  onChange(update: (next: AttitudeConfig) => void): void;
  onClose(): void;
}) {
  const activeChannels = config.inputMode === "euler" ? EULER_CHANNELS : QUATERNION_CHANNELS;
  const mappedIds = new Set(activeChannels.map(([key]) => config.channels[key]).filter(Boolean));
  const autoMapping = findAutomaticMapping(config.inputMode, channelOptions);

  return (
    <div
      id="attitude-configuration"
      className="attitude-configuration"
      role="dialog"
      aria-label="姿态通道配置"
    >
      <header>
        <div>
          <strong>姿态数据</strong>
          <span>{config.coordinateFrame === "enu-flu" ? "ENU / FLU" : "NED / FRD"}</span>
        </div>
        <button className="icon-button compact" type="button" aria-label="关闭姿态配置" onClick={onClose}>
          <X size={15} />
        </button>
      </header>

      <div className="attitude-config-body">
        <div className="attitude-config-mode segmented-control" role="group" aria-label="姿态输入格式">
          {(["euler", "quaternion"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              data-active={config.inputMode === mode}
              disabled={disabled}
              onClick={() => onChange((next) => setInputMode(next, mode))}
            >
              {mode === "euler" ? "Euler" : "Quaternion"}
            </button>
          ))}
        </div>

        <div className="attitude-channel-mapping">
          {activeChannels.map(([key, label]) => (
            <label key={key}>
              <span>{label}</span>
              <select
                id={`attitude-channel-${key}`}
                name={`attitude-channel-${key}`}
                aria-label={`${label} 姿态通道`}
                value={config.channels[key]}
                disabled={disabled}
                onChange={(event) =>
                  onChange((next) => {
                    next.channels[key] = event.target.value;
                  })
                }
              >
                <option value="">未映射</option>
                {channelOptions.map((option) => (
                  <option
                    key={option.id}
                    value={option.id}
                    disabled={mappedIds.has(option.id) && config.channels[key] !== option.id}
                  >
                    {option.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>

        <div className="attitude-config-row">
          {config.inputMode === "euler" && (
            <div className="segmented-control" role="group" aria-label="姿态角单位">
              {(["degrees", "radians"] as const).map((unit) => (
                <button
                  key={unit}
                  type="button"
                  data-active={config.angleUnit === unit}
                  disabled={disabled}
                  onClick={() =>
                    onChange((next) => {
                      next.angleUnit = unit;
                    })
                  }
                >
                  {unit === "degrees" ? "deg" : "rad"}
                </button>
              ))}
            </div>
          )}
          <div className="segmented-control" role="group" aria-label="姿态坐标约定">
            {(["enu-flu", "ned-frd"] as const).map((frame) => (
              <button
                key={frame}
                type="button"
                data-active={config.coordinateFrame === frame}
                disabled={disabled}
                onClick={() =>
                  onChange((next) => {
                    next.coordinateFrame = frame;
                  })
                }
              >
                {frame === "enu-flu" ? "ENU / FLU" : "NED / FRD"}
              </button>
            ))}
          </div>
          <button
            className="icon-button attitude-auto-map"
            type="button"
            aria-label="自动映射姿态通道"
            title="自动映射姿态通道"
            disabled={disabled || !autoMapping}
            onClick={() => {
              if (autoMapping) {
                onChange((next) => Object.assign(next.channels, autoMapping));
              }
            }}
          >
            <WandSparkles size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

function AttitudeReadouts({
  sample,
  config,
}: {
  sample: AttitudeSample | null;
  config: AttitudeConfig;
}) {
  const values = config.inputMode === "euler" ? EULER_CHANNELS : QUATERNION_CHANNELS;
  return (
    <dl className="attitude-readouts" aria-label="当前姿态值" aria-live="polite">
      {values.map(([key, label]) => (
        <div key={key}>
          <dt>{label}</dt>
          <dd>{formatSourceValue(sample, key, config)}</dd>
        </div>
      ))}
    </dl>
  );
}

function formatSourceValue(
  sample: AttitudeSample | null,
  key: keyof AttitudeChannels,
  config: AttitudeConfig,
): string {
  if (!sample || sample.inputMode !== config.inputMode || !(key in sample.sourceValues)) {
    return "--";
  }
  const value = sample.sourceValues[key as keyof typeof sample.sourceValues];
  if (typeof value !== "number") {
    return "--";
  }
  if (config.inputMode === "euler") {
    return config.angleUnit === "degrees" ? `${formatNumber(value)}°` : `${formatNumber(value)} rad`;
  }
  return formatNumber(value);
}

function formatNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 10_000 || (absolute > 0 && absolute < 0.001)) {
    return value.toExponential(2);
  }
  return value.toFixed(3);
}

function createChannelOptions(
  channels: readonly PresentedChannelSeries[],
  processedChannels: readonly PresentedChannelSeries[],
  processingGraph: ReturnType<typeof useWorkbenchStore.getState>["processingGraph"],
  activeProtocol: ProtocolKind,
  channelPresentations: ChannelPresentations,
): ChannelOption[] {
  const runtimeChannels = new Map(
    [...channels, ...processedChannels].map((channel) => [
      channel.id,
      { name: channel.displayName, sourceName: channel.name },
    ]),
  );
  const options: ChannelOption[] = Array.from({ length: 16 }, (_, index) => {
    const id = `channel-${index}`;
    const fallbackName = `CH ${index + 1}`;
    const runtimeChannel = runtimeChannels.get(id);
    const savedAlias =
      getChannelPresentationOverride(channelPresentations, activeProtocol, id)?.alias ||
      fallbackName;
    return {
      id,
      name: runtimeChannel?.name ?? savedAlias,
      sourceName: runtimeChannel?.sourceName ?? fallbackName,
    };
  });
  for (const node of processingGraph.nodes) {
    if (node.kind !== "output") {
      continue;
    }
    const id = `derived:${node.id}`;
    const runtimeChannel = runtimeChannels.get(id);
    options.push({
      id,
      name: runtimeChannel?.name ?? node.name,
      sourceName: runtimeChannel?.sourceName ?? node.name,
    });
  }
  return options;
}

function findAutomaticMapping(
  inputMode: AttitudeInputMode,
  options: readonly ChannelOption[],
): Partial<AttitudeChannels> | null {
  const aliases =
    inputMode === "euler"
      ? {
          roll: ["roll", "rolling", "滚转", "横滚"],
          pitch: ["pitch", "俯仰"],
          yaw: ["yaw", "heading", "航向", "偏航"],
        }
      : {
          w: ["qw", "quatw", "quaternionw", "q0"],
          x: ["qx", "quatx", "quaternionx", "q1"],
          y: ["qy", "quaty", "quaterniony", "q2"],
          z: ["qz", "quatz", "quaternionz", "q3"],
        };
  const mapping: Partial<AttitudeChannels> = {};
  for (const [key, names] of Object.entries(aliases)) {
    const option =
      options.find((candidate) =>
        names.includes(normalizeChannelName(candidate.sourceName)),
      ) ??
      options.find((candidate) => names.includes(normalizeChannelName(candidate.name)));
    if (!option) {
      return null;
    }
    mapping[key as keyof AttitudeChannels] = option.id;
  }
  return new Set(Object.values(mapping)).size === Object.keys(aliases).length ? mapping : null;
}

function normalizeChannelName(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s_\-./()[\]]/g, "");
}

function setInputMode(config: AttitudeConfig, inputMode: AttitudeInputMode): void {
  config.inputMode = inputMode;
  const keys = inputMode === "euler" ? EULER_CHANNELS : QUATERNION_CHANNELS;
  const used = new Set<string>();
  for (const [key] of keys) {
    const channelId = config.channels[key];
    if (channelId && used.has(channelId)) {
      config.channels[key] = "";
    } else if (channelId) {
      used.add(channelId);
    }
  }
}

function attitudeConfigSignature(config: AttitudeConfig): string {
  return [
    config.inputMode,
    config.angleUnit,
    config.coordinateFrame,
    ...Object.values(config.channels),
  ].join(":");
}

function applyZeroReference(
  current: Quaternion,
  reference: Quaternion | null,
  neutral: Quaternion,
): Quaternion {
  if (!reference) {
    return current;
  }
  return quaternionMultiply(quaternionMultiply(current, quaternionInvert(reference)), neutral);
}

function attitudeLiveState(
  complete: boolean,
  hasSample: boolean,
  frozen: boolean,
  fresh: boolean,
): "SETUP" | "WAIT" | "LIVE" | "HOLD" {
  if (!complete) {
    return "SETUP";
  }
  if (frozen || (hasSample && !fresh)) {
    return "HOLD";
  }
  if (fresh) {
    return "LIVE";
  }
  return "WAIT";
}
