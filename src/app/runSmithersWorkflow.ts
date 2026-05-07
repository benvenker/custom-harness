import { dirname, join, resolve, sep } from 'node:path';
import type { GraphSnapshot } from '@smithers-orchestrator/graph';
import React from 'react';
import { CodexAgent } from 'smithers-orchestrator';
import { createRunRecorder } from '../runs/recorder.js';
import { emitSmithersEvent, type AgentLike } from '../workflows/outcomeWorkflow.js';
import { loadSmithersRuntime, loadWorkflow, type SmithersWorkflowLike } from './smithersRuntime.js';

const MODEL = 'smithers-exported-workflow';

export type RunSmithersWorkflowOptions = {
  workflowPath: string;
  input: Record<string, unknown>;
  goal?: string;
  context?: string;
  runId?: string;
  runsDir?: string;
  fallbackAgent?: AgentLike;
  /**
   * Per-task prompt overrides keyed by Smithers Task `props.id`.
   * When set, replaces the children of any Task element whose id matches.
   */
  promptOverrides?: Record<string, string>;
  /** Source run id when this run is a fork. Persisted on run.json. */
  forkedFrom?: string;
};

export type RunSmithersWorkflowResult = {
  runId: string;
  status: 'succeeded' | 'failed';
  path: 'workflow';
  runDir: string;
};

export async function runSmithersWorkflow(
  options: RunSmithersWorkflowOptions,
): Promise<RunSmithersWorkflowResult> {
  const runId = options.runId ?? crypto.randomUUID();
  const workflowPath = resolve(process.cwd(), options.workflowPath);
  const input = options.input;
  const promptOverrides = options.promptOverrides && Object.keys(options.promptOverrides).length > 0
    ? options.promptOverrides
    : undefined;
  const goal = options.goal ?? inputPrompt(input) ?? `Run Smithers workflow ${workflowPath}`;
  const recorder = createRunRecorder(
    runId,
    { goal, model: MODEL },
    {
      runsDir: options.runsDir,
      ...(options.forkedFrom === undefined ? {} : { forkedFrom: options.forkedFrom }),
    },
  );
  const startedAt = Date.now();
  const rootDir = inferSmithersRootDir(workflowPath);
  const logDir = join(resolve(recorder.runDir), 'smithers', 'executions');

  recorder.event('run.started', {
    goal,
    mode: 'smithers-workflow-rerun',
    workflowPath,
    ...(options.context === undefined ? {} : { context: options.context }),
    ...(options.forkedFrom === undefined ? {} : { forkedFrom: options.forkedFrom }),
    ...(promptOverrides === undefined ? {} : { promptOverrides }),
  });
  recorder.appendCli(`smithers workflow rerun\nworkflow=${workflowPath}\nrunId=${runId}\n`);

  try {
    const workflow = await loadWorkflow(workflowPath);
    const runtime = await loadSmithersRuntime(workflowPath);
    applyWorkflowOverrides(workflow, {
      fallbackAgent: options.fallbackAgent ?? createFallbackAgent(rootDir),
      ...(promptOverrides === undefined ? {} : { promptOverrides }),
    });
    const frame = await renderSnapshot({ runtime, workflow, workflowPath, runId, input, rootDir });
    recorder.writeSmithersPlanSnapshot(frame, {
      reason: 'Rerun exported Smithers workflow.',
      workflowPath,
      input,
      ...(options.context === undefined ? {} : { context: options.context }),
      ...(promptOverrides === undefined ? {} : { promptOverrides }),
      planningLatencyMs: Date.now() - startedAt,
      tokens: null,
    });

    const result = await runtime.runPromise(
      runtime.runWorkflow(workflow as never, {
        input,
        runId,
        resume: false,
        rootDir,
        logDir,
        workflowPath,
        onProgress: (event: unknown) => emitSmithersEvent({
          event,
          recorder,
          plan: null,
        }),
      }),
    ) as { status?: string };
    if (result.status !== 'finished') throw new Error(`Smithers workflow ended with status ${String(result.status)}`);

    const finalFrame = await renderSnapshot({ runtime, workflow, workflowPath, runId, input, rootDir });
    recorder.writeSmithersGraphSnapshot(finalFrame);
    recorder.event('run.done', { status: 'succeeded' });
    recorder.finish('succeeded', { latencyMs: Date.now() - startedAt });
    return { runId, status: 'succeeded', path: 'workflow', runDir: recorder.runDir };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recorder.event('run.error', { message, source: 'smithers-workflow-rerun' });
    recorder.finish('failed', { latencyMs: Date.now() - startedAt });
    return { runId, status: 'failed', path: 'workflow', runDir: recorder.runDir };
  }
}

