import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import React from 'react';
import { CodexAgent, createSmithers } from 'smithers-orchestrator';
import { runWorkflow as runSmithersWorkflow } from '@smithers-orchestrator/engine';
import { Effect } from 'effect';
import { RecordingAgent } from '../agents/recordingAgent.js';
import { buildHarnessPrompt, buildPlannerPrompt, buildTaskPrompt, PLANNER_SYSTEM_PROMPT } from '../planning/prompts.js';
import {
  planSchema,
  planTaskOutputSchema,
  taskOutputSchema,
  type PlannerOutput,
} from '../planning/schema.js';
import { taskNodeIds, type RunRecorder } from '../runs/recorder.js';
import type { TaskNode, Workflow, WorkflowNode } from '../types.js';

export type AgentGenerateOptions = {
  prompt?: unknown;
  messages?: unknown;
  outputSchema?: unknown;
  rootDir?: string;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
  [key: string]: unknown;
};

export type AgentGenerateResult = {
  text?: string | null;
  output?: unknown;
  _output?: unknown;
  [key: string]: unknown;
};

export type AgentLike = {
  generate(options?: AgentGenerateOptions): Promise<AgentGenerateResult>;
  model?: string;
  id?: string;
  cliEngine?: string;
};

export type OutcomeWorkflowRunnerArgs = {
  workflow: unknown;
  input: Record<string, unknown>;
  runId: string;
  rootDir: string;
  logDir: string;
  onProgress?: (event: unknown) => void;
};

export type OutcomeWorkflowRunner = (args: OutcomeWorkflowRunnerArgs) => Promise<{ runId: string; status: string }>;

export type OutcomeWorkflowHandle = {
  workflow: unknown;
  dbPath: string;
  logDir: string;
  close: () => void;
  getPlan: () => PlannerOutput | null;
};

export function createDefaultAgent(): AgentLike {
  return new CodexAgent({
    cd: process.cwd(),
    fullAuto: true,
    sandbox: 'workspace-write',
    skipGitRepoCheck: true,
    json: true,
  }) as AgentLike;
}

export function defaultOutcomeWorkflowRunner(): OutcomeWorkflowRunner {
  return async ({ workflow, input, runId, rootDir, logDir, onProgress }) => {
    const result = await Effect.runPromise(
      runSmithersWorkflow(workflow as never, {
        input,
        runId,
        resume: false,
        rootDir,
        logDir,
        onProgress,
      }),
    );
    return { runId: result.runId, status: result.status };
  };
}

export function buildOutcomeWorkflow(args: {
  goal: string;
  context?: string;
  runId: string;
  runDir: string;
  planner: AgentLike;
  executorAgent: AgentLike;
  recorder: RunRecorder;
  onPlan: (plan: PlannerOutput) => void;
}): OutcomeWorkflowHandle {
  const dbPath = join(args.runDir, 'smithers', 'smithers.db');
  const logDir = join(args.runDir, 'smithers', 'executions');
  mkdirSync(dirname(dbPath), { recursive: true });
  mkdirSync(logDir, { recursive: true });

  let currentPlan: PlannerOutput | null = null;
  const schemas = {
    plan: planTaskOutputSchema,
    task: taskOutputSchema,
  };
  const { Workflow: SmithersWorkflow, Task, Sequence, Parallel, smithers, outputs, db } =
    createSmithers(schemas, { dbPath });

  const planAgent = new RecordingAgent({
    nodeId: 'plan',
    agent: args.planner,
    recorder: args.recorder,
    outputSchema: planTaskOutputSchema,
    onValidatedOutput: (output) => {
      const parsed = planSchema.parse(output);
      try {
        validatePlanForExecution(parsed);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        args.recorder.event('run.error', { nodeId: 'plan', message, source: 'planner' });
        throw error;
      }
      if (!currentPlan) {
        currentPlan = parsed;
        args.onPlan(parsed);
      }
    },
  });

  const workflow = smithers((ctx) => {
    const persistedPlan = ctx.latest(outputs.plan, 'plan');
    const plan = currentPlan ?? parsePersistedPlan(persistedPlan);
    if (plan && !currentPlan) {
      currentPlan = plan;
      args.onPlan(plan);
    }

    return React.createElement(
      SmithersWorkflow,
      { name: `outcome:${args.runId}` },
      React.createElement(
        Task,
        {
          id: 'plan',
          output: outputs.plan,
          agent: planAgent,
          noRetry: true,
        },
        `${PLANNER_SYSTEM_PROMPT}\n\n${buildPlannerPrompt(args.goal, args.context)}`,
      ),
      plan ? renderExecution({
        ctx,
        plan,
        goal: args.goal,
        context: args.context,
        executorAgent: args.executorAgent,
        recorder: args.recorder,
        components: { Task, Sequence, Parallel },
        output: outputs.task,
      }) : null,
    );
  });

  return {
    workflow,
    dbPath,
    logDir,
    close: () => {
      const client = (db as { $client?: { close?: () => void } }).$client;
      client?.close?.();
    },
    getPlan: () => currentPlan,
  };
}

