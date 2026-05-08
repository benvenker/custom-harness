import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessServerHandler } from '../src/server.js';

function tempProject(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeSafeProject() {
  const projectRoot = tempProject('custom-harness-real-run-');
  const workflowsDir = join(projectRoot, '.smithers', 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  symlinkSync(join(process.cwd(), 'node_modules'), join(projectRoot, 'node_modules'), 'dir');
  symlinkSync(join(process.cwd(), 'node_modules'), join(projectRoot, '.smithers', 'node_modules'), 'dir');
  writeFileSync(join(projectRoot, '.smithers', 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
  writeFileSync(join(workflowsDir, 'foo.tsx'), `
import React from 'react';
import { createSmithers } from 'smithers-orchestrator';
import { z } from 'zod';

const schemas = { task: z.object({ result: z.string() }) };
const { Workflow, Task, smithers, outputs } = createSmithers(schemas);
const safeAgent = { id: 'safe-agent', async generate() { return { text: JSON.stringify({ result: 'ok' }) }; } };
export default smithers(() => React.createElement(
  Workflow,
  { name: 'safe-run-workflow' },
  React.createElement(Task, { id: 'do-safe-thing', output: outputs.task, agent: safeAgent }, 'Return ok'),
));
`);
  return projectRoot;
}

describe('project workflow real run integration', () => {
  it('launches a real Smithers run and returns the Smithers run id/status with an inspection URL', async () => {
    const projectRoot = writeSafeProject();
    const handler = createHarnessServerHandler({ rootDir: process.cwd(), projectRoot, workflowId: 'foo' });

    const response = await handler(new Request('http://localhost/api/workflows/foo/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: {} }),
    }));

    expect(response.status).toBe(202);
    const body = await response.json() as {
      ok: boolean;
      runId: string;
      status: string;
      inspection?: { url?: string };
    };
    expect(body.ok).toBe(true);
    expect(body.runId).toMatch(/^run[-_]/);
    expect(body.status).toBeTruthy();
    expect(body.inspection).toEqual({ url: `/api/smithers/runs/${body.runId}` });
    expect(existsSync(join(projectRoot, 'runs'))).toBe(false);

    await waitFor(() => existsSync(join(projectRoot, 'smithers.db')));
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