async function renderSnapshot(args: {
  runtime: Awaited<ReturnType<typeof loadSmithersRuntime>>;
  workflow: Awaited<ReturnType<typeof loadWorkflow>>;
  workflowPath: string;
  runId: string;
  input: Record<string, unknown>;
  rootDir: string;
}) {
  const ctx = new args.runtime.SmithersCtx({
    runId: args.runId,
    iteration: 0,
    input: args.input,
    outputs: {},
    zodToKeyName: args.workflow.zodToKeyName,
  });
  return await args.runtime.runPromise(
    args.runtime.renderFrame(args.workflow as never, ctx, {
      baseRootDir: args.rootDir,
      workflowPath: args.workflowPath,
    }),
  ) as GraphSnapshot;
}

function inferSmithersRootDir(workflowPath: string) {
  const marker = `${sep}.smithers${sep}`;
  const index = workflowPath.lastIndexOf(marker);
  if (index >= 0) return workflowPath.slice(0, index);
  return dirname(workflowPath);
}

function inputPrompt(input: Record<string, unknown>) {
  return typeof input.prompt === 'string' && input.prompt.trim() ? input.prompt : null;
}

function createFallbackAgent(rootDir: string): AgentLike {
  return new CodexAgent({
    cd: rootDir,
    cwd: rootDir,
    sandbox: 'workspace-write',
    skipGitRepoCheck: true,
  } as never) as AgentLike;
}

type WorkflowOverrideOptions = {
  fallbackAgent: AgentLike;
  promptOverrides?: Record<string, string>;
};

const ORIGINAL_BUILD = Symbol.for('custom-harness.smithers.originalBuild');

export function applyWorkflowOverrides(
  workflow: SmithersWorkflowLike,
  options: WorkflowOverrideOptions,
) {
  const w = workflow as Record<string | symbol, unknown>;
  // Smithers workflows are module-cached, so reruns reuse the same object.
  // Stash the pristine build the first time and always wrap it, never wrap a wrap.
  const stashed = w[ORIGINAL_BUILD];
  const original = typeof stashed === 'function'
    ? (stashed as (ctx: unknown) => unknown)
    : (typeof w.build === 'function' ? (w.build as (ctx: unknown) => unknown) : null);
  if (!original) return;
  w[ORIGINAL_BUILD] = original;
  w.build = (ctx: unknown) => walkAndPatch(original.call(workflow, ctx), options);
}

function walkAndPatch(node: unknown, opts: WorkflowOverrideOptions): unknown {
  if (!React.isValidElement(node)) return node;
  const props = node.props as { id?: unknown; agent?: unknown; children?: unknown };
  const nextChildren = walkChildren(props.children, opts);
  const nextAgent = props.agent === undefined
    ? undefined
    : executableAgent(props.agent, opts.fallbackAgent);
  const overrideId = typeof props.id === 'string' ? props.id : undefined;
  const promptOverride = overrideId && opts.promptOverrides
    ? opts.promptOverrides[overrideId]
    : undefined;

  const agentChanged = nextAgent !== undefined && nextAgent !== props.agent;
  const replacement: unknown = typeof promptOverride === 'string'
    ? promptOverride
    : (nextChildren !== props.children ? nextChildren : undefined);

  if (!agentChanged && replacement === undefined) return node;

  const patchProps: Record<string, unknown> = {};
  if (agentChanged) patchProps.agent = nextAgent;

  // Assigning `children: [...]` via cloneElement makes React treat them as a
  // dynamic list and demand `key` props. JSX-positioned children compile to a
  // variadic createElement call instead. Mirror that here by spreading arrays
  // as variadic args so we don't introduce the "unique key" warning that the
  // authored .tsx file otherwise wouldn't see.
  if (replacement === undefined) return React.cloneElement(node, patchProps);
  if (Array.isArray(replacement)) return React.cloneElement(node, patchProps, ...replacement);
  return React.cloneElement(node, patchProps, replacement as never);
}

function walkChildren(children: unknown, opts: WorkflowOverrideOptions) {
  if (Array.isArray(children)) {
    let changed = false;
    const next = children.map((child) => {
      const replaced = walkAndPatch(child, opts);
      if (replaced !== child) changed = true;
      return replaced;
    });
    return changed ? next : children;
  }
  const replaced = walkAndPatch(children, opts);
  return replaced === children ? children : replaced;
}

function executableAgent(agent: unknown, fallbackAgent: AgentLike): unknown {
  if (Array.isArray(agent)) {
    let changed = false;
    const agents = agent.map((item) => {
      const next = executableAgent(item, fallbackAgent);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? agents : agent;
  }
  if (hasGenerate(agent)) return agent;
  return fallbackAgent;
}

function hasGenerate(value: unknown): value is AgentLike {
  return Boolean(value && typeof value === 'object' && typeof (value as { generate?: unknown }).generate === 'function');
}
