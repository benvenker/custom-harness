import { runOutcome, type AgentLike, type OutcomeWorkflowRunner, type PlannerOutput } from './app/runOutcome.js';
import {
  renderWorkflowGraph,
  type RenderWorkflowGraphOptions,
  type RenderWorkflowGraphResult,
} from './app/renderWorkflowGraph.js';

export type CliDeps = {
  planner?: AgentLike | (() => PlannerOutput | Promise<PlannerOutput>);
  executorAgent?: AgentLike;
  workflowRunner?: OutcomeWorkflowRunner;
  renderWorkflowGraph?: (options: RenderWorkflowGraphOptions) => Promise<RenderWorkflowGraphResult>;
  runId?: string;
  runsDir?: string;
};

export function parseArgs(args: string[]) {
  const get = (flag: string) => {
    const index = args.indexOf(flag);
    return index !== -1 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : null;
  };
  if (args[0] === 'graph-workflow') {
    const graphArgs = args.slice(1);
    const getGraph = (flag: string) => {
      const index = graphArgs.indexOf(flag);
      return index !== -1 && graphArgs[index + 1] && !graphArgs[index + 1].startsWith('--') ? graphArgs[index + 1] : null;
    };
    return {
      command: 'graph-workflow' as const,
      workflow: getGraph('--workflow'),
      input: getGraph('--input'),
      runId: getGraph('--run-id'),
      runsDir: getGraph('--runs-dir'),
      goal: getGraph('--goal'),
      context: getGraph('--context'),
      help: graphArgs.includes('--help') || graphArgs.includes('-h'),
    };
  }

  return {
    goal: get('--goal'),
    context: get('--context'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

export function printHelp() {
  console.log(`
custom-harness — Smithers-first durable outcome runner

USAGE
  bun src/index.ts --goal "<goal>"
  bun src/index.ts graph-workflow --workflow <workflow.tsx> [--input '{"prompt":"Review current diff"}']

HOW IT WORKS
  1. A Smithers planner task decides: harness or workflow
  2. harness  → one Smithers CLI-agent task
  3. workflow → deterministic Smithers-style DAG tasks
  4. graph-workflow renders an authored Smithers workflow graph without executing tasks

OPTIONS
  --goal <text>          Goal to accomplish (required in planner mode)
  --context <text>       Additional context
  --help                 Show this help

GRAPH-WORKFLOW OPTIONS
  --workflow <path>      Smithers workflow module to render (required)
  --input <json>         Workflow input JSON object (default: {})
  --run-id <id>          Run id to write
  --runs-dir <dir>       Runs directory (default: runs)
  --goal <text>          Goal label for run.json and graph metadata
  --context <text>       Additional context metadata
`);
}

export async function runCli(args: string[], deps: CliDeps = {}) {
  const parsed = parseArgs(args);
  const envDeps = depsFromEnv();

  if ('command' in parsed && parsed.command === 'graph-workflow') {
    if (parsed.help) {
      printHelp();
      return 0;
    }
    if (!parsed.workflow) {
      console.error('Missing required --workflow for graph-workflow.');
      return 1;
    }

    let input: Record<string, unknown>;
    try {
      input = parseInputJson(parsed.input);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
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
      console.log(`Run ID: ${result.runId}`);
      console.log(`Status: ${result.status}`);
      console.log(`Plan: ${result.planPath}`);
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
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

  console.log(`\nGoal: ${goal}`);
  if (context) console.log(`Context: ${context}`);
  console.log('');

  const result = await runOutcome({
    goal,
    context: context ?? undefined,
    planner: deps.planner ?? envDeps.planner,
    executorAgent: deps.executorAgent ?? envDeps.executorAgent,
    workflowRunner: deps.workflowRunner,
    runId: deps.runId ?? envDeps.runId,
    runsDir: deps.runsDir ?? envDeps.runsDir,
  });

  console.log(`Run ID: ${result.runId}`);
  console.log(`Status: ${result.status}`);
  return result.status === 'succeeded' ? 0 : 1;
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
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid --input JSON: expected a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

export function depsFromEnv(): CliDeps {
  const fakePlan = process.env.CUSTOM_HARNESS_FAKE_PLAN;
  const fakeExecutorOutput = process.env.CUSTOM_HARNESS_FAKE_EXECUTOR_OUTPUT;
  return {
    planner: fakePlan ? () => JSON.parse(fakePlan) as PlannerOutput : undefined,
    executorAgent: fakeExecutorOutput ? new EnvFakeAgent(fakeExecutorOutput) : undefined,
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
