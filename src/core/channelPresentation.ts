import type { ProtocolKind } from "../types/serial";
import type { ChannelSeries } from "../types/workbench";
import type {
  BaseChannelId,
  ChannelPresentationOverride,
  ChannelPresentationProtocol,
  ChannelPresentations,
} from "../types/workspace";

export const CHANNEL_PRESENTATION_PROTOCOLS = ["firewater", "justfloat"] as const;
export const MAX_CHANNEL_PRESENTATION_ALIAS_LENGTH = 64;
export const MAX_CHANNEL_PRESENTATION_ALIAS_BYTES = 256;
export const MAX_CHANNEL_PRESENTATION_UNIT_LENGTH = 24;
export const MAX_CHANNEL_PRESENTATION_UNIT_BYTES = 64;

const CHANNEL_PRESENTATION_KEYS = ["firewater", "justfloat"] as const;
const CHANNEL_PRESENTATION_OVERRIDE_KEYS = ["alias", "unit", "color"] as const;
const BASE_CHANNEL_ID_PATTERN = /^channel-(?:[0-9]|1[0-5])$/;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

export interface PresentedChannelSeries extends ChannelSeries {
  displayName: string;
  unit: string;
}

export function createDefaultChannelPresentations(): ChannelPresentations {
  return {
    firewater: {},
    justfloat: {},
  };
}

export function parseChannelPresentations(value: unknown): ChannelPresentations {
  const record = requireRecord(value, "通道展示配置");
  assertExactKeys(record, CHANNEL_PRESENTATION_KEYS, "通道展示配置");
  return {
    firewater: parseProtocolPresentations(record.firewater, "FireWater"),
    justfloat: parseProtocolPresentations(record.justfloat, "JustFloat"),
  };
}

export function cloneChannelPresentations(
  presentations: ChannelPresentations,
): ChannelPresentations {
  return {
    firewater: cloneProtocolPresentations(presentations.firewater),
    justfloat: cloneProtocolPresentations(presentations.justfloat),
  };
}

export function areChannelPresentationsEqual(
  left: ChannelPresentations,
  right: ChannelPresentations,
): boolean {
  return CHANNEL_PRESENTATION_PROTOCOLS.every((protocol) =>
    baseChannelIds().every((channelId) => {
      const leftOverride = left[protocol][channelId];
      const rightOverride = right[protocol][channelId];
      return leftOverride === undefined
        ? rightOverride === undefined
        : rightOverride !== undefined &&
            leftOverride.alias === rightOverride.alias &&
            leftOverride.unit === rightOverride.unit &&
            leftOverride.color === rightOverride.color;
    }),
  );
}

export function normalizeChannelPresentationOverride(
  value: unknown,
): ChannelPresentationOverride | null {
  const record = requireRecord(value, "通道展示覆盖");
  assertExactKeys(record, CHANNEL_PRESENTATION_OVERRIDE_KEYS, "通道展示覆盖");
  const alias = normalizeText(
    record.alias,
    "通道别名",
    MAX_CHANNEL_PRESENTATION_ALIAS_LENGTH,
    MAX_CHANNEL_PRESENTATION_ALIAS_BYTES,
  );
  const unit = normalizeText(
    record.unit,
    "通道单位",
    MAX_CHANNEL_PRESENTATION_UNIT_LENGTH,
    MAX_CHANNEL_PRESENTATION_UNIT_BYTES,
  );
  const color = normalizeColor(record.color);
  return alias || unit || color ? { alias, unit, color } : null;
}

export function updateChannelPresentation(
  presentations: ChannelPresentations,
  protocol: ChannelPresentationProtocol,
  channelId: BaseChannelId,
  value: ChannelPresentationOverride | null,
): ChannelPresentations {
  requirePresentationProtocol(protocol);
  requireBaseChannelId(channelId);
  const normalized = value === null ? null : normalizeChannelPresentationOverride(value);
  const current = presentations[protocol][channelId];

  if (normalized === null) {
    if (current === undefined) {
      return presentations;
    }
    const nextProtocol = { ...presentations[protocol] };
    delete nextProtocol[channelId];
    return { ...presentations, [protocol]: nextProtocol };
  }
  if (
    current?.alias === normalized.alias &&
    current.unit === normalized.unit &&
    current.color === normalized.color
  ) {
    return presentations;
  }
  return {
    ...presentations,
    [protocol]: {
      ...presentations[protocol],
      [channelId]: normalized,
    },
  };
}

