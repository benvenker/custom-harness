/**
 * No-API-key tests: validate the planner schema and workflow DAG builder
 * without making any LLM calls.
 */
import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import React from 'react';
import { createSmithers } from 'smithers-orchestrator';
import { z } from 'zod';
import type { WorkflowNode, Workflow } from '../src/types.js';

// --- helpers duplicated from runner (not exported, so we re-implement here) ---

function collectTasks(node: WorkflowNode): string[] {
  switch (node.type) {
    case 'task': return [node.name];
    case 'sequence':
    case 'parallel': return node.children.flatMap(collectTasks);
    case 'branch':
      return [
        ...node.cases.flatMap((c) => collectTasks(c.node)),
        ...(node.default ? collectTasks(node.default) : []),
      ];
    case 'loop': return collectTasks(node.body);
  }
}

function buildElement(
  node: WorkflowNode,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  components: Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agent: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schemas: Record<string, any>,
): React.ReactElement {
  const { Task, Sequence, Parallel } = components;
  switch (node.type) {
    case 'task':
      return React.createElement(Task, { key: node.name, id: node.name, output: schemas[node.name], agent }, node.prompt);
    case 'sequence':
      return React.createElement(Sequence, { key: node.name ?? 'seq' },
        ...node.children.map((c) => buildElement(c, components, agent, schemas)));
    case 'parallel':
      return React.createElement(Parallel, { key: node.name ?? 'par' },
        ...node.children.map((c) => buildElement(c, components, agent, schemas)));
    default:
      throw new Error(`Unsupported node type: ${(node as WorkflowNode).type}`);
  }
}

// --- Valibot plan schema (mirrored from orchestrator) ---

const taskNodeSchema = v.object({ type: v.literal('task'), name: v.string(), prompt: v.string() });
const workflowNodeSchema: v.GenericSchema = v.union([
  taskNodeSchema,
  v.object({
    type: v.union([v.literal('sequence'), v.literal('parallel')]),
    name: v.optional(v.string()),
    children: v.array(v.lazy(() => workflowNodeSchema)),
  }),
]);
const planSchema = v.union([
  v.object({ path: v.literal('harness'), reason: v.string() }),
  v.object({
    path: v.literal('workflow'),
    reason: v.string(),
    workflow: v.object({ name: v.string(), description: v.string(), root: workflowNodeSchema }),
  }),
]);

// --- Tests ---

describe('planner schema (valibot)', () => {
  it('accepts a valid harness plan', () => {
    const result = v.safeParse(planSchema, { path: 'harness', reason: 'Simple task' });
    expect(result.success).toBe(true);
  });

  it('accepts a valid workflow plan with a sequence of tasks', () => {
    const input = {
      path: 'workflow',
      reason: 'Multi-step task',
      workflow: {
        name: 'test-workflow',
        description: 'A test workflow',
        root: {
          type: 'sequence',
          children: [
            { type: 'task', name: 'step-1', prompt: 'Do step one' },
            { type: 'task', name: 'step-2', prompt: 'Do step two' },
          ],
        },
      },
    };
    const result = v.safeParse(planSchema, input);
    expect(result.success).toBe(true);
  });

  it('accepts a workflow plan with parallel tasks', () => {
    const input = {
      path: 'workflow',
      reason: 'Parallel work',
      workflow: {
        name: 'parallel-workflow',
        description: 'Runs tasks in parallel',
        root: {
          type: 'parallel',
          children: [
            { type: 'task', name: 'job-a', prompt: 'Do job A' },
            { type: 'task', name: 'job-b', prompt: 'Do job B' },
          ],
        },
      },
    };
    expect(v.safeParse(planSchema, input).success).toBe(true);
  });

  it('rejects an unknown path value', () => {
    const result = v.safeParse(planSchema, { path: 'magic', reason: 'nope' });
    expect(result.success).toBe(false);
  });

  it('rejects a workflow plan missing the workflow field', () => {
    const result = v.safeParse(planSchema, { path: 'workflow', reason: 'missing workflow' });
    expect(result.success).toBe(false);
  });
});

describe('workflow DAG builder (Smithers)', () => {
  const MOCK_AGENT = {}; // no API calls made — createSmithers only needs the schema registry

  function buildWorkflow(plan: Workflow) {
    const tasks = collectTasks(plan.root);
    const taskSchema = z.object({ result: z.string() });
    const schemas = Object.fromEntries(tasks.map((name) => [name, taskSchema]));
    const { Workflow, Task, Sequence, Parallel, smithers } = createSmithers(schemas);
    const components = { Task, Sequence, Parallel };
    return smithers((_ctx) =>
      React.createElement(Workflow, { name: plan.name },
        buildElement(plan.root, components, MOCK_AGENT, schemas)),
    );
  }

  it('builds a single-task workflow without throwing', () => {
    const plan: Workflow = {
      name: 'single-task',
      description: 'One task',
      root: { type: 'task', name: 'do-it', prompt: 'Do the thing' },
    };
    expect(() => buildWorkflow(plan)).not.toThrow();
  });

  it('builds a sequence workflow and collects correct task names', () => {
    const plan: Workflow = {
      name: 'seq-workflow',
      description: 'Sequential tasks',
      root: {
        type: 'sequence',
        children: [
          { type: 'task', name: 'alpha', prompt: 'Step alpha' },
          { type: 'task', name: 'beta', prompt: 'Step beta' },
        ],
      },
    };
    expect(() => buildWorkflow(plan)).not.toThrow();
    expect(collectTasks(plan.root)).toEqual(['alpha', 'beta']);
  });

  it('builds a parallel workflow and collects correct task names', () => {
    const plan: Workflow = {
      name: 'par-workflow',
      description: 'Parallel tasks',
      root: {
        type: 'parallel',
        children: [
          { type: 'task', name: 'left', prompt: 'Left branch' },
          { type: 'task', name: 'right', prompt: 'Right branch' },
        ],
      },
    };
    expect(() => buildWorkflow(plan)).not.toThrow();
    expect(collectTasks(plan.root)).toEqual(['left', 'right']);
  });

  it('handles nested sequence inside parallel', () => {
    const plan: Workflow = {
      name: 'nested',
      description: 'Nested structure',
      root: {
        type: 'parallel',
        children: [
          {
            type: 'sequence',
            children: [
              { type: 'task', name: 'a', prompt: 'A' },
              { type: 'task', name: 'b', prompt: 'B' },
            ],
          },
          { type: 'task', name: 'c', prompt: 'C' },
        ],
      },
    };
    expect(() => buildWorkflow(plan)).not.toThrow();
    expect(collectTasks(plan.root).sort()).toEqual(['a', 'b', 'c']);
  });

  it('throws on unsupported node type when buildElement is called', () => {
    // smithers(fn) is lazy — the builder only runs at execution time, not construction.
    // Test buildElement directly to validate the guard.
    const schemas = { t: z.object({ result: z.string() }) };
    const { Task, Sequence, Parallel } = createSmithers(schemas);
    const components = { Task, Sequence, Parallel };
    const loopNode = {
      type: 'loop',
      condition: 'always',
      body: { type: 'task', name: 't', prompt: 'p' },
    } as unknown as WorkflowNode;
    expect(() => buildElement(loopNode, components, MOCK_AGENT, schemas)).toThrow('Unsupported node type');
  });
});
