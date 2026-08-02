import React from 'react';
import { createSmithers } from 'smthrs';
import { z } from 'zod';

const schemas = {
  task: z.object({ result: z.string() }),
};

const { Workflow, Task, smithers, outputs } = createSmithers(schemas);

const executableAgent = {
  id: 'executable-fixture-agent',
  async generate(options: { prompt?: unknown; onStdout?: (text: string) => void }) {
    const result = `executed ${String(options.prompt ?? '')}`;
    const text = JSON.stringify({ result });
    options.onStdout?.(text);
    return { text };
  },
};

export default smithers((ctx) =>
  React.createElement(
    Workflow,
    { name: 'fixture-executable-workflow' },
    React.createElement(
      Task,
      { id: 'execute-prompt', output: outputs.task, agent: executableAgent },
      `Prompt: ${String(ctx.input.prompt ?? '')}`,
    ),
  ),
);
