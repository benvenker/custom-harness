import React from 'react';
import { createSmithers } from 'smthrs';
import { z } from 'zod';

const schemas = {
  task: z.object({ result: z.string() }),
};

const { Workflow, Task, Sequence, Parallel, smithers, outputs } = createSmithers(schemas);

const renderOnlyAgent = {
  id: 'render-only-agent',
  async generate() {
    throw new Error('fixture workflow tasks should not execute during graph rendering');
  },
};

const workflow = smithers((ctx) =>
  React.createElement(
    Workflow,
    { name: 'fixture-native-workflow' },
    React.createElement(
      Sequence,
      {},
      React.createElement(
        Task,
        { id: 'inspect-diff', output: outputs.task, agent: renderOnlyAgent },
        `Inspect input prompt: ${String(ctx.input.prompt ?? '')}`,
      ),
      React.createElement(
        Parallel,
        {},
        React.createElement(Task, { id: 'check-tests', output: outputs.task, agent: renderOnlyAgent }, 'Check tests'),
        React.createElement(Task, { id: 'check-types', output: outputs.task, agent: renderOnlyAgent }, 'Check types'),
      ),
      React.createElement(
        Task,
        { id: 'write-findings', output: outputs.task, agent: renderOnlyAgent },
        'Write findings',
      ),
    ),
  ),
);

export default workflow;
