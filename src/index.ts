import { planExecution } from './router/planner.js';
import { runHarness } from './harness/agent.js';
import { runWorkflow } from './workflow/executor.js';
import type { Goal } from './types.js';

function parseArgs(args: string[]): {
  goal: string | null;
  context: string | null;
  forcePath: 'harness' | 'workflow' | null;
  help: boolean;
} {
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1] : null;
  };
  return {
    goal: get('--goal'),
    context: get('--context'),
    forcePath: get('--path') as 'harness' | 'workflow' | null,
    help: args.includes('--help') || args.includes('-h'),
  };
}

function printHelp() {
  console.log(`
custom-harness — agent that decides how to execute your goals

USAGE
  bun src/index.ts --goal "<goal>"

OPTIONS
  --goal <text>            Goal for the agent to accomplish (required)
  --context <text>         Additional context
  --path harness|workflow  Skip planning; force an execution path
  --help                   Show this message

EXAMPLES
  bun src/index.ts --goal "list all TypeScript files in this project"
  bun src/index.ts --goal "analyze this codebase and write a SUMMARY.md" --path workflow
  bun src/index.ts --goal "fix the bug in src/foo.ts" --context "the test in test/foo.test.ts is failing"
`);
}

async function main() {
  const { goal, context, forcePath, help } = parseArgs(process.argv.slice(2));

  if (help) {
    printHelp();
    process.exit(0);
  }
  if (!goal) {
    printHelp();
    process.exit(1);
  }

  const goalObj: Goal = { description: goal, context: context ?? undefined };

  console.log(`\nGoal: ${goal}`);
  if (context) console.log(`Context: ${context}`);
  console.log('');

  let path: 'harness' | 'workflow';
  let workflow = null;

  if (forcePath) {
    path = forcePath;
    console.log(`Execution path: ${path} (forced)\n`);
    if (path === 'workflow') {
      console.log('Generating workflow plan...');
      const plan = await planExecution(goalObj);
      if (plan.path !== 'workflow') {
        console.log('Planner suggested harness — generating workflow anyway...');
        const retried = await planExecution({
          ...goalObj,
          description: `[WORKFLOW REQUIRED] ${goalObj.description}`,
        });
        if (retried.path === 'workflow') workflow = retried.workflow;
      } else {
        workflow = plan.workflow;
      }
      console.log('');
    }
  } else {
    console.log('Planning execution path...');
    const plan = await planExecution(goalObj);
    path = plan.path;
    console.log(`Execution path: ${path}`);
    console.log(`Reason: ${plan.reason}\n`);
    if (plan.path === 'workflow') workflow = plan.workflow;
  }

  let result;

  if (path === 'harness') {
    console.log('--- Harness Mode ---');
    result = await runHarness(goalObj);
  } else if (workflow) {
    console.log(`--- Workflow Mode: ${workflow.name} ---`);
    console.log(`${workflow.description}\n`);
    result = await runWorkflow(workflow, goal);
  } else {
    console.log('Could not generate workflow — falling back to harness.');
    result = await runHarness(goalObj);
  }

  console.log('\n--- Result ---');
  console.log(result.output);

  if (!result.success) {
    if (result.error) console.error(`\nError: ${result.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
