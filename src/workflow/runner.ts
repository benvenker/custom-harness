import React from 'react';
import { AnthropicAgent, createSmithers } from 'smithers-orchestrator';
import { runWorkflow } from '@smithers-orchestrator/engine';
import { Effect } from 'effect';
import { z } from 'zod';
import type { Workflow, WorkflowNode } from '../planner.js';

const MODEL = 'claude-sonnet-4-6';

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
      return React.createElement(
        Task,
        { key: node.name, id: node.name, output: schemas[node.name], agent },
        node.prompt,
      );
    case 'sequence':
      return React.createElement(
        Sequence,
        { key: node.name ?? 'seq' },
        ...node.children.map((c) => buildElement(c, components, agent, schemas)),
      );
    case 'parallel':
      return React.createElement(
        Parallel,
        { key: node.name ?? 'par' },
        ...node.children.map((c) => buildElement(c, components, agent, schemas)),
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
): Promise<string> {
  const agent = new AnthropicAgent({ model: MODEL });

  const tasks = collectTasks(plan.root);
  const taskSchema = z.object({ result: z.string() });
  const schemas = Object.fromEntries(tasks.map((t) => [t.name, taskSchema]));

  const { Workflow, Task, Sequence, Parallel, smithers } =
    createSmithers(schemas);
  const components = { Task, Sequence, Parallel };

  const workflow = smithers((_ctx) =>
    React.createElement(
      Workflow,
      { name: plan.name },
      buildElement(plan.root, components, agent, schemas),
    ),
  );

  const runId = crypto.randomUUID();
  console.log(`  Run ID: ${runId}`);
  console.log(`  Tasks:  ${tasks.map((t) => t.name).join(', ')}`);

  const result = await Effect.runPromise(
    runWorkflow(workflow, {
      input: { goal },
      runId,
      resume: false,
    }),
  );

  const outputs = tasks
    .map((t) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = (result as any).outputs?.[t.name];
      return `${t.name}: ${JSON.stringify(out)}`;
    })
    .join('\n');

  return `Workflow "${plan.name}" completed.\n\nTask outputs:\n${outputs}`;
}
