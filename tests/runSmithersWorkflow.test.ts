import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import React from 'react';
import { applyWorkflowOverrides, runSmithersWorkflow } from '../src/app/runSmithersWorkflow.js';
import type { AgentLike } from '../src/app/runOutcome.js';

function tempRunsDir() {
  return mkdtempSync(join(tmpdir(), 'custom-harness-smithers-rerun-'));
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('runSmithersWorkflow', () => {
  it('executes an exported Smithers workflow and writes UI-compatible artifacts', async () => {
    const runsDir = tempRunsDir();
    const workflowPath = resolve('tests/fixtures/executableSmithersWorkflow.tsx');
    const runId = `smithers-exec-${crypto.randomUUID()}`;

    const result = await runSmithersWorkflow({
      workflowPath,
      input: { prompt: 'Review current diff' },
      goal: 'Review current diff',
      context: 'direct helper test',
      runId,
      runsDir,
    });

    const runDir = join(runsDir, runId);
    const runJson = readJson(join(runDir, 'run.json'));
    const planJson = readJson(join(runDir, 'plan.json'));
    const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8');

    expect(result.status).toBe('succeeded');
    expect(result.path).toBe('workflow');
    expect(runJson.status).toBe('succeeded');
    expect(runJson.path).toBe('workflow');
    expect(planJson.raw.source).toEqual({
      kind: 'smithers',
      workflowPath,
      input: { prompt: 'Review current diff' },
      context: 'direct helper test',
    });
    expect(planJson.graph.source).toEqual({ kind: 'smithers', frameNo: 0 });
    expect(planJson.graph.nodes.map((node: { id: string }) => node.id)).toContain('execute-prompt');
    expect(events).toContain('"type":"task.started"');
    expect(events).toContain('"type":"task.done"');
    expect(existsSync(join(runDir, 'artifacts', 'cli.log'))).toBe(true);
    expect(existsSync(join(runDir, 'smithers', 'executions', 'stream.ndjson'))).toBe(true);
  });

  it('applies prompt overrides per Task id and rerenders the workflow', async () => {
    const runsDir = tempRunsDir();
    const workflowPath = resolve('tests/fixtures/executableSmithersWorkflow.tsx');
    const runId = `smithers-override-${crypto.randomUUID()}`;

    const result = await runSmithersWorkflow({
      workflowPath,
      input: { prompt: 'Original prompt from input' },
      goal: 'override-test',
      runId,
      runsDir,
      promptOverrides: { 'execute-prompt': 'OVERRIDDEN_PROMPT_TEXT' },
    });

    const runDir = join(runsDir, runId);
    const planJson = readJson(join(runDir, 'plan.json'));
    const runJson = readJson(join(runDir, 'run.json'));
    const workerOutput = readFileSync(join(runDir, 'artifacts', 'execute-prompt.txt'), 'utf8');

    expect(result.status).toBe('succeeded');
    expect(planJson.raw.source.promptOverrides).toEqual({ 'execute-prompt': 'OVERRIDDEN_PROMPT_TEXT' });
    expect(runJson.overrides).toEqual({ promptOverrides: { 'execute-prompt': 'OVERRIDDEN_PROMPT_TEXT' } });
    // The fixture's agent echoes the rendered prompt; if the override applied,
    // the artifact must contain OVERRIDDEN_PROMPT_TEXT instead of the original.
    expect(workerOutput).toContain('OVERRIDDEN_PROMPT_TEXT');
    expect(workerOutput).not.toContain('Original prompt from input');
  });

  it('persists forkedFrom on run.json when set on the options', async () => {
    const runsDir = tempRunsDir();
    const workflowPath = resolve('tests/fixtures/executableSmithersWorkflow.tsx');
    const runId = `smithers-fork-${crypto.randomUUID()}`;

    await runSmithersWorkflow({
      workflowPath,
      input: { prompt: 'fork test' },
      runId,
      runsDir,
      forkedFrom: 'parent-run-id',
    });

    const runJson = readJson(join(runsDir, runId, 'run.json'));
    expect(runJson.forkedFrom).toBe('parent-run-id');
  });

  it('does not layer override walkers when the same workflow module is re-run', async () => {
    const runsDir = tempRunsDir();
    const workflowPath = resolve('tests/fixtures/executableSmithersWorkflow.tsx');

    const first = `smithers-rerun-a-${crypto.randomUUID()}`;
    await runSmithersWorkflow({
      workflowPath,
      input: { prompt: 'first' },
      runId: first,
      runsDir,
      promptOverrides: { 'execute-prompt': 'FIRST_OVERRIDE' },
    });

    const second = `smithers-rerun-b-${crypto.randomUUID()}`;
    await runSmithersWorkflow({
      workflowPath,
      input: { prompt: 'second' },
      runId: second,
      runsDir,
      promptOverrides: { 'execute-prompt': 'SECOND_OVERRIDE' },
    });

    const third = `smithers-rerun-c-${crypto.randomUUID()}`;
    // No override this time — should fall back to the original prompt rendered from input.
    await runSmithersWorkflow({
      workflowPath,
      input: { prompt: 'third' },
      runId: third,
      runsDir,
    });

    const firstArtifact = readFileSync(join(runsDir, first, 'artifacts', 'execute-prompt.txt'), 'utf8');
    const secondArtifact = readFileSync(join(runsDir, second, 'artifacts', 'execute-prompt.txt'), 'utf8');
    const thirdArtifact = readFileSync(join(runsDir, third, 'artifacts', 'execute-prompt.txt'), 'utf8');

    expect(firstArtifact).toContain('FIRST_OVERRIDE');
    expect(secondArtifact).toContain('SECOND_OVERRIDE');
    expect(secondArtifact).not.toContain('FIRST_OVERRIDE');
    expect(thirdArtifact).toContain('Prompt: third');
    expect(thirdArtifact).not.toContain('OVERRIDE');
  });

  it('replaces matching Task children via applyWorkflowOverrides without touching siblings', () => {
    const fakeAgent: AgentLike = { async generate() { return { text: '' }; } };
    const Task = (props: { id: string; children?: unknown }) =>
      React.createElement('div', { 'data-id': props.id }, props.children as React.ReactNode);
    const Sequence = (props: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, props.children);

    const tree = () => React.createElement(
      Sequence,
      null,
      React.createElement(Task, { id: 'first', children: 'original first' }),
      React.createElement(Task, { id: 'second', children: 'original second' }),
    );

    const fakeWorkflow = { build: tree };
    applyWorkflowOverrides(fakeWorkflow as never, {
      fallbackAgent: fakeAgent,
      promptOverrides: { first: 'PATCHED_FIRST' },
    });

    const rendered = (fakeWorkflow as { build: (ctx: unknown) => React.ReactElement }).build({}) as React.ReactElement;
    const children = React.Children.toArray((rendered.props as { children?: React.ReactNode }).children) as React.ReactElement[];
    expect((children[0]?.props as { children?: unknown }).children).toBe('PATCHED_FIRST');
    expect((children[1]?.props as { children?: unknown }).children).toBe('original second');
  });

  it('executes Smithers task agent placeholders through the fallback agent', async () => {
    const runsDir = tempRunsDir();
    const workflowPath = resolve('tests/fixtures/placeholderAgentSmithersWorkflow.tsx');
    const runId = `smithers-placeholder-${crypto.randomUUID()}`;
    const fallbackAgent: AgentLike = {
      async generate(options) {
        options.onStdout?.('fallback ran');
        return { text: JSON.stringify({ result: `fallback result for ${String(options.prompt ?? '')}` }) };
      },
    };

    const result = await runSmithersWorkflow({
      workflowPath,
      input: { prompt: 'Use fallback' },
      runId,
      runsDir,
      fallbackAgent,
    });

    const runDir = join(runsDir, runId);
    const planJson = readJson(join(runDir, 'plan.json'));
    const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8');

    expect(result.status).toBe('succeeded');
    expect(planJson.graph.nodes.find((node: { id: string }) => node.id === 'placeholder-task')?.outputArtifact).toBe(
      'artifacts/placeholder-task.txt',
    );
    expect(readFileSync(join(runDir, 'artifacts', 'placeholder-task.txt'), 'utf8')).toContain('fallback ran');
    expect(events).toContain('"type":"task.done"');
  });
});
