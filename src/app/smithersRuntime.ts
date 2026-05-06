import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type SmithersWorkflowLike = {
  zodToKeyName?: Map<unknown, string>;
};

export type SmithersRuntime = {
  renderFrame: (workflow: never, ctx: unknown, options: { baseRootDir: string; workflowPath: string | null }) => unknown;
  runWorkflow: (workflow: never, options: Record<string, unknown>) => unknown;
  SmithersCtx: new (options: {
    runId: string;
    iteration: number;
    input: Record<string, unknown>;
    outputs: Record<string, unknown>;
    zodToKeyName?: Map<unknown, string>;
  }) => unknown;
  runPromise: (effect: unknown) => Promise<unknown>;
};

export async function loadWorkflow(workflowPath: string): Promise<SmithersWorkflowLike> {
  const moduleExports = await import(pathToFileURL(workflowPath).href);
  const workflow = moduleExports.default ?? moduleExports.workflow;
  if (!workflow) {
    throw new Error(`Workflow module must export a default workflow or named export "workflow": ${workflowPath}`);
  }
  if (!hasZodToKeyName(workflow)) {
    throw new Error(`Exported workflow is not a Smithers workflow: ${workflowPath}`);
  }
  return workflow;
}

export async function loadSmithersRuntime(workflowPath: string): Promise<SmithersRuntime> {
  const nodeModulesDir = findNearestNodeModulesWithPackage(dirname(workflowPath), [
    '@smithers-orchestrator',
    'engine',
  ]);
  if (!nodeModulesDir) {
    throw new Error(`Could not find @smithers-orchestrator/engine for workflow: ${workflowPath}`);
  }
  const [engine, driver, effect] = await Promise.all([
    import(pathToFileURL(join(nodeModulesDir, '@smithers-orchestrator', 'engine', 'src', 'index.js')).href),
    import(pathToFileURL(join(nodeModulesDir, '@smithers-orchestrator', 'driver', 'src', 'SmithersCtx.js')).href),
    import(pathToFileURL(join(nodeModulesDir, 'effect', 'dist', 'esm', 'index.js')).href),
  ]);
  return {
    renderFrame: engine.renderFrame,
    runWorkflow: engine.runWorkflow,
    SmithersCtx: driver.SmithersCtx,
    runPromise: effect.Effect.runPromise,
  };
}

function findNearestNodeModulesWithPackage(startDir: string, packageSegments: string[]) {
  let current = startDir;
  while (true) {
    const nodeModulesDir = join(current, 'node_modules');
    if (existsSync(join(nodeModulesDir, ...packageSegments))) return nodeModulesDir;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function hasZodToKeyName(value: unknown): value is SmithersWorkflowLike {
  return Boolean(value && typeof value === 'object' && 'zodToKeyName' in value);
}