function renderExecution(args: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
  plan: PlannerOutput;
  goal: string;
  context?: string;
  executorAgent: AgentLike;
  recorder: RunRecorder;
  components: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Task: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Sequence: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Parallel: any;
  };
  output: unknown;
}) {
  if (args.plan.path === 'harness') {
    return React.createElement(
      args.components.Task,
      {
        id: 'worker',
        output: args.output,
        agent: recordingTaskAgent('worker', args.executorAgent, args.recorder),
        dependsOn: ['plan'],
        needs: { plan: 'plan' },
        noRetry: true,
      },
      buildHarnessPrompt(args.goal, args.context),
    );
  }

  assertUniqueTaskNames(args.plan.workflow.root);
  const nodeIds = taskNodeIds(args.plan.workflow.root);
  const deps = dependencyMap(args.plan.workflow.root, nodeIds);
  const root = renderWorkflowNode(args.plan.workflow.root, {
    ...args,
    nodeIds,
    deps,
  });
  return root;
}

function renderWorkflowNode(
  node: WorkflowNode,
  args: {
    goal: string;
    context?: string;
    executorAgent: AgentLike;
    recorder: RunRecorder;
    components: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Task: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Sequence: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Parallel: any;
    };
    output: unknown;
    nodeIds: Map<string, string>;
    deps: Map<string, string[]>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx: any;
  },
): React.ReactElement {
  if (node.type === 'task') {
    const id = args.nodeIds.get(node.name) ?? node.name;
    const upstream = args.deps.get(id) ?? [];
    const dependsOn = upstream.length > 0 ? upstream : ['plan'];
    const needs = Object.fromEntries(dependsOn.map((from) => [from, from]));
    return React.createElement(
      args.components.Task,
      {
        key: id,
        id,
        output: args.output,
        agent: recordingTaskAgent(id, args.executorAgent, args.recorder),
        dependsOn,
        needs,
        noRetry: true,
      },
      buildTaskPrompt({
        goal: args.goal,
        context: args.context,
        task: node,
        upstream: upstreamTaskOutputs(upstream, args),
      }),
    );
  }

  if (node.type === 'sequence') {
    return React.createElement(
      args.components.Sequence,
      { key: node.name ?? 'sequence' },
      ...node.children.map((child) => renderWorkflowNode(child, args)),
    );
  }

  if (node.type === 'parallel') {
    return React.createElement(
      args.components.Parallel,
      { key: node.name ?? 'parallel' },
      ...node.children.map((child) => renderWorkflowNode(child, args)),
    );
  }

  throw new Error(`Unsupported workflow node type: ${node.type}`);
}

function upstreamTaskOutputs(
  upstream: string[],
  args: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx: any;
    output: unknown;
    recorder: RunRecorder;
  },
) {
  return upstream.flatMap((from) => {
    const row = args.ctx.latest(args.output, from) as { result?: unknown } | undefined;
    const artifact = args.recorder.outputArtifactFor(from);
    if (!row && !artifact) return [];
    const result = typeof row?.result === 'string'
      ? row.result
      : row
        ? JSON.stringify(row)
        : undefined;
    return [{ from, result, artifact }];
  });
}

function recordingTaskAgent(nodeId: string, agent: AgentLike, recorder: RunRecorder) {
  return new RecordingAgent({
    nodeId,
    agent,
    recorder,
    outputSchema: taskOutputSchema,
  });
}

function validatePlanForExecution(plan: PlannerOutput) {
  if (plan.path === 'workflow') assertUniqueTaskNames(plan.workflow.root);
}

function parsePersistedPlan(value: unknown): PlannerOutput | null {
  if (!value) return null;
  const parsed = planTaskOutputSchema.safeParse(value);
  if (!parsed.success) return null;
  return planSchema.parse(parsed.data);
}

