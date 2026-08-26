export type AttitudeInputMode = "euler" | "quaternion";
export type AttitudeAngleUnit = "degrees" | "radians";
export type AttitudeCoordinateFrame = "enu-flu" | "ned-frd";

export interface AttitudeChannels {
  roll: string;
  pitch: string;
  yaw: string;
  w: string;
  x: string;
  y: string;
  z: string;
}

export interface AttitudeConfig {
  inputMode: AttitudeInputMode;
  angleUnit: AttitudeAngleUnit;
  coordinateFrame: AttitudeCoordinateFrame;
  channels: AttitudeChannels;
}

export interface Quaternion {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export type AttitudeQuaternion = Quaternion;

export interface AttitudeChannelValue {
  readonly frameIndex: number;
  readonly timestamp: number;
  readonly channelId: string;
  readonly value: number;
}

export interface EulerAttitudeSourceValues {
  readonly inputMode: "euler";
  readonly roll: number;
  readonly pitch: number;
  readonly yaw: number;
}

export interface QuaternionAttitudeSourceValues {
  readonly inputMode: "quaternion";
  readonly w: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type AttitudeSourceValues = EulerAttitudeSourceValues | QuaternionAttitudeSourceValues;

interface AttitudeSampleBase {
  readonly frameIndex: number;
  readonly timestamp: number;
  readonly sceneQuaternion: Quaternion;
}

export interface EulerAttitudeSample extends AttitudeSampleBase {
  readonly inputMode: "euler";
  readonly sourceValues: EulerAttitudeSourceValues;
}

export interface QuaternionAttitudeSample extends AttitudeSampleBase {
  readonly inputMode: "quaternion";
  readonly sourceValues: QuaternionAttitudeSourceValues;
}

export type AttitudeSample = EulerAttitudeSample | QuaternionAttitudeSample;
