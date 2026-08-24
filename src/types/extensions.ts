export const LIVE_RX_CAPABILITY = "live-rx.read" as const;

export type ExtensionStatus = "idle" | "active" | "error";

export type ExtensionOperation =
  | "idle"
  | "initializing"
  | "selecting"
  | "inspecting"
  | "activating"
  | "deactivating"
  | "resetting";

export interface ExtensionManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  license: string;
  apiVersion: number;
  kind: "protocol-parser";
  capabilities: string[];
}

export interface ExtensionInspectionPayload {
  format: "vofa-ultra-extension";
  schemaVersion: number;
  manifest: ExtensionManifest;
  packageSha256: string;
  moduleSha256: string;
  packageBytes: number;
  moduleBytes: number;
}

export interface ExtensionStatePayload {
  status: ExtensionStatus;
  sessionId: number;
  generation: number;
  revision: number;
  nextSequence: number;
  manifest?: ExtensionManifest;
  packageSha256?: string;
  moduleSha256?: string;
  authorizedCapabilities: string[];
  processedBytes: number;
  emittedFrames: number;
  faultCode?: string;
  message?: string;
}

export interface ExtensionFramePayload {
  values: number[];
  labels?: string[];
}

export interface ExtensionBatchPayload {
  sessionId: number;
  generation: number;
  sequence: number;
  receivedAt: number;
  acceptedBytes: number;
  frames: ExtensionFramePayload[];
}

export interface ExtensionQueueSnapshot {
  active: boolean;
  inFlight: boolean;
  queuedBatches: number;
  queuedBytes: number;
}
