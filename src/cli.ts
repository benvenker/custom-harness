import {
  runOutcome,
  type AgentLike,
  type OutcomeWorkflowRunner,
  type PlannerOutput,
} from "./app/runOutcome.js";
import { createDefaultAgent } from "./workflows/outcomeWorkflow.js";
import {
  renderWorkflowGraph,
  type RenderWorkflowGraphOptions,
  type RenderWorkflowGraphResult,
} from "./app/renderWorkflowGraph.js";
import { designWorkflow } from "./app/designWorkflow.js";
import { saveDraft, listDrafts, getDraft } from "./drafts.js";
import { createMcpServer } from "./mcp-server.js";

export type CliDeps = {
  planner?: AgentLike | (() => PlannerOutput | Promise<PlannerOutput>);
  executorAgent?: AgentLike;
  workflowRunner?: OutcomeWorkflowRunner;
  renderWorkflowGraph?: (
    options: RenderWorkflowGraphOptions
  ) => Promise<RenderWorkflowGraphResult>;
  designerAgent?: AgentLike;
  runId?: string;
  runsDir?: string;
};

// TTY detection: pretty output for humans, JSON for piped/agent contexts
function isAgentContext(): boolean {
  return !process.stdout.isTTY;
}

function emitJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

function emitError(args: {
  error: string;
  code: string;
  suggestion?: string;
  input?: unknown;
}): void {
  if (isAgentContext()) {
    emitJson({ ok: false, ...args });
  } else {
    console.error(`Error [${args.code}]: ${args.error}`);
    if (args.suggestion) console.error(`Suggestion: ${args.suggestion}`);
  }
}

export function parseArgs(args: string[]) {
  const get = (flag: string) => {
    const index = args.indexOf(flag);
    return index !== -1 && args[index + 1] && !args[index + 1].startsWith("--")
      ? args[index + 1]
      : null;
  };

  if (args[0] === "graph-workflow") {
    const graphArgs = args.slice(1);
    const getGraph = (flag: string) => {
      const index = graphArgs.indexOf(flag);
      return index !== -1 &&
        graphArgs[index + 1] &&
        !graphArgs[index + 1].startsWith("--")
        ? graphArgs[index + 1]
        : null;
    };
    return {
      command: "graph-workflow" as const,
      workflow: getGraph("--workflow"),
      input: getGraph("--input"),
      runId: getGraph("--run-id"),
      runsDir: getGraph("--runs-dir"),
      goal: getGraph("--goal"),
      context: getGraph("--context"),
      help: graphArgs.includes("--help") || graphArgs.includes("-h"),
      json: graphArgs.includes("--json"),
    };
  }

  if (args[0] === "design-workflow") {
    const subArgs = args.slice(1);
    const getSub = (flag: string) => {
      const index = subArgs.indexOf(flag);
      return index !== -1 &&
        subArgs[index + 1] &&
        !subArgs[index + 1].startsWith("--")
        ? subArgs[index + 1]
        : null;
    };
    return {
      command: "design-workflow" as const,
      goal: getSub("--goal"),
      context: getSub("--context"),
      name: getSub("--name"),
      runsDir: getSub("--runs-dir"),
      serverUrl: getSub("--server-url"),
      help: subArgs.includes("--help") || subArgs.includes("-h"),
      json: subArgs.includes("--json"),
    };
  }

  if (args[0] === "list-drafts") {
    const subArgs = args.slice(1);
    const getSub = (flag: string) => {
      const index = subArgs.indexOf(flag);
      return index !== -1 &&
        subArgs[index + 1] &&
        !subArgs[index + 1].startsWith("--")
        ? subArgs[index + 1]
        : null;
    };
    return {
      command: "list-drafts" as const,
      runsDir: getSub("--runs-dir"),
      help: subArgs.includes("--help") || subArgs.includes("-h"),
      json: subArgs.includes("--json"),
    };
  }

  if (args[0] === "get-draft") {
    const subArgs = args.slice(1);
    const getSub = (flag: string) => {
      const index = subArgs.indexOf(flag);
      return index !== -1 &&
        subArgs[index + 1] &&
        !subArgs[index + 1].startsWith("--")
        ? subArgs[index + 1]
        : null;
    };
    return {
      command: "get-draft" as const,
      id: subArgs.find((a) => !a.startsWith("--")) ?? getSub("--id"),
      runsDir: getSub("--runs-dir"),
      help: subArgs.includes("--help") || subArgs.includes("-h"),
      json: subArgs.includes("--json"),
    };
  }

  if (args[0] === "serve") {
    return {
      command: "serve" as const,
      help: args.includes("--help") || args.includes("-h"),
    };
  }

  if (args[0] === "robot-docs") {
    return { command: "robot-docs" as const };
  }

  return {
    goal: get("--goal"),
    context: get("--context"),
    help: args.includes("--help") || args.includes("-h"),
    json: args.includes("--json"),
  };
}

