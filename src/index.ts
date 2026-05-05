function parseArgs(args: string[]) {
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1] : null;
  };
  return {
    goal: get('--goal'),
    context: get('--context'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

function printHelp() {
  console.log(`
custom-harness — meta-harness combining Flue + Smithers

USAGE
  bun src/index.ts --goal "<goal>"

HOW IT WORKS
  1. A Claude planner decides the execution path
  2. Simple goals  → Flue session.task()  (inner agent loop)
  3. Complex goals → Smithers workflow    (durable crash-resumable DAG)

OPTIONS
  --goal <text>      Goal to accomplish (required)
  --context <text>   Additional context for the goal
  --help             Show this help
`);
}

async function main() {
  const { goal, context, help } = parseArgs(process.argv.slice(2));

  if (help) {
    printHelp();
    process.exit(0);
  }
  if (!goal) {
    printHelp();
    process.exit(1);
  }

  console.log(`\nGoal: ${goal}`);
  if (context) console.log(`Context: ${context}`);
  console.log('');

  const payload = JSON.stringify({ goal, context: context ?? undefined });

  const proc = Bun.spawn(
    [
      'node_modules/.bin/flue',
      'run',
      'orchestrator',
      '--target',
      'node',
      '--id',
      crypto.randomUUID(),
      '--payload',
      payload,
    ],
    {
      stdout: 'inherit',
      stderr: 'inherit',
      env: { ...process.env },
    },
  );

  const exitCode = await proc.exited;
  process.exit(exitCode ?? 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
