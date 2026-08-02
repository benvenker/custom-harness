import React from 'react';
import { createSmithers, type AgentLike } from 'smthrs';
import { z } from 'zod';

const schemas = {
  task: z.object({ result: z.string() }),
};

const { Workflow, Task, smithers, outputs } = createSmithers(schemas);

const placeholderAgent = {
  name: 'placeholder-agent',
} as unknown as AgentLike;

export default smithers((ctx) =>
  React.createElement(
    Workflow,
    { name: 'fixture-placeholder-agent-workflow' },
    React.createElement(
      Task,
      { id: 'placeholder-task', output: outputs.task, agent: placeholderAgent },
      `Prompt: ${String(ctx.input.prompt ?? '')}`,
    ),
  ),
);
