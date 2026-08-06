import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIMEOUT_MS,
  FIXED_SAFETY_POLICY,
  HARD_OUTPUT_LIMIT_BYTES,
  PROMPT_LIMIT_BYTES,
  buildQoderArgs,
  normalizeCwd,
  parseArgs,
  parseTimeout,
  redactSecrets,
  resolveConfig,
  resolveExecutable,
  runQoder,
} from "../skill/qoder-agent/scripts/run_qoder.mjs";

const runnerPath = fileURLToPath(
  new URL("../skill/qoder-agent/scripts/run_qoder.mjs", import.meta.url),
);

class FakeChild extends EventEmitter {
  pid = 4321;
  stdout = new PassThrough();
  stderr = new PassThrough();
}

function fakeConfig(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/tmp/qoder-fixture",
    prompt: "Make the requested bounded change.",
    executable: "/tmp/qodercli",
    model: undefined,
    timeoutMs: 1000,
    signal: undefined,
    ...overrides,
  };
}

function fakeFs(cwd = "/tmp/qoder-fixture", executablePaths: string[] = ["/tmp/qodercli"]) {
  const executableSet = new Set(executablePaths);
  return {
    stat: async (candidate: string) => {
      if (candidate === cwd) {
        return { isDirectory: () => true, isFile: () => false };
      }
      if (executableSet.has(candidate)) {
        return { isDirectory: () => false, isFile: () => true };
      }
      throw new Error("missing");
    },
    access: async () => undefined,
    realpath: async (candidate: string) => (candidate === cwd ? "/real/qoder-fixture" : candidate),
  };
}

describe("Runner input and command construction", () => {
  it("requires an absolute cwd and a bounded non-empty prompt", () => {
    expect(() => parseArgs(["--prompt", "task"])).toThrow(/--cwd is required/);
    expect(() => parseArgs(["--cwd", "relative", "--prompt", "task"])).not.toThrow();
    expect(
      parseArgs([
        "--cwd",
        "/tmp",
        "--prompt",
        "task",
        "--qodercli-path",
        "/tmp/qodercli",
        "--timeout-ms",
        "123",
      ]),
    ).toMatchObject({ qodercliPath: "/tmp/qodercli", timeoutMs: "123" });
    expect(() => parseArgs(["--cwd", "/tmp", "--prompt", " "])).toThrow(/--prompt/);
    expect(() =>
      parseArgs(["--cwd", "/tmp", "--prompt", "a".repeat(PROMPT_LIMIT_BYTES + 1)]),
    ).toThrow(/64 KiB/);
    expect(() => parseArgs(["--cwd", "/tmp", "--prompt", "task", "--unknown"])).toThrow(
      /Unsupported/,
    );
  });

  it("constructs a fixed safe Qoder argument array", () => {
    const args = buildQoderArgs({
      cwd: "/real/project",
      prompt: "task --with-dashes",
      model: "test-model",
    });

    expect(args).toEqual([
      "--print",
      "--cwd",
      "/real/project",
      "--permission-mode",
      "auto",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--model",
      "test-model",
      "--append-system-prompt",
      FIXED_SAFETY_POLICY,
      "--",
      "task --with-dashes",
    ]);
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--tools");
  });

  it("applies timeout defaults and bounds", () => {
    expect(parseTimeout(String(DEFAULT_TIMEOUT_MS))).toBe(DEFAULT_TIMEOUT_MS);
    expect(() => parseTimeout("0")).toThrow(/between/);
    expect(() => parseTimeout("1800001")).toThrow(/between/);
    expect(() => parseTimeout("not-a-number")).toThrow(/positive integer/);
  });
});

