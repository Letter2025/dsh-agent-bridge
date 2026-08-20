import { randomUUID } from "node:crypto";
import { DshWebError } from "./types";
import type {
  DshHistoryEntry,
  DshPromptResponse,
  DshSessionEvent,
  DshSessionHistory,
  DshWebClientLike,
} from "./types";

const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PROMPT_BYTES = 64 * 1024;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  const parsed = record(value);
  if (parsed === null) throw new DshWebError("web_protocol_error", message);
  return parsed;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string" || value === "") {
    throw new DshWebError("web_protocol_error", message);
  }
  return value;
}

function loopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "[::1]";
}

export function normalizeDshWebUrl(rawValue: string): string {
  let value: URL;
  try {
    value = new URL(rawValue);
  } catch {
    throw new DshWebError("invalid_input", "DSH Web URL must be an absolute HTTP URL.");
  }
  if (value.protocol !== "http:") {
    throw new DshWebError("invalid_input", "DSH Web URL must use http on a loopback host.");
  }
  if (!loopbackHost(value.hostname)) {
    throw new DshWebError(
      "invalid_input",
      "DSH Web URL must use 127.0.0.1, localhost, or ::1; remote Web profiles are not accepted.",
    );
  }
  if (value.username !== "" || value.password !== "" || value.search !== "" || value.hash !== "") {
    throw new DshWebError(
      "invalid_input",
      "DSH Web URL must not include credentials, query parameters, or a fragment.",
    );
  }
  if (value.pathname !== "/" && value.pathname !== "") {
    throw new DshWebError("invalid_input", "DSH Web URL must not include a path.");
  }
  value.pathname = "/";
  return value.toString().replace(/\/$/u, "");
}

export interface DshWebClientOptions {
  fetchApi?: typeof fetch;
  maxResponseBytes?: number;
  mintRpcId?: () => string;
}

export class DshWebClient implements DshWebClientLike {
  readonly baseUrl: string;
  private readonly fetchApi: typeof fetch;
  private readonly maxResponseBytes: number;
  private readonly mintRpcId: () => string;

