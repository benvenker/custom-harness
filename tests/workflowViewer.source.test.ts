import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHarnessServerHandler } from '../src/server.js';
import { loadWorkflow } from '../src/app/smithersRuntime.js';

function tempProject(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeWorkflow(projectRoot: string, id: string, source: string) {
  const workflowsDir = join(projectRoot, '.smithers', 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  const path = join(workflowsDir, `${id}.tsx`);
  writeFileSync(path, source);
  return path;
}

describe('Smithers workflow runtime loader', () => {
  it('reloads edited workflow modules instead of reusing stale dynamic-import cache', async () => {
    const projectRoot = tempProject('custom-harness-workflow-cache-bust-');
    const workflowPath = writeWorkflow(projectRoot, 'foo', `
      const marker = 'before';
      export default { marker, zodToKeyName: new Map() };
    `);

    const before = await loadWorkflow(workflowPath) as { marker?: string };
    writeFileSync(workflowPath, `
      const marker = 'after';
      export default { marker, zodToKeyName: new Map() };
    `);
    const after = await loadWorkflow(workflowPath) as { marker?: string };

    expect(before.marker).toBe('before');
    expect(after.marker).toBe('after');
  });
});

describe('project workflow source API', () => {
  it('returns the selected workflow source for editing', async () => {
    const projectRoot = tempProject('custom-harness-workflow-source-');
    const source = 'export default { name: "before" }\n';
    const workflowPath = writeWorkflow(projectRoot, 'foo', source);
    const handler = createHarnessServerHandler({ rootDir: process.cwd(), projectRoot, workflowId: 'foo' });

    const response = await handler(new Request('http://localhost/api/workflows/foo/source'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      workflowId: 'foo',
      workflowPath: join(resolve(projectRoot), '.smithers', 'workflows', 'foo.tsx'),
      source,
    });
    expect(workflowPath).toBe(join(resolve(projectRoot), '.smithers', 'workflows', 'foo.tsx'));
  });

  it('saves edited workflow source back to the Smithers workflow file', async () => {
    const projectRoot = tempProject('custom-harness-workflow-source-save-');
    const workflowPath = writeWorkflow(projectRoot, 'foo', 'export default { name: "before" }\n');
    const handler = createHarnessServerHandler({ rootDir: process.cwd(), projectRoot, workflowId: 'foo' });
    const nextSource = 'export default { name: "after" }\n';

    const response = await handler(new Request('http://localhost/api/workflows/foo/source', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: nextSource }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      workflowId: 'foo',
      workflowPath,
    });
    expect(readFileSync(workflowPath, 'utf8')).toBe(nextSource);
  });
});
