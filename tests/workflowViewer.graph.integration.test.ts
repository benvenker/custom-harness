import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHarnessServerHandler } from '../src/server.js';

function tempProject(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function copyFixtureWorkflowProject() {
  const projectRoot = tempProject('custom-harness-real-graph-');
  const workflowsDir = join(projectRoot, '.smithers', 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  symlinkSync(resolve('node_modules'), join(projectRoot, '.smithers', 'node_modules'), 'dir');
  writeFileSync(join(projectRoot, '.smithers', 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
  writeFileSync(join(workflowsDir, 'foo.tsx'), `
import React from 'react';
import { createSmithers } from 'smthrs';
import { z } from 'zod';

const schemas = { task: z.object({ result: z.string() }) };
const { Workflow, Task, Sequence, smithers, outputs } = createSmithers(schemas);
const renderOnlyAgent = { id: 'render-only-agent', async generate() { throw new Error('graph render must not execute tasks'); } };

export default smithers(() => React.createElement(
  Workflow,
  { name: 'real-project-graph' },
  React.createElement(
    Sequence,
    {},
    React.createElement(Task, { id: 'inspect-diff', output: outputs.task, agent: renderOnlyAgent }, 'Inspect diff'),
    React.createElement(Task, { id: 'write-findings', output: outputs.task, agent: renderOnlyAgent, dependsOn: ['inspect-diff'] }, 'Write findings'),
  ),
));
`);
  return projectRoot;
}

describe('project workflow real graph integration', () => {
  it('renders a real Smithers workflow fixture into the viewer graph without executing task agents', async () => {
    const projectRoot = copyFixtureWorkflowProject();
    const legacyRuns = join(projectRoot, 'runs');
    rmSync(legacyRuns, { recursive: true, force: true });
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot,
      workflowId: 'foo',
    });

    const response = await handler(new Request('http://localhost/api/workflows/foo/graph'));

    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; graph: { source?: { kind: string; frameNo?: number }; nodes: Array<{ id: string }> } };
    expect(body.ok).toBe(true);
    expect(body.graph.source).toEqual({ kind: 'smithers', frameNo: 0 });
    expect(body.graph.nodes.map((node) => node.id)).toContain('inspect-diff');
    expect(body.graph.nodes.map((node) => node.id)).toContain('write-findings');
    expect(existsSync(legacyRuns)).toBe(false);
  });
});
