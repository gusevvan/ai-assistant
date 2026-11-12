export type CheckStatus = "ok" | "error" | "disabled";

export interface HealthCheck {
  readonly status: CheckStatus;
  readonly latencyMs?: number;
  readonly message?: string;
  readonly details?: unknown;
}

export interface HealthReport {
  readonly status: "ok" | "error";
  readonly ready: boolean;
  readonly service: "opencode-web-assistant";
  readonly version: string;
  readonly uptimeSeconds: number;
  readonly checks: Record<string, HealthCheck>;
}
