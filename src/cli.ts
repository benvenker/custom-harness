import { runOutcome, type AgentLike, type OutcomeWorkflowRunner, type PlannerOutput } from './app/runOutcome.js';

export type CliDeps = {
  planner?: AgentLike | (() => PlannerOutput | Promise<PlannerOutput>);
  executorAgent?: AgentLike;
  workflowRunner?: OutcomeWorkflowRunner;
  runId?: string;
  runsDir?: string;
};

export function parseArgs(args: string[]) {
  const get = (flag: string) => {
    const index = args.indexOf(flag);
    return index !== -1 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : null;
  };
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

HOW IT WORKS
  1. A Smithers planner task decides: harness or workflow
  2. harness  → one Smithers CLI-agent task
  3. workflow → deterministic Smithers-style DAG tasks

OPTIONS
  --goal <text>      Goal to accomplish (required)
  --context <text>   Additional context
  --help             Show this help
`);
}

export async function runCli(args: string[], deps: CliDeps = {}) {
  const { goal, context, help } = parseArgs(args);
  const envDeps = depsFromEnv();

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
