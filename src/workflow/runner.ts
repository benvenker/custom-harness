import { mkdirSync } from 'node:fs';
import React from 'react';
import { PiAgent, createSmithers } from 'smithers-orchestrator';
import { runWorkflow } from '@smithers-orchestrator/engine';
import { Effect } from 'effect';
import { z } from 'zod';
import type { Workflow, WorkflowNode } from '../types.js';
import { taskNodeIds, type RunRecorder } from '../runs/recorder.js';

const OPENROUTER_MODEL = 'anthropic/claude-3.5-haiku';
const HARNESS_STATE_DIR = '.harness/smithers';
const SMITHERS_DB_PATH = `${HARNESS_STATE_DIR}/smithers.db`;
const SMITHERS_LOG_DIR = `${HARNESS_STATE_DIR}/executions`;

function makeAgent() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
  const agent = new PiAgent({
    model: `openrouter/${OPENROUTER_MODEL}`,
    apiKey,
    cwd: process.cwd(),
    noSession: true,
    tools: ['read', 'ls', 'bash', 'grep', 'find'],
    mode: 'json',
    timeoutMs: 180_000,
    idleTimeoutMs: 60_000,
  });
  (agent as { supportsNativeStructuredOutput?: boolean }).supportsNativeStructuredOutput = true;
  return agent;
}

function collectTasks(node: WorkflowNode): Array<{ name: string }> {
  switch (node.type) {
    case 'task':
      return [{ name: node.name }];
    case 'sequence':
    case 'parallel':
      return node.children.flatMap(collectTasks);
    case 'branch':
      return [
        ...node.cases.flatMap((c) => collectTasks(c.node)),
        ...(node.default ? collectTasks(node.default) : []),
      ];
    case 'loop':
      return collectTasks(node.body);
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
        entries: children.flatMap((c) => c.entries),
        exits: children.flatMap((c) => c.exits),
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
    throw new Error(`Unsupported workflow node type for dependency map: ${node.type}`);
  }

  visit(root);
  return deps;
}

function buildElement(
  node: WorkflowNode,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  components: Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agent: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schemas: Record<string, any>,
  nodeIds: Map<string, string> = new Map(),
  deps: Map<string, string[]> = new Map(),
): React.ReactElement {
  const { Task, Sequence, Parallel } = components;

  switch (node.type) {
    case 'task': {
      const id = nodeIds.get(node.name) ?? node.name;
      const upstream = deps.get(id) ?? [];
      const needs = Object.fromEntries(upstream.map((from) => [from, from]));
      return React.createElement(
        Task,
        {
          key: node.name,
          id,
          output: schemas[node.name],
          agent,
          dependsOn: upstream.length > 0 ? upstream : undefined,
          needs: upstream.length > 0 ? needs : undefined,
          noRetry: true,
        },
        node.prompt,
      );
    }
    case 'sequence':
      return React.createElement(
        Sequence,
        { key: node.name ?? 'seq' },
        ...node.children.map((c) => buildElement(c, components, agent, schemas, nodeIds, deps)),
      );
    case 'parallel':
      return React.createElement(
        Parallel,
        { key: node.name ?? 'par' },
        ...node.children.map((c) => buildElement(c, components, agent, schemas, nodeIds, deps)),
      );
    default:
      throw new Error(
        `Node type "${node.type}" is not yet supported in the dynamic builder. ` +
          `Add branch/loop support to src/workflow/runner.ts.`,
      );
  }
}

export async function runSmithersWorkflow(
  goal: string,
  plan: Workflow,
  recorder?: RunRecorder,
): Promise<string> {
  const agent = makeAgent();

  const tasks = collectTasks(plan.root);
  const nodeIds = taskNodeIds(plan.root);
  const deps = dependencyMap(plan.root, nodeIds);
  // Smithers resolves task outputs by schema object identity; sharing one Zod object makes every output key ambiguous.
  const schemas = Object.fromEntries(tasks.map((t) => [t.name, z.object({ result: z.string() })]));

  mkdirSync(SMITHERS_LOG_DIR, { recursive: true });
  const { Workflow, Task, Sequence, Parallel, smithers, outputs: smithersOutputs } =
    createSmithers(schemas, { dbPath: SMITHERS_DB_PATH });
  const components = { Task, Sequence, Parallel };

  const workflow = smithers((_ctx) =>
    React.createElement(
      Workflow,
      { name: plan.name },
      buildElement(plan.root, components, agent, smithersOutputs, nodeIds, deps),
    ),
  );

  const smithersRunId = crypto.randomUUID();
  const runLines = `  Smithers Run ID: ${smithersRunId}\n  Tasks:  ${tasks.map((t) => t.name).join(', ')}\n`;
  process.stdout.write(runLines);
  recorder?.appendCli(runLines);

  const result = await Effect.runPromise(
    runWorkflow(workflow, {
      input: { goal },
      runId: smithersRunId,
      resume: false,
      rootDir: process.cwd(),
      logDir: SMITHERS_LOG_DIR,
      onProgress: (event) => emitSmithersEvent(event, recorder, deps, smithersOutputs),
    }),
  );

  const outputs = tasks
    .map((t) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = (result as any).outputs?.[t.name];
      return `${t.name}: ${JSON.stringify(out)}`;
    })
    .join('\n');

  const lastTaskName = tasks.at(-1)?.name;
  recorder?.event('agent.output', {
    nodeId: lastTaskName ? nodeIds.get(lastTaskName) : undefined,
    text: `Workflow "${plan.name}" completed.`,
    synthesized: false,
  });

  const summary = `Workflow "${plan.name}" completed.\n\nTask outputs:\n${outputs}`;
  recorder?.appendCli(`\n--- Result ---\n${summary}\n`);
  return summary;
}

function emitSmithersEvent(
  event: unknown,
  recorder: RunRecorder | undefined,
  deps: Map<string, string[]>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  outputs: Record<string, any>,
) {
  if (!recorder || !event || typeof event !== 'object') return;
  const e = event as Record<string, unknown>;
  const nodeId = typeof e.nodeId === 'string' ? e.nodeId : undefined;
  switch (e.type) {
    case 'NodeStarted':
      if (nodeId) {
        recorder.event('agent.init', { nodeId, model: OPENROUTER_MODEL, synthesized: false });
        recordTaskInputs(recorder, nodeId, deps, outputs);
        recorder.event('task.checkpoint', { nodeId, checkpoint: 'started', synthesized: false });
      }
      break;
    case 'NodeFinished':
      if (nodeId) {
        recorder.flushAgentOutput(nodeId);
        recorder.event('task.done', { nodeId, synthesized: false });
      }
      break;
    case 'NodeFailed':
      recorder.event('run.error', { message: `Smithers node failed: ${nodeId ?? 'unknown'}`, source: 'smithers' });
      break;
    case 'NodeOutput':
      if (nodeId && typeof e.text === 'string') recorder.appendAgentOutput(nodeId, e.text);
      break;
    case 'AgentEvent':
      emitAgentCliEvent(e, recorder, nodeId);
      break;
  }
}

function recordTaskInputs(
  recorder: RunRecorder,
  nodeId: string,
  deps: Map<string, string[]>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _outputs: Record<string, any>,
) {
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
