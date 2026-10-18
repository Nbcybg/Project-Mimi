import type { RiskLevel } from './tools.ts';

export interface PermissionRequest {
  id: string;
  traceId: string;
  agent: string;
  tool: string;
  risk: RiskLevel;
  input: unknown;
  /** One-line human readable description of what the tool call will do. */
  summary: string;
  timeoutMs: number;
}

export type PermissionDecision =
  | { allow: true; via: 'auto' | 'user' }
  | { allow: false; reason: 'denied' | 'timeout' | 'error' };
