import { dirname, resolve } from 'node:path';
import type { GraphSnapshot } from '@smithers-orchestrator/graph';
import { createRunRecorder } from '../runs/recorder.js';
import { loadSmithersRuntime, loadWorkflow } from './smithersRuntime.js';

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

function inputPrompt(input: Record<string, unknown>) {
  return typeof input.prompt === 'string' && input.prompt.trim() ? input.prompt : null;
}
