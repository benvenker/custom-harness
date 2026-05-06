import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GraphSnapshot } from '@smithers-orchestrator/graph';
import { createRunRecorder } from '../runs/recorder.js';

const MODEL = 'smithers-render-frame';

export type RenderWorkflowGraphOptions = {
  workflowPath: string;
  input?: Record<string, unknown>;
  runId?: string;
  runsDir?: string;
  goal?: string;
  context?: string;
};

export type RenderWorkflowGraphResult = {
  runId: string;
  status: 'succeeded';
  runDir: string;
  planPath: string;
};

type SmithersWorkflowLike = {
  zodToKeyName?: Map<unknown, string>;
};

type SmithersRuntime = {
  renderFrame: (workflow: never, ctx: unknown, options: { baseRootDir: string; workflowPath: string }) => unknown;
  SmithersCtx: new (options: {
    runId: string;
    iteration: number;
    input: Record<string, unknown>;
    outputs: Record<string, unknown>;
    zodToKeyName?: Map<unknown, string>;
  }) => unknown;
  runPromise: (effect: unknown) => Promise<unknown>;
};

export async function renderWorkflowGraph(options: RenderWorkflowGraphOptions): Promise<RenderWorkflowGraphResult> {
  const runId = options.runId ?? crypto.randomUUID();
  const input = options.input ?? {};
  const workflowPath = resolve(process.cwd(), options.workflowPath);
  const goal = options.goal ?? inputPrompt(input) ?? `Render Smithers workflow ${workflowPath}`;
  const recorder = createRunRecorder(runId, { goal, model: MODEL }, { runsDir: options.runsDir });
  const startedAt = Date.now();

  recorder.event('run.started', {
    goal,
    mode: 'graph-workflow',
    workflowPath,
    ...(options.context === undefined ? {} : { context: options.context }),
  });
  recorder.appendCli(`graph-workflow render\nworkflow=${workflowPath}\nrunId=${runId}\n`);

  try {
    const workflow = await loadWorkflow(workflowPath);
    const runtime = await loadSmithersRuntime(workflowPath);
    const ctx = new runtime.SmithersCtx({
      runId,
      iteration: 0,
      input,
      outputs: {},
      zodToKeyName: workflow.zodToKeyName,
    });
    const frame = await runtime.runPromise(
      runtime.renderFrame(workflow as never, ctx, {
        baseRootDir: dirname(workflowPath),
        workflowPath,
      }),
    );

    recorder.writeSmithersPlanSnapshot(frame as GraphSnapshot, {
      reason: 'Rendered Smithers workflow graph without executing tasks.',
      workflowPath,
      input,
      ...(options.context === undefined ? {} : { context: options.context }),
      planningLatencyMs: Date.now() - startedAt,
      tokens: null,
    });
    recorder.event('run.done', { status: 'succeeded' });
    recorder.finish('succeeded', { latencyMs: Date.now() - startedAt });
    return {
      runId,
      status: 'succeeded',
      runDir: recorder.runDir,
      planPath: `${recorder.runDir}/plan.json`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recorder.event('run.error', { message, source: 'graph-workflow' });
    recorder.finish('failed', { latencyMs: Date.now() - startedAt });
    throw error;
  }
}

async function loadWorkflow(workflowPath: string): Promise<SmithersWorkflowLike> {
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

async function loadSmithersRuntime(workflowPath: string): Promise<SmithersRuntime> {
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

function inputPrompt(input: Record<string, unknown>) {
  return typeof input.prompt === 'string' && input.prompt.trim() ? input.prompt : null;
}