export function printHelp() {
  // ~100 tokens — quick-start mode for token-constrained agent contexts
  if (isAgentContext()) {
    emitJson({
      commands: [
        "--goal <text>",
        "design-workflow --goal <text> [--json]",
        "list-drafts [--json]",
        "get-draft <id> [--json]",
        "serve",
        "robot-docs",
        "graph-workflow --workflow <path>",
      ],
      flags: [
        "--context <text>",
        "--name <text>",
        "--runs-dir <dir>",
        "--server-url <url>",
        "--json",
        "--help",
      ],
    });
    return;
  }

  console.log(`
custom-harness — Smithers-first durable outcome runner

COMMANDS
  --goal <text>              Run goal through planner and execute (harness or workflow)
  design-workflow            Generate a Smithers workflow from natural language (no execution)
  list-drafts                List saved workflow drafts
  get-draft <id>             Show a workflow draft
  serve                      Start MCP stdio server (for Claude Desktop / Claude Code integration)
  robot-docs                 Machine-readable docs for agent contexts
  graph-workflow             Render authored workflow graph without executing

DESIGN-WORKFLOW OPTIONS
  --goal <text>              Describe the workflow you want (required)
  --context <text>           Additional context or constraints
  --name <text>              Override the generated workflow name
  --runs-dir <dir>           Directory for drafts (default: runs)
  --server-url <url>         Base URL for the UI (default: http://localhost:3000)
  --json                     Output machine-readable JSON

GLOBAL OPTIONS
  --help                     Show this help
  --json                     Machine-readable output (auto-detected when stdout is not a TTY)

EXAMPLES
  bun src/index.ts design-workflow --goal "Audit a repo for security issues, then write a fix plan"
  bun src/index.ts list-drafts --json
  bun src/index.ts get-draft security-audit-fix-plan
  bun src/index.ts serve   # Start MCP server for Claude Desktop integration
`);
}