export function getChannelPresentationOverride(
  presentations: ChannelPresentations,
  protocol: ProtocolKind,
  channelId: string,
): Readonly<ChannelPresentationOverride> | null {
  if (!isPresentationProtocol(protocol) || !isBaseChannelId(channelId)) {
    return null;
  }
  return presentations[protocol][channelId] ?? null;
}

export function presentChannelSeries(
  channel: ChannelSeries,
  protocol: ProtocolKind,
  presentations: ChannelPresentations,
): PresentedChannelSeries {
  const override = getChannelPresentationOverride(presentations, protocol, channel.id);
  return {
    ...channel,
    displayName: override?.alias || channel.name,
    unit: override?.unit ?? "",
    color: override?.color ?? channel.color,
  };
}

function parseProtocolPresentations(
  value: unknown,
  protocolLabel: string,
): Partial<Record<BaseChannelId, ChannelPresentationOverride>> {
  const record = requireRecord(value, `${protocolLabel} 通道展示配置`);
  const entries = Object.entries(record);
  if (entries.length > 16) {
    throw new Error(`${protocolLabel} 通道展示配置最多包含 16 项`);
  }

  const result: Partial<Record<BaseChannelId, ChannelPresentationOverride>> = {};
  for (const [channelId, rawOverride] of entries) {
    const validChannelId = requireBaseChannelId(channelId);
    const override = normalizeChannelPresentationOverride(rawOverride);
    if (override) {
      result[validChannelId] = override;
    }
  }
  return result;
}

function cloneProtocolPresentations(
  presentations: Partial<Record<BaseChannelId, ChannelPresentationOverride>>,
): Partial<Record<BaseChannelId, ChannelPresentationOverride>> {
  const cloned: Partial<Record<BaseChannelId, ChannelPresentationOverride>> = {};
  for (const channelId of baseChannelIds()) {
    const override = presentations[channelId];
    if (override) {
      cloned[channelId] = { ...override };
    }
  }
  return cloned;
}

function normalizeText(
  value: unknown,
  label: string,
  maxLength: number,
  maxBytes: number,
): string {
  if (typeof value !== "string") {
    throw new Error(`${label}必须是字符串`);
  }
  if (containsControlCharacter(value)) {
    throw new Error(`${label}不能包含控制字符`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  }
  if (new TextEncoder().encode(normalized).byteLength > maxBytes) {
    throw new Error(`${label}不能超过 ${maxBytes} 字节`);
  }
  return normalized;
}

function normalizeColor(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || !COLOR_PATTERN.test(value)) {
    throw new Error("通道颜色必须是 #RRGGBB 或 null");
  }
  return value.toLowerCase();
}

function requirePresentationProtocol(value: unknown): ChannelPresentationProtocol {
  if (!isPresentationProtocol(value)) {
    throw new Error("通道展示配置仅支持 FireWater 和 JustFloat");
  }
  return value;
}

function isPresentationProtocol(value: unknown): value is ChannelPresentationProtocol {
  return CHANNEL_PRESENTATION_PROTOCOLS.some((protocol) => protocol === value);
}

function requireBaseChannelId(value: string): BaseChannelId {
  if (!isBaseChannelId(value)) {
    throw new Error(`通道展示配置不支持通道：${value}`);
  }
  return value;
}

function isBaseChannelId(value: string): value is BaseChannelId {
  return BASE_CHANNEL_ID_PATTERN.test(value);
}

function baseChannelIds(): BaseChannelId[] {
  return Array.from({ length: 16 }, (_, index) => `channel-${index}` as BaseChannelId);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}必须是对象`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const missingKey = expectedKeys.find((key) => !Object.hasOwn(record, key));
  const unknownKey = Object.keys(record).find((key) => !expectedKeys.includes(key));
  if (missingKey) {
    throw new Error(`${label}缺少字段：${missingKey}`);
  }
  if (unknownKey) {
    throw new Error(`${label}包含未知字段：${unknownKey}`);
  }
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || (code >= 127 && code <= 159);
  });
}