describe("Runner preflight and resolution", () => {
  it("normalizes an existing directory and rejects relative or file paths", async () => {
    const fsApi = fakeFs();
    await expect(normalizeCwd("/tmp/qoder-fixture", fsApi)).resolves.toBe("/real/qoder-fixture");
    await expect(normalizeCwd("relative", fsApi)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      normalizeCwd("/tmp/missing", {
        ...fsApi,
        stat: async () => ({ isDirectory: () => false, isFile: () => true }),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("uses CLI configuration before environment configuration and defaults", async () => {
    const fsApi = fakeFs("/tmp/qoder-fixture", ["/tmp/cli-qoder", "/tmp/env-qoder"]);
    const config = await resolveConfig(
      {
        cwd: "/tmp/qoder-fixture",
        prompt: "task",
        qodercliPath: "/tmp/cli-qoder",
        model: "cli-model",
        timeoutMs: "123",
      },
      {
        PATH: "/tmp",
        QODERCLI_PATH: "/tmp/env-qoder",
        QODER_MODEL: "env-model",
        QODER_TIMEOUT_MS: "456",
      },
      fsApi,
    );

    expect(config).toMatchObject({
      cwd: "/real/qoder-fixture",
      executable: "/tmp/cli-qoder",
      model: "cli-model",
      timeoutMs: 123,
    });
  });

  it("uses environment configuration before the built-in defaults", async () => {
    const fsApi = fakeFs("/tmp/qoder-fixture", ["/tmp/env-qoder"]);
    const config = await resolveConfig(
      {
        cwd: "/tmp/qoder-fixture",
        prompt: "task",
        qodercliPath: undefined,
        model: undefined,
        timeoutMs: undefined,
      },
      {
        PATH: "/empty",
        QODERCLI_PATH: "/tmp/env-qoder",
        QODER_MODEL: "env-model",
        QODER_TIMEOUT_MS: "456",
      },
      fsApi,
    );

    expect(config).toMatchObject({
      executable: "/tmp/env-qoder",
      model: "env-model",
      timeoutMs: 456,
    });
  });

  it("resolves qodercli from PATH without assuming a developer home directory", async () => {
    await expect(
      resolveExecutable(
        undefined,
        { PATH: "/opt/qoder/bin" },
        fakeFs("/tmp/qoder-fixture", ["/opt/qoder/bin/qodercli"]),
      ),
    ).resolves.toBe("/opt/qoder/bin/qodercli");

    await expect(resolveExecutable(undefined, { PATH: "/empty" }, fakeFs())).rejects.toMatchObject({
      code: "executable_not_found",
      message: expect.stringContaining("QODERCLI_PATH"),
    });
  });

  it("does not fall back when an explicit executable path is invalid", async () => {
    await expect(
      resolveExecutable(
        "/tmp/invalid-qoder",
        { PATH: "/tmp" },
        fakeFs("/tmp/qoder-fixture", ["/tmp/qodercli"]),
      ),
    ).rejects.toMatchObject({ code: "executable_not_found" });
  });
});

describe("Runner process boundary and envelope", () => {
  it("returns a successful bounded envelope without parsing Qoder JSON", async () => {
    const child = new FakeChild();
    const calls: Array<{ executable: string; args: string[]; options: Record<string, unknown> }> =
      [];
    const resultPromise = runQoder(fakeConfig(), {
      spawnProcess: (executable: string, args: string[], options: Record<string, unknown>) => {
        calls.push({ executable, args, options });
        return child;
      },
    });

    child.stdout.emit("data", Buffer.from('{"result":"ok"}'));
    child.stderr.emit("data", Buffer.from("diagnostic"));
    child.emit("close", 0, null);
    const result = await resultPromise;

    expect(result.exitCode).toBe(0);
    expect(result.envelope).toMatchObject({
      protocolVersion: 1,
      status: "succeeded",
      permissionMode: "auto",
      outputFormat: "json",
      exitCode: 0,
      stdout: '{"result":"ok"}',
      qoderOutput: { format: "json", raw: '{"result":"ok"}' },
    });
    expect(calls[0]?.options).toMatchObject({
      cwd: "/tmp/qoder-fixture",
      shell: false,
      detached: true,
    });
  });

  it("returns a non-zero Qoder exit as a failed envelope", async () => {
    const child = new FakeChild();
    const resultPromise = runQoder(fakeConfig(), { spawnProcess: () => child });
    child.emit("close", 7, null);
    const result = await resultPromise;

    expect(result.exitCode).toBe(1);
    expect(result.envelope).toMatchObject({
      status: "failed",
      exitCode: 7,
      error: { code: "qoder_exit_nonzero" },
    });
  });

  it("maps a missing child executable to spawn_error", async () => {
    const child = new FakeChild();
    const resultPromise = runQoder(fakeConfig(), { spawnProcess: () => child });
    const error = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    child.emit("error", error);
    const result = await resultPromise;

    expect(result.exitCode).toBe(1);
    expect(result.envelope).toMatchObject({
      status: "spawn_error",
      error: { code: "executable_not_found" },
    });
  });

  it("terminates the process group on timeout and escalates after the grace period", async () => {
    const child = new FakeChild();
    const kills: Array<[number, NodeJS.Signals]> = [];
    const resultPromise = runQoder(fakeConfig({ timeoutMs: 5 }), {
      spawnProcess: () => child,
      killProcess: (pid: number, signal: NodeJS.Signals) => {
        kills.push([pid, signal]);
        if (signal === "SIGKILL") {
          child.emit("close", null, "SIGKILL");
        }
      },
      terminationGraceMs: 1,
    });
    const result = await resultPromise;

    expect(kills).toEqual([
      [-4321, "SIGTERM"],
      [-4321, "SIGKILL"],
    ]);
    expect(result.envelope).toMatchObject({
      status: "timed_out",
      timedOut: true,
      error: { code: "timed_out" },
    });
  });

  it("terminates the process group when interrupted", async () => {
    const child = new FakeChild();
    const controller = new AbortController();
    const kills: Array<[number, NodeJS.Signals]> = [];
    const resultPromise = runQoder(fakeConfig({ signal: controller.signal }), {
      spawnProcess: () => child,
      killProcess: (pid: number, signal: NodeJS.Signals) => {
        kills.push([pid, signal]);
        child.emit("close", null, "SIGTERM");
      },
    });
    controller.abort("SIGINT");
    const result = await resultPromise;

    expect(kills).toEqual([[-4321, "SIGTERM"]]);
    expect(result.envelope).toMatchObject({ status: "failed", error: { code: "interrupted" } });
  });

  it("truncates output, enforces the hard limit, and redacts credentials", async () => {
    const child = new FakeChild();
    const resultPromise = runQoder(fakeConfig({ prompt: "private task" }), {
      spawnProcess: () => child,
      killProcess: () => undefined,
      captureLimitBytes: 8,
      hardOutputLimitBytes: 32,
    });
    child.stdout.emit("data", Buffer.from("1234567890"));
    child.stdout.emit("data", Buffer.from("Bearer abcdefghijk token=secret-value private task"));
    child.emit("close", 0, null);
    const result = await resultPromise;

    expect(result.envelope.stdoutTruncated).toBe(true);
    expect(result.envelope.stdout).toContain("output truncated");
    expect(result.envelope.stdout).not.toContain("private task");
    expect(redactSecrets("Authorization: Bearer abcdefghijk api_key=secret-value")).toContain(
      "[REDACTED]",
    );

    const limitedChild = new FakeChild();
    const kills: Array<[number, NodeJS.Signals]> = [];
    const limitedPromise = runQoder(fakeConfig(), {
      spawnProcess: () => limitedChild,
      killProcess: (pid: number, signal: NodeJS.Signals) => {
        kills.push([pid, signal]);
        limitedChild.emit("close", null, "SIGTERM");
      },
      captureLimitBytes: 8,
      hardOutputLimitBytes: HARD_OUTPUT_LIMIT_BYTES,
    });
    limitedChild.stdout.emit("data", Buffer.alloc(HARD_OUTPUT_LIMIT_BYTES + 1, "x"));
    const limitedResult = await limitedPromise;

    expect(kills).toEqual([[-4321, "SIGTERM"]]);
    expect(limitedResult.envelope).toMatchObject({
      status: "failed",
      error: { code: "output_limit" },
    });
  });
});

describe("direct execution behavior", () => {
  it("does not start a child process when imported", () => {
    const importScript = `await import(${JSON.stringify(pathToFileURL(runnerPath).href)});`;
    const imported = spawnSync(process.execPath, ["--input-type=module", "-e", importScript], {
      encoding: "utf8",
    });

    expect(imported.status).toBe(0);
    expect(imported.stdout).toBe("");
    expect(imported.stderr).toBe("");
  });

  it("emits one envelope for invalid direct input without starting Qoder", () => {
    const executed = spawnSync(process.execPath, [runnerPath], { encoding: "utf8" });
    const lines = executed.stdout.trim().split("\n");
    const envelope = JSON.parse(lines[0] ?? "{}");

    expect(executed.status).not.toBe(0);
    expect(lines).toHaveLength(1);
    expect(envelope).toMatchObject({ status: "failed", error: { code: "invalid_input" } });
  });
});