export async function runCli(args: string[], deps: CliDeps = {}) {
  const parsed = parseArgs(args);
  const envDeps = depsFromEnv();

  if ("command" in parsed && parsed.command === "graph-workflow") {
    if (parsed.help) {
      printHelp();
      return 0;
    }
    if (!parsed.workflow) {
      emitError({
        error: "Missing --workflow",
        code: "MISSING_WORKFLOW",
        suggestion: "run --help for usage",
      });
      return 1;
    }

    let input: Record<string, unknown>;
    try {
      input = parseInputJson(parsed.input);
    } catch (error) {
      emitError({
        error: error instanceof Error ? error.message : String(error),
        code: "INVALID_INPUT",
      });
      return 1;
    }

    try {
      const result = await (deps.renderWorkflowGraph ?? renderWorkflowGraph)({
        workflowPath: parsed.workflow,
        input,
        runId: parsed.runId ?? deps.runId ?? envDeps.runId,
        runsDir: parsed.runsDir ?? deps.runsDir ?? envDeps.runsDir,
        goal: parsed.goal ?? undefined,
        context: parsed.context ?? undefined,
      });
      if (parsed.json || isAgentContext()) {
        emitJson({
          ok: true,
          runId: result.runId,
          status: result.status,
          planPath: result.planPath,
        });
      } else {
        console.log(`Run ID: ${result.runId}`);
        console.log(`Status: ${result.status}`);
        console.log(`Plan: ${result.planPath}`);
      }
      return 0;
    } catch (error) {
      emitError({
        error: error instanceof Error ? error.message : String(error),
        code: "GRAPH_ERROR",
      });
      return 1;
    }
  }

  if ("command" in parsed && parsed.command === "design-workflow") {
    if (parsed.help) {
      printHelp();
      return 0;
    }
    if (!parsed.goal) {
      emitError({
        error: "Missing --goal",
        code: "MISSING_GOAL",
        input: { goal: null },
        suggestion:
          'Describe what the workflow should accomplish: --goal "audit repo security and write fix plan"',
      });
      return 1;
    }

    const runsDir = parsed.runsDir ?? deps.runsDir ?? envDeps.runsDir ?? "runs";
    const serverUrl =
      parsed.serverUrl ??
      process.env.CUSTOM_HARNESS_SERVER_URL ??
      "http://localhost:3000";
    const agent =
      deps.designerAgent ??
      deps.planner ??
      envDeps.planner ??
      createDefaultAgent();
    const planner =
      typeof agent === "function"
        ? { generate: async () => ({ text: JSON.stringify(await agent()) }) }
        : agent;

    if (!isAgentContext() && !parsed.json) {
      console.error(`Designing workflow for: ${parsed.goal}`);
    }

    try {
      const draft = await designWorkflow({
        goal: parsed.goal,
        context: parsed.context ?? undefined,
        planner,
      });

      const finalDraft = {
        ...draft,
        id: slugifyName(parsed.name) || draft.id,
        name: parsed.name || draft.name,
        goal: parsed.goal,
        context: parsed.context ?? undefined,
      };

      saveDraft(runsDir, finalDraft);

      const uiUrl = `${serverUrl}/drafts/${finalDraft.id}`;
      const taskCount = countTasks(finalDraft.root);

      if (parsed.json || isAgentContext()) {
        emitJson({
          ok: true,
          draftId: finalDraft.id,
          name: finalDraft.name,
          description: finalDraft.description,
          taskCount,
          url: uiUrl,
          runsDir,
        });
      } else {
        console.log(`\nWorkflow: ${finalDraft.name}`);
        console.log(`Description: ${finalDraft.description}`);
        console.log(`Tasks: ${taskCount}`);
        console.log(`Draft ID: ${finalDraft.id}`);
        console.log(`\nInspect in UI: ${uiUrl}`);
        console.log(
          `\nOr view in terminal:\n  bun src/index.ts get-draft ${finalDraft.id}`
        );
      }
      return 0;
    } catch (error) {
      emitError({
        error: error instanceof Error ? error.message : String(error),
        code: "DESIGN_ERROR",
        input: { goal: parsed.goal },
        suggestion: "Check that the planner agent is configured and reachable.",
      });
      return 1;
    }
  }

  if ("command" in parsed && parsed.command === "list-drafts") {
    if (parsed.help) {
      printHelp();
      return 0;
    }
    const runsDir = parsed.runsDir ?? deps.runsDir ?? envDeps.runsDir ?? "runs";
    const drafts = listDrafts(runsDir);

    if (parsed.json || isAgentContext()) {
      emitJson({ ok: true, drafts });
    } else {
      if (drafts.length === 0) {
        console.log("No workflow drafts yet.");
        console.log(
          'Create one: bun src/index.ts design-workflow --goal "..."'
        );
      } else {
        console.log(`Workflow drafts (${drafts.length}):\n`);
        for (const d of drafts) {
          console.log(`  ${d.id}`);
          console.log(`    ${d.description}`);
          console.log(`    Created: ${d.createdAt}`);
          console.log("");
        }
      }
    }
    return 0;
  }

  if ("command" in parsed && parsed.command === "get-draft") {
    if (parsed.help) {
      printHelp();
      return 0;
    }
    if (!parsed.id) {
      emitError({
        error: "Missing draft ID",
        code: "MISSING_ID",
        suggestion:
          'Run "list-drafts" to see available draft IDs, then: get-draft <id>',
      });
      return 1;
    }
    const runsDir = parsed.runsDir ?? deps.runsDir ?? envDeps.runsDir ?? "runs";
    const draft = getDraft(runsDir, parsed.id);

    if (!draft) {
      emitError({
        error: `Draft not found: ${parsed.id}`,
        code: "DRAFT_NOT_FOUND",
        input: { id: parsed.id },
        suggestion: 'Run "list-drafts" to see available draft IDs.',
      });
      return 1;
    }

    if (parsed.json || isAgentContext()) {
      emitJson({ ok: true, draft });
    } else {
      console.log(`\nWorkflow: ${draft.name}`);
      console.log(`ID: ${draft.id}`);
      console.log(`Description: ${draft.description}`);
      console.log(`Goal: ${draft.goal}`);
      console.log(`Tasks: ${countTasks(draft.root)}`);
      console.log(`Created: ${draft.createdAt}`);
      console.log("\nWorkflow tree:");
      printWorkflowTree(draft.root, "  ");
    }
    return 0;
  }

  if ("command" in parsed && parsed.command === "serve") {
    if (parsed.help) {
      printHelp();
      return 0;
    }
    // Start MCP stdio server — per Jeffrey Emanuel's `br serve` pattern
    const { StdioServerTransport } =
      await import("@modelcontextprotocol/sdk/server/stdio.js");
    const mcpServer = createMcpServer();
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    // Runs until stdin closes
    return 0;
  }

  if ("command" in parsed && parsed.command === "robot-docs") {
    // Machine-readable docs ~100 tokens for token-constrained agent contexts
    emitJson({
      name: "custom-harness",
      version: "0.1.0",
      commands: {
        "design-workflow": {
          flags: [
            "--goal (required)",
            "--context",
            "--name",
            "--runs-dir",
            "--server-url",
            "--json",
          ],
          returns: "{ ok, draftId, name, description, taskCount, url }",
        },
        "list-drafts": {
          flags: ["--runs-dir", "--json"],
          returns: "{ ok, drafts[] }",
        },
        "get-draft": {
          args: ["<id>"],
          flags: ["--runs-dir", "--json"],
          returns: "{ ok, draft }",
        },
        serve: {
          description: "Start MCP stdio server",
          tools: [
            "design_workflow",
            "list_workflow_drafts",
            "get_workflow_draft",
            "update_workflow_draft",
            "robot_docs",
          ],
        },
        "--goal": {
          flags: ["--context", "--runs-dir", "--json"],
          returns: "{ ok, runId, status }",
        },
        "graph-workflow": {
          flags: ["--workflow (required)", "--input", "--run-id", "--runs-dir"],
        },
      },
      errorShape:
        "{ ok: false, error: string, code: string, suggestion?: string, input?: unknown }",
      exitCodes: {
        0: "success",
        1: "error or missing args",
        2: "design/planner failure",
        3: "draft not found",
      },
    });
    return 0;
  }

  const { goal, context, help } = parsed;

  if (help) {
    printHelp();
    return 0;
  }

  if (!goal) {
    printHelp();
    return 1;
  }

  if (!isAgentContext()) {
    console.log(`\nGoal: ${goal}`);
    if (context) console.log(`Context: ${context}`);
    console.log("");
  }

  const result = await runOutcome({
    goal,
    context: context ?? undefined,
    planner: deps.planner ?? envDeps.planner,
    executorAgent: deps.executorAgent ?? envDeps.executorAgent,
    workflowRunner: deps.workflowRunner,
    runId: deps.runId ?? envDeps.runId,
    runsDir: deps.runsDir ?? envDeps.runsDir,
  });

  if (parsed.json || isAgentContext()) {
    emitJson({
      ok: result.status === "succeeded",
      runId: result.runId,
      status: result.status,
    });
  } else {
    console.log(`Run ID: ${result.runId}`);
    console.log(`Status: ${result.status}`);
  }
  return result.status === "succeeded" ? 0 : 1;
}

function parseInputJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid --input JSON: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid --input JSON: expected a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function slugifyName(name?: string | null): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function countTasks(node: unknown): number {
  if (!node || typeof node !== "object") return 0;
  const n = node as Record<string, unknown>;
  if (n.type === "task") return 1;
  if (Array.isArray(n.children))
    return (n.children as unknown[]).reduce(
      (sum: number, c) => sum + countTasks(c),
      0
    );
  if (n.body) return countTasks(n.body);
  return 0;
}

function printWorkflowTree(node: unknown, indent: string): void {
  if (!node || typeof node !== "object") return;
  const n = node as Record<string, unknown>;
  if (n.type === "task") {
    const prompt =
      typeof n.prompt === "string"
        ? n.prompt.slice(0, 80).replace(/\n/g, " ")
        : "";
    console.log(
      `${indent}[task] ${n.name}${prompt ? `: ${prompt}${n.prompt && (n.prompt as string).length > 80 ? "…" : ""}` : ""}`
    );
  } else if (n.type === "sequence" || n.type === "parallel") {
    console.log(`${indent}[${n.type}]${n.name ? ` ${n.name}` : ""}`);
    if (Array.isArray(n.children)) {
      for (const child of n.children) printWorkflowTree(child, indent + "  ");
    }
  }
}

export function depsFromEnv(): CliDeps {
  const fakePlan = process.env.CUSTOM_HARNESS_FAKE_PLAN;
  const fakeExecutorOutput = process.env.CUSTOM_HARNESS_FAKE_EXECUTOR_OUTPUT;
  return {
    planner: fakePlan ? () => JSON.parse(fakePlan) as PlannerOutput : undefined,
    executorAgent: fakeExecutorOutput
      ? new EnvFakeAgent(fakeExecutorOutput)
      : undefined,
    runId: process.env.CUSTOM_HARNESS_RUN_ID,
    runsDir: process.env.CUSTOM_HARNESS_RUNS_DIR,
  };
}

class EnvFakeAgent implements AgentLike {
  constructor(private readonly outputJson: string) {}

  async generate(options?: { onStdout?: (text: string) => void }) {
    options?.onStdout?.(this.outputJson);
    return { text: this.outputJson };
  }
}