export function emitSmithersEvent(args: {
  event: unknown;
  recorder: RunRecorder;
  plan: PlannerOutput | null;
}) {
  if (!args.event || typeof args.event !== 'object') return;
  const event = args.event as Record<string, unknown>;
  const nodeId = typeof event.nodeId === 'string' ? event.nodeId : undefined;

  if (event.type === 'NodeStarted' && nodeId) {
    args.recorder.event('agent.init', { nodeId, model: 'smithers-task-agent', synthesized: false });
    args.recorder.event('task.started', { nodeId, synthesized: false });
    recordTaskInputs(args.recorder, nodeId, args.plan);
    args.recorder.event('task.checkpoint', { nodeId, checkpoint: 'started', synthesized: false });
  } else if (event.type === 'NodeFinished' && nodeId) {
    args.recorder.flushAgentOutput(nodeId);
    args.recorder.event('task.done', { nodeId, synthesized: false });
  } else if (event.type === 'NodeFailed') {
    args.recorder.event('run.error', {
      nodeId,
      message: `Smithers node failed: ${nodeId ?? 'unknown'}`,
      source: 'smithers',
    });
  } else if (event.type === 'AgentEvent') {
    emitAgentCliEvent(event, args.recorder, nodeId);
  }
}

function recordTaskInputs(recorder: RunRecorder, nodeId: string, plan: PlannerOutput | null) {
  if (!plan || plan.path !== 'workflow' || nodeId === 'plan') return;
  const nodeIds = taskNodeIds(plan.workflow.root);
  const deps = dependencyMap(plan.workflow.root, nodeIds);
  const upstream = deps.get(nodeId) ?? [];
  if (upstream.length === 0) return;
  const inputs = upstream.flatMap((from) => {
    const artifact = recorder.outputArtifactFor(from);
    if (!artifact) return [];
    return [{ from, label: artifact, value: { artifact } }];
  });
  recorder.recordTaskInput(nodeId, inputs);
}

function emitAgentCliEvent(e: Record<string, unknown>, recorder: RunRecorder, nodeId?: string) {
  if (!nodeId || !e.event || typeof e.event !== 'object') return;
  const agentEvent = e.event as Record<string, unknown>;
  if (agentEvent.type === 'action' && agentEvent.action && typeof agentEvent.action === 'object') {
    const action = agentEvent.action as Record<string, unknown>;
    const kind = typeof action.kind === 'string' ? action.kind : undefined;
    if (!kind || !['command', 'tool', 'file_change', 'web_search'].includes(kind)) return;
    const name = typeof action.title === 'string' ? action.title : kind;
    const phase = agentEvent.phase === 'completed' ? '.done' : agentEvent.phase === 'started' ? '' : '.checkpoint';
    recorder.event(`tool.${name}${phase}`, { nodeId, synthesized: false });
  }
  if (agentEvent.type === 'completed' && typeof agentEvent.answer === 'string') {
    recorder.appendAgentOutput(nodeId, agentEvent.answer);
    recorder.flushAgentOutput(nodeId);
  }
}

function dependencyMap(root: WorkflowNode, nodeIds: Map<string, string>) {
  const deps = new Map<string, string[]>();

  function visit(node: WorkflowNode): { entries: string[]; exits: string[] } {
    if (node.type === 'task') {
      const id = nodeIds.get(node.name) ?? node.name;
      deps.set(id, deps.get(id) ?? []);
      return { entries: [id], exits: [id] };
    }

    if (node.type === 'parallel') {
      const children = node.children.map(visit);
      return {
        entries: children.flatMap((child) => child.entries),
        exits: children.flatMap((child) => child.exits),
      };
    }

    if (node.type === 'sequence') {
      const children = node.children.map(visit);
      for (let i = 1; i < children.length; i += 1) {
        for (const entry of children[i].entries) {
          deps.set(entry, [...(deps.get(entry) ?? []), ...children[i - 1].exits]);
        }
      }
      return {
        entries: children[0]?.entries ?? [],
        exits: children.at(-1)?.exits ?? [],
      };
    }

    throw new Error(`Unsupported workflow node type: ${node.type}`);
  }

  visit(root);
  return deps;
}

function assertUniqueTaskNames(root: WorkflowNode) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const task of collectTaskNodes(root)) {
    if (seen.has(task.name)) duplicates.add(task.name);
    seen.add(task.name);
  }
  if (duplicates.size > 0) {
    throw new Error(`Duplicate workflow task names are not supported: ${[...duplicates].join(', ')}`);
  }
}

function collectTaskNodes(root: WorkflowNode): TaskNode[] {
  if (root.type === 'task') return [root];
  if (root.type === 'sequence' || root.type === 'parallel') return root.children.flatMap(collectTaskNodes);
  throw new Error(`Unsupported workflow node type: ${root.type}`);
}

export type { PlannerOutput };
