import type { DisplayMode, LineEnding } from "./serial";

export interface AutoResponderRule {
  id: string;
  name: string;
  enabled: boolean;
  triggerMode: DisplayMode;
  trigger: string;
  responseMode: DisplayMode;
  response: string;
  lineEnding: LineEnding;
  cooldownMs: number;
}

export type AutoResponderStatus =
  | "off"
  | "armed"
  | "sending"
  | "stopping"
  | "stopped"
  | "error";

export interface AutoResponderSnapshot {
  status: AutoResponderStatus;
  sessionId: number;
  enabledRuleCount: number;
  matchCount: number;
  acceptedCount: number;
  queuedCount: number;
  sentCount: number;
  cooldownDropCount: number;
  message: string;
  startedAt?: number;
  finishedAt?: number;
  lastRuleId?: string;
  lastRuleName?: string;
  lastError?: string;
}
