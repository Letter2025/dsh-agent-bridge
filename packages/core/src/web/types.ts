export interface DshWebRpcErrorShape {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export class DshWebError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "DshWebError";
    this.code = code;
    this.details = details;
  }
}

export interface DshSessionEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
}

export interface DshHistoryEntry {
  event: DshSessionEvent;
  view?: unknown;
}

export interface DshSessionHistory {
  events: DshHistoryEntry[];
  hasMore: boolean;
}

export interface DshPromptResponse {
  accepted: true;
  command?: {
    kind: "success";
    text?: string;
  };
}

export interface DshWebClientLike {
  describe(signal?: AbortSignal): Promise<Record<string, unknown>>;
  createSession(
    cwd: string,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<{ sessionId: string }>;
  history(
    sessionId: string,
    maxMessages?: number,
    signal?: AbortSignal,
  ): Promise<DshSessionHistory>;
  prompt(sessionId: string, text: string, signal?: AbortSignal): Promise<DshPromptResponse>;
  command(
    sessionId: string,
    line: string,
    signal?: AbortSignal,
  ): Promise<{ matched: boolean; text?: string }>;
  cancel(sessionId: string, signal?: AbortSignal): Promise<void>;
}

export interface DshWebWorkflowState {
  version: 1;
  phase: "prepared" | "brought_back" | "removed";
  statePath: string;
  webUrl: string;
  repoRoot: string;
  hostCwd: string;
  worktreeDirName: string;
  worktreeName: string;
  worktreePath: string;
  workerCwd: string;
  branch: string;
  baseCommit: string;
  controllerSessionId: string;
  workerSessionId: string;
  promptCount: number;
  lastTurnSeq: number | null;
  createdAt: string;
}

export interface DshWebTurnResult {
  status: "succeeded" | "failed" | "timed_out";
  sessionId: string;
  baselineSeq: number;
  turnEndSeq: number | null;
  durationMs: number;
  text: string;
  reason: Record<string, unknown> | null;
  error?: { code: string; message: string };
}

export interface DshWebCommandResult {
  command: string;
  text: string;
}