  constructor(baseUrl: string, options: DshWebClientOptions = {}) {
    this.baseUrl = normalizeDshWebUrl(baseUrl);
    this.fetchApi = options.fetchApi ?? globalThis.fetch;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.mintRpcId = options.mintRpcId ?? randomUUID;
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0) {
      throw new DshWebError("invalid_input", "maxResponseBytes must be a positive integer.");
    }
  }

  private async call<T>(
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!/^[a-z][A-Za-z0-9]*(?:[./][A-Za-z][A-Za-z0-9]*)+$/u.test(method)) {
      throw new DshWebError("invalid_input", "Invalid DSH Web RPC method.");
    }
    const rpcId = `codex-bridge-${this.mintRpcId()}`;
    const body = JSON.stringify({ type: "client-request", rpcId, method, payload });
    let response: Response;
    try {
      const init: RequestInit = {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body,
        redirect: "error",
      };
      if (signal !== undefined) init.signal = signal;
      response = await this.fetchApi(`${this.baseUrl}/api/${method}`, init);
    } catch (error) {
      if (signal?.aborted) {
        throw new DshWebError("interrupted", "DSH Web request was interrupted.");
      }
      throw new DshWebError(
        "web_unavailable",
        `DSH Web is unavailable at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) {
      throw new DshWebError("output_limit", "DSH Web response exceeded the configured limit.");
    }
    const responseText = await response.text();
    if (Buffer.byteLength(responseText, "utf8") > this.maxResponseBytes) {
      throw new DshWebError("output_limit", "DSH Web response exceeded the configured limit.");
    }
    if (!response.ok) {
      throw new DshWebError(
        "web_http_error",
        `DSH Web returned HTTP ${response.status} for ${method}.`,
      );
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(responseText);
    } catch {
      throw new DshWebError("web_protocol_error", "DSH Web returned invalid JSON.");
    }
    const envelope = requireRecord(decoded, "DSH Web returned an invalid response envelope.");
    if (envelope.type !== "server-response" || envelope.rpcId !== rpcId) {
      throw new DshWebError(
        "web_protocol_error",
        "DSH Web response identity did not match the request.",
      );
    }
    const result = requireRecord(envelope.result, "DSH Web response omitted its result.");
    if (result.ok === true) return result.value as T;
    if (result.ok !== false) {
      throw new DshWebError("web_protocol_error", "DSH Web response has an invalid result status.");
    }
    const error = requireRecord(result.error, "DSH Web response omitted its error.");
    const code = typeof error.code === "string" ? error.code : "web_rpc_error";
    const message = typeof error.message === "string" ? error.message : "DSH Web RPC failed.";
    throw new DshWebError(code, message, record(error.details) ?? {});
  }

  async describe(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return requireRecord(
      await this.call<unknown>("host.describe", {}, signal),
      "DSH Web host.describe returned an invalid value.",
    );
  }

  async createSession(
    cwd: string,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<{ sessionId: string }> {
    const payload: Record<string, unknown> = { cwd };
    if (sessionId !== undefined) payload.sessionId = sessionId;
    const value = requireRecord(
      await this.call<unknown>("session.create", payload, signal),
      "DSH Web session.create returned an invalid value.",
    );
    return { sessionId: requireString(value.sessionId, "DSH Web omitted the created session id.") };
  }

  async history(
    sessionId: string,
    maxMessages = 8,
    signal?: AbortSignal,
  ): Promise<DshSessionHistory> {
    const value = requireRecord(
      await this.call<unknown>("session.history", { sessionId, maxMessages }, signal),
      "DSH Web session.history returned an invalid value.",
    );
    if (!Array.isArray(value.events) || typeof value.hasMore !== "boolean") {
      throw new DshWebError("web_protocol_error", "DSH Web history has an invalid shape.");
    }
    const events: DshHistoryEntry[] = value.events.map((rawEntry) => {
      const entry = requireRecord(rawEntry, "DSH Web history entry is invalid.");
      const rawEvent = requireRecord(entry.event, "DSH Web history event is invalid.");
      if (
        typeof rawEvent.type !== "string" ||
        !Number.isSafeInteger(rawEvent.seq) ||
        typeof rawEvent.time !== "number"
      ) {
        throw new DshWebError("web_protocol_error", "DSH Web history event has invalid fields.");
      }
      const event: DshSessionEvent = {
        type: rawEvent.type,
        seq: rawEvent.seq as number,
        time: rawEvent.time,
        data: rawEvent.data,
      };
      return entry.view === undefined ? { event } : { event, view: entry.view };
    });
    return { events, hasMore: value.hasMore };
  }

  async prompt(sessionId: string, text: string, signal?: AbortSignal): Promise<DshPromptResponse> {
    if (text.trim() === "" || Buffer.byteLength(text, "utf8") > MAX_PROMPT_BYTES) {
      throw new DshWebError(
        "invalid_input",
        "DSH Web prompt must be non-empty and at most 64 KiB.",
      );
    }
    const value = requireRecord(
      await this.call<unknown>(
        "session.prompt",
        { sessionId, mode: "queue", content: [{ type: "text", text }] },
        signal,
      ),
      "DSH Web session.prompt returned an invalid value.",
    );
    if (value.accepted !== true) {
      throw new DshWebError("web_protocol_error", "DSH Web did not accept the prompt.");
    }
    if (value.command === undefined) return { accepted: true };
    const command = requireRecord(value.command, "DSH Web command result is invalid.");
    if (command.kind !== "success") {
      throw new DshWebError("web_protocol_error", "DSH Web command did not return success.");
    }
    const result: DshPromptResponse = { accepted: true, command: { kind: "success" } };
    if (typeof command.text === "string") result.command = { kind: "success", text: command.text };
    return result;
  }

  async command(
    sessionId: string,
    line: string,
    signal?: AbortSignal,
  ): Promise<{ matched: boolean; text?: string }> {
    if (!line.startsWith("/") || line.includes("\0")) {
      throw new DshWebError("invalid_input", "DSH command must be one slash-command line.");
    }
    const rawValue = await this.call<unknown>(
      "commands/execute",
      { args: { agentId: sessionId, line, images: [] } },
      signal,
    );
    if (rawValue === undefined) return { matched: false };
    const value = requireRecord(rawValue, "DSH command endpoint returned an invalid value.");
    const result = requireRecord(value.result, "DSH command endpoint omitted its result.");
    if (result.kind === "error") {
      throw new DshWebError(
        "command_error",
        typeof result.text === "string" ? result.text : "DSH command failed.",
      );
    }
    if (result.kind !== "success") {
      throw new DshWebError(
        "web_protocol_error",
        "DSH command endpoint returned an invalid result.",
      );
    }
    return typeof result.text === "string"
      ? { matched: true, text: result.text }
      : { matched: true };
  }

  async cancel(sessionId: string, signal?: AbortSignal): Promise<void> {
    const value = requireRecord(
      await this.call<unknown>("session.cancel", { sessionId }, signal),
      "DSH Web session.cancel returned an invalid value.",
    );
    if (value.accepted !== true) {
      throw new DshWebError("web_protocol_error", "DSH Web did not accept cancellation.");
    }
  }
}
