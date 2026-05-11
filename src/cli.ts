export function printHelp() {
  console.log(`
custom-harness — local visual workbench for Smithers workflows

USAGE
  bun src/server.ts --project <project-root> --workflow <workflow-id>

WHAT THIS REPO DOES NOW
  - opens ordinary Smithers workflow-pack source from .smithers/workflows/*.tsx
  - renders workflow graphs through Smithers
  - edits source-backed fields declared with Task.meta.editor
  - starts runs through Smithers
  - inspects Smithers SQLite run/frame/event/output state

LEGACY NOTE
  The old goal-planner CLI and graph-workflow recorder have been removed.
  Use Smithers workflow source plus the local viewer instead.
`);
}

export async function runCli(args: string[] = []) {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return 0;
  }
  printHelp();
  return 1;
}
