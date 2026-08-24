import type {
  AttitudeAngleUnit,
  AttitudeChannelValue,
  AttitudeChannels,
  AttitudeConfig,
  AttitudeCoordinateFrame,
  AttitudeInputMode,
  AttitudeSample,
  Quaternion,
} from "../types/attitude";

export type {
  AttitudeAngleUnit,
  AttitudeChannelValue,
  AttitudeChannels,
  AttitudeConfig,
  AttitudeCoordinateFrame,
  AttitudeInputMode,
  AttitudeQuaternion,
  AttitudeSample,
  AttitudeSourceValues,
  EulerAttitudeSample,
  EulerAttitudeSourceValues,
  Quaternion,
  QuaternionAttitudeSample,
  QuaternionAttitudeSourceValues,
} from "../types/attitude";

const CONFIG_KEYS = ["inputMode", "angleUnit", "coordinateFrame", "channels"] as const;
const CHANNEL_KEYS = ["roll", "pitch", "yaw", "w", "x", "y", "z"] as const;
const EULER_CHANNEL_KEYS = ["roll", "pitch", "yaw"] as const;
const QUATERNION_CHANNEL_KEYS = ["w", "x", "y", "z"] as const;
const INPUT_MODES = ["euler", "quaternion"] as const;
const ANGLE_UNITS = ["degrees", "radians"] as const;
const COORDINATE_FRAMES = ["enu-flu", "ned-frd"] as const;
const RAW_CHANNEL_ID_PATTERN = /^channel-(?:[0-9]|1[0-5])$/;
const DERIVED_CHANNEL_ID_PATTERN = /^derived:[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const QUATERNION_NORM_EPSILON = 1e-12;
const QUATERNION_SIGN_EPSILON = 1e-12;
const DEGREES_TO_RADIANS = Math.PI / 180;
const SQRT_ONE_HALF = Math.SQRT1_2;

const ENU_WORLD_TO_SCENE: Quaternion = Object.freeze({
  x: -SQRT_ONE_HALF,
  y: 0,
  z: 0,
  w: SQRT_ONE_HALF,
});
const NED_WORLD_TO_SCENE: Quaternion = Object.freeze({
  x: 0.5,
  y: 0.5,
  z: -0.5,
  w: 0.5,
});
const FLU_MODEL_TO_FRD_BODY: Quaternion = Object.freeze({ x: 1, y: 0, z: 0, w: 0 });

interface CollectedFrame {
  readonly frameIndex: number;
  timestamp: number;
  timestampConsistent: boolean;
  latestInputIndex: number;
  readonly values: Map<string, number>;
}

export function createDefaultAttitudeConfig(): AttitudeConfig {
  return {
    inputMode: "euler",
    angleUnit: "degrees",
    coordinateFrame: "enu-flu",
    channels: createEmptyChannels(),
  };
}

export function cloneAttitudeConfig(config: AttitudeConfig): AttitudeConfig {
  return {
    inputMode: config.inputMode,
    angleUnit: config.angleUnit,
    coordinateFrame: config.coordinateFrame,
    channels: { ...config.channels },
  };
}

export function parseAttitudeConfig(value: unknown): AttitudeConfig {
  const record = requireRecord(value, "姿态配置");
  assertExactKeys(record, CONFIG_KEYS, "姿态配置");
  const channelsRecord = requireRecord(record.channels, "姿态通道配置");
  assertExactKeys(channelsRecord, CHANNEL_KEYS, "姿态通道配置");

  const config: AttitudeConfig = {
    inputMode: requireEnum(record.inputMode, INPUT_MODES, "姿态输入模式"),
    angleUnit: requireEnum(record.angleUnit, ANGLE_UNITS, "姿态角单位"),
    coordinateFrame: requireEnum(record.coordinateFrame, COORDINATE_FRAMES, "姿态坐标系"),
    channels: parseChannels(channelsRecord),
  };
  assertActiveChannelsUnique(config);
  return config;
}

export function areAttitudeConfigsEqual(left: AttitudeConfig, right: AttitudeConfig): boolean {
  return (
    left.inputMode === right.inputMode &&
    left.angleUnit === right.angleUnit &&
    left.coordinateFrame === right.coordinateFrame &&
    CHANNEL_KEYS.every((key) => left.channels[key] === right.channels[key])
  );
}

export function isAttitudeConfigComplete(config: AttitudeConfig): boolean {
  try {
    const parsed = parseAttitudeConfig(config);
    return activeChannelKeys(parsed.inputMode).every((key) => parsed.channels[key] !== "");
  } catch {
    return false;
  }
}

export function extractLatestAttitudeSample(
  config: AttitudeConfig,
  values: readonly AttitudeChannelValue[],
): AttitudeSample | null {
  let parsedConfig: AttitudeConfig;
  try {
    parsedConfig = parseAttitudeConfig(config);
  } catch {
    return null;
  }
  const channelKeys = activeChannelKeys(parsedConfig.inputMode);
  if (!channelKeys.every((key) => parsedConfig.channels[key] !== "")) {
    return null;
  }

  const requiredChannelIds = new Set(channelKeys.map((key) => parsedConfig.channels[key]));
  const frames = new Map<number, CollectedFrame>();
  values.forEach((channelValue, inputIndex) => {
    if (
      !requiredChannelIds.has(channelValue.channelId) ||
      !Number.isSafeInteger(channelValue.frameIndex) ||
      channelValue.frameIndex < 0 ||
      !Number.isFinite(channelValue.timestamp)
    ) {
      return;
    }

    const existing = frames.get(channelValue.frameIndex);
    if (existing) {
      if (existing.timestamp !== channelValue.timestamp) {
        existing.timestampConsistent = false;
      }
      existing.latestInputIndex = inputIndex;
      existing.values.set(channelValue.channelId, channelValue.value);
      return;
    }
    frames.set(channelValue.frameIndex, {
      frameIndex: channelValue.frameIndex,
      timestamp: channelValue.timestamp,
      timestampConsistent: true,
      latestInputIndex: inputIndex,
      values: new Map([[channelValue.channelId, channelValue.value]]),
    });
  });

  const latestCompleteFrame = [...frames.values()]
    .filter((frame) => requiredChannelIds.size === frame.values.size)
    .sort((left, right) => right.latestInputIndex - left.latestInputIndex)[0];
  if (!latestCompleteFrame || !latestCompleteFrame.timestampConsistent) {
    return null;
  }

  const sourceValues = channelKeys.map((key) =>
    latestCompleteFrame.values.get(parsedConfig.channels[key]),
  );
  if (sourceValues.some((value) => value === undefined || !Number.isFinite(value))) {
    return null;
  }

  if (parsedConfig.inputMode === "euler") {
    const [roll, pitch, yaw] = sourceValues as [number, number, number];
    const bodyToWorld = eulerToQuaternion(roll, pitch, yaw, parsedConfig.angleUnit);
    return {
      inputMode: "euler",
      frameIndex: latestCompleteFrame.frameIndex,
      timestamp: latestCompleteFrame.timestamp,
      sourceValues: { inputMode: "euler", roll, pitch, yaw },
      sceneQuaternion: transformToScene(bodyToWorld, parsedConfig.coordinateFrame),
    };
  }

  const [w, x, y, z] = sourceValues as [number, number, number, number];
  const bodyToWorld = normalizeQuaternionOrNull({ x, y, z, w });
  if (!bodyToWorld) {
    return null;
  }
  return {
    inputMode: "quaternion",
    frameIndex: latestCompleteFrame.frameIndex,
    timestamp: latestCompleteFrame.timestamp,
    sourceValues: { inputMode: "quaternion", w, x, y, z },
    sceneQuaternion: transformToScene(bodyToWorld, parsedConfig.coordinateFrame),
  };
}

export function getNeutralSceneQuaternion(coordinateFrame: AttitudeCoordinateFrame): Quaternion {
  if (coordinateFrame === "enu-flu") {
    return cloneQuaternion(ENU_WORLD_TO_SCENE);
  }
  if (coordinateFrame === "ned-frd") {
    return normalizedQuaternion(
      multiplyQuaternionComponents(NED_WORLD_TO_SCENE, FLU_MODEL_TO_FRD_BODY),
    );
  }
  throw new Error("姿态坐标系无效");
}

export function quaternionMultiply(left: Quaternion, right: Quaternion): Quaternion {
  return normalizedQuaternion(multiplyQuaternionComponents(left, right));
}

export const multiplyQuaternions = quaternionMultiply;

export function quaternionInvert(quaternion: Quaternion): Quaternion {
  const normSquared =
    quaternion.x * quaternion.x +
    quaternion.y * quaternion.y +
    quaternion.z * quaternion.z +
    quaternion.w * quaternion.w;
  if (!Number.isFinite(normSquared) || normSquared <= QUATERNION_NORM_EPSILON ** 2) {
    throw new Error("四元数模长过小或包含非有限值");
  }
  return normalizedQuaternion({
    x: -quaternion.x / normSquared,
    y: -quaternion.y / normSquared,
    z: -quaternion.z / normSquared,
    w: quaternion.w / normSquared,
  });
}

export const invertQuaternion = quaternionInvert;

function createEmptyChannels(): AttitudeChannels {
  return {
    roll: "",
    pitch: "",
    yaw: "",
    w: "",
    x: "",
    y: "",
    z: "",
  };
}

function parseChannels(record: Record<string, unknown>): AttitudeChannels {
  const channels = createEmptyChannels();
  for (const key of CHANNEL_KEYS) {
    const value = record[key];
    if (typeof value !== "string" || !isChannelId(value)) {
      throw new Error(`姿态通道 ${key} 的 ID 无效`);
    }
    channels[key] = value;
  }
  return channels;
}

function isChannelId(value: string): boolean {
  return value === "" || RAW_CHANNEL_ID_PATTERN.test(value) || DERIVED_CHANNEL_ID_PATTERN.test(value);
}

function assertActiveChannelsUnique(config: AttitudeConfig): void {
  const usedChannelIds = new Set<string>();
  for (const key of activeChannelKeys(config.inputMode)) {
    const channelId = config.channels[key];
    if (channelId !== "" && usedChannelIds.has(channelId)) {
      throw new Error(`当前姿态模式包含重复通道：${channelId}`);
    }
    if (channelId !== "") {
      usedChannelIds.add(channelId);
    }
  }
}

function activeChannelKeys(inputMode: AttitudeInputMode) {
  return inputMode === "euler" ? EULER_CHANNEL_KEYS : QUATERNION_CHANNEL_KEYS;
}

function eulerToQuaternion(
  roll: number,
  pitch: number,
  yaw: number,
  angleUnit: AttitudeAngleUnit,
): Quaternion {
  const scale = angleUnit === "degrees" ? DEGREES_TO_RADIANS : 1;
  const halfRoll = roll * scale * 0.5;
  const halfPitch = pitch * scale * 0.5;
  const halfYaw = yaw * scale * 0.5;
  const sinRoll = Math.sin(halfRoll);
  const cosRoll = Math.cos(halfRoll);
  const sinPitch = Math.sin(halfPitch);
  const cosPitch = Math.cos(halfPitch);
  const sinYaw = Math.sin(halfYaw);
  const cosYaw = Math.cos(halfYaw);

  return normalizedQuaternion({
    x: sinRoll * cosPitch * cosYaw - cosRoll * sinPitch * sinYaw,
    y: cosRoll * sinPitch * cosYaw + sinRoll * cosPitch * sinYaw,
    z: cosRoll * cosPitch * sinYaw - sinRoll * sinPitch * cosYaw,
    w: cosRoll * cosPitch * cosYaw + sinRoll * sinPitch * sinYaw,
  });
}

function transformToScene(
  bodyToWorld: Quaternion,
  coordinateFrame: AttitudeCoordinateFrame,
): Quaternion {
  if (coordinateFrame === "enu-flu") {
    return normalizedQuaternion(multiplyQuaternionComponents(ENU_WORLD_TO_SCENE, bodyToWorld));
  }
  return normalizedQuaternion(
    multiplyQuaternionComponents(
      multiplyQuaternionComponents(NED_WORLD_TO_SCENE, bodyToWorld),
      FLU_MODEL_TO_FRD_BODY,
    ),
  );
}

function multiplyQuaternionComponents(left: Quaternion, right: Quaternion): Quaternion {
  return {
    x: left.w * right.x + left.x * right.w + left.y * right.z - left.z * right.y,
    y: left.w * right.y - left.x * right.z + left.y * right.w + left.z * right.x,
    z: left.w * right.z + left.x * right.y - left.y * right.x + left.z * right.w,
    w: left.w * right.w - left.x * right.x - left.y * right.y - left.z * right.z,
  };
}

function normalizedQuaternion(quaternion: Quaternion): Quaternion {
  const normalized = normalizeQuaternionOrNull(quaternion);
  if (!normalized) {
    throw new Error("四元数模长过小或包含非有限值");
  }
  return normalized;
}

function normalizeQuaternionOrNull(quaternion: Quaternion): Quaternion | null {
  if (![quaternion.x, quaternion.y, quaternion.z, quaternion.w].every(Number.isFinite)) {
    return null;
  }
  const norm = Math.hypot(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
  if (!Number.isFinite(norm) || norm <= QUATERNION_NORM_EPSILON) {
    return null;
  }

  let normalized = {
    x: quaternion.x / norm,
    y: quaternion.y / norm,
    z: quaternion.z / norm,
    w: quaternion.w / norm,
  };
  if (Math.abs(normalized.w) <= QUATERNION_SIGN_EPSILON) {
    const spatialNorm = Math.hypot(normalized.x, normalized.y, normalized.z);
    if (spatialNorm <= QUATERNION_NORM_EPSILON) {
      return null;
    }
    normalized = {
      x: normalized.x / spatialNorm,
      y: normalized.y / spatialNorm,
      z: normalized.z / spatialNorm,
      w: 0,
    };
    const firstNonZero = [normalized.x, normalized.y, normalized.z].find(
      (component) => Math.abs(component) > QUATERNION_SIGN_EPSILON,
    );
    return firstNonZero !== undefined && firstNonZero < 0 ? negateQuaternion(normalized) : normalized;
  }
  return normalized.w < 0 ? negateQuaternion(normalized) : normalized;
}

function negateQuaternion(quaternion: Quaternion): Quaternion {
  return {
    x: -quaternion.x,
    y: -quaternion.y,
    z: -quaternion.z,
    w: -quaternion.w,
  };
}

function cloneQuaternion(quaternion: Quaternion): Quaternion {
  return { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w };
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function requireEnum<const T>(value: unknown, allowed: readonly T[], field: string): T {
  const candidate = allowed.find((item) => item === value);
  if (candidate === undefined) {
    throw new Error(`${field} 的值无效`);
  }
  return candidate;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  field: string,
): void {
  const missingKey = expectedKeys.find((key) => !Object.hasOwn(value, key));
  if (missingKey) {
    throw new Error(`${field} 缺少字段：${missingKey}`);
  }
  const unknownKey = Object.keys(value).find((key) => !expectedKeys.includes(key));
  if (unknownKey) {
    throw new Error(`${field} 包含未知字段：${unknownKey}`);
  }
}
