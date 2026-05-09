import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs, runCli } from "../src/cli.js";
import type { AgentLike } from "../src/app/runOutcome.js";

class FakeAgent implements AgentLike {
  calls: Array<{ prompt?: unknown }> = [];

  constructor(private readonly outputs: unknown[]) {}

  async generate(options: {
    prompt?: unknown;
    onStdout?: (text: string) => void;
  }) {
    this.calls.push({ prompt: options.prompt });
    const output = this.outputs.shift();
    const text = typeof output === "string" ? output : JSON.stringify(output);
    options.onStdout?.(text);
    return { text };
  }
}

function tempRunsDir() {
  return mkdtempSync(join(tmpdir(), "custom-harness-cli-runs-"));
}

describe("CLI compatibility", () => {
  it("parses help, missing goal, goal, and context flags", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs([]).goal).toBeNull();
    expect(parseArgs(["--goal", "do it", "--context", "extra"])).toEqual({
      goal: "do it",
      context: "extra",
      help: false,
      json: false,
    });
  });

  it("parses graph-workflow subcommand flags", () => {
    expect(
      parseArgs([
        "graph-workflow",
        "--workflow",
        "flows/review.tsx",
        "--input",
        '{"prompt":"Review current diff"}',
        "--run-id",
        "graph-1",
        "--runs-dir",
        "tmp-runs",
        "--goal",
        "Review current diff",
        "--context",
        "local",
      ])
    ).toEqual({
      command: "graph-workflow",
      workflow: "flows/review.tsx",
      input: '{"prompt":"Review current diff"}',
      runId: "graph-1",
      runsDir: "tmp-runs",
      goal: "Review current diff",
      context: "local",
      help: false,
      json: false,
    });
  });

  it("returns non-zero for missing --goal", async () => {
    expect(await runCli([])).toBe(1);
  });

  it("returns non-zero when graph-workflow is missing --workflow", async () => {
    expect(await runCli(["graph-workflow"])).toBe(1);
  });

  it("returns non-zero when graph-workflow --input is invalid JSON", async () => {
    expect(
      await runCli([
        "graph-workflow",
        "--workflow",
        "tests/fixtures/nativeSmithersWorkflow.tsx",
        "--input",
        "{bad",
      ])
    ).toBe(1);
  });

  it("runs graph-workflow through the index entrypoint", async () => {
    const runsDir = tempRunsDir();
    const proc = Bun.spawn(
      [
        "bun",
        "src/index.ts",
        "graph-workflow",
        "--workflow",
        "tests/fixtures/nativeSmithersWorkflow.tsx",
        "--input",
        '{"prompt":"Review current diff"}',
        "--run-id",
        "entry-graph-test",
        "--runs-dir",
        runsDir,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const planJson = JSON.parse(
      readFileSync(join(runsDir, "entry-graph-test", "plan.json"), "utf8")
    );
    expect(exitCode).toBe(0);
    // stdout is JSON when piped (agent-friendly mode)
    const out = JSON.parse(stdout);
    expect(out.ok).toBe(true);
    expect(out.runId).toBe("entry-graph-test");
    expect(out.status).toBe("succeeded");
    expect(out.planPath).toContain("plan.json");
    expect(stderr).toBe("");
    expect(planJson.graph.source.kind).toBe("smithers");
    expect(
      planJson.graph.nodes.map((node: { id: string }) => node.id)
    ).toContain("inspect-diff");
  });

  it("fails clearly through the index entrypoint when graph-workflow --workflow is missing", async () => {
    const proc = Bun.spawn(["bun", "src/index.ts", "graph-workflow"], {
      cwd: process.cwd(),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(1);
    // errors go to stdout as JSON in piped (agent) mode
    const out = JSON.parse(stdout);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("Missing");
  });

  it("fails clearly through the index entrypoint when graph-workflow --input is invalid JSON", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "src/index.ts",
        "graph-workflow",
        "--workflow",
        "tests/fixtures/nativeSmithersWorkflow.tsx",
        "--input",
        "{bad",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(1);
    const out = JSON.parse(stdout);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("Invalid --input JSON");
  });

  it("starts a run without live LLM calls when fake agents are injected", async () => {
    const runsDir = tempRunsDir();
    const planner = new FakeAgent([{ path: "harness", reason: "simple" }]);
    const executor = new FakeAgent([{ result: "cli fake output" }]);

    const exitCode = await runCli(
      ["--goal", "cli smoke", "--context", "from cli"],
      { planner, executorAgent: executor, runId: "cli-test", runsDir }
    );

    const runDir = join(runsDir, "cli-test");
    expect(exitCode).toBe(0);
    expect(existsSync(join(runDir, "run.json"))).toBe(true);
    expect(String(planner.calls[0]?.prompt)).toContain("from cli");
    expect(String(executor.calls[0]?.prompt)).toContain("from cli");
  });

  it("smoke-runs the index entrypoint without live LLM calls when fake env is provided", async () => {
    const runsDir = tempRunsDir();
    const proc = Bun.spawn(
      [
        "bun",
        "src/index.ts",
        "--goal",
        "entry smoke",
        "--context",
        "entry context",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CUSTOM_HARNESS_RUN_ID: "entry-smoke-test",
          CUSTOM_HARNESS_RUNS_DIR: runsDir,
          CUSTOM_HARNESS_FAKE_PLAN: JSON.stringify({
            path: "harness",
            reason: "env fake",
          }),
          CUSTOM_HARNESS_FAKE_EXECUTOR_OUTPUT: JSON.stringify({
            result: "entry output",
          }),
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    // stdout is JSON when piped (agent-friendly mode)
    const out = JSON.parse(stdout);
    expect(out.ok).toBe(true);
    expect(out.runId).toBe("entry-smoke-test");
    expect(stderr).toBe("");
    expect(
      readFileSync(join(runsDir, "entry-smoke-test", "run.json"), "utf8")
    ).toContain('"status": "succeeded"');
  });

  it("prints usage and exits non-zero through the index entrypoint when --goal is missing", async () => {
    const proc = Bun.spawn(["bun", "src/index.ts"], {
      cwd: process.cwd(),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(1);
    // stdout is JSON help in piped (agent) mode
    const out = JSON.parse(stdout);
    expect(out.commands).toBeDefined();
  });

  it("returns non-zero and records failed artifacts when execution fails", async () => {
    const runsDir = tempRunsDir();
    const planner = new FakeAgent([{ path: "harness", reason: "simple" }]);
    const executor: AgentLike = {
      async generate() {
        throw new Error("executor exploded");
      },
    };

    const exitCode = await runCli(["--goal", "fail please"], {
      planner,
      executorAgent: executor,
      runId: "cli-failure-test",
      runsDir,
    });

    const runDir = join(runsDir, "cli-failure-test");
    const runJson = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
    const events = readFileSync(join(runDir, "events.jsonl"), "utf8");

    expect(exitCode).toBe(1);
    expect(runJson.status).toBe("failed");
    expect(events).toContain('"type":"run.error"');
    expect(events).toContain("executor exploded");
  });
});
