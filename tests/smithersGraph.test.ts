import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { Effect } from 'effect';
import { z } from 'zod';
import { createSmithers } from 'smithers-orchestrator';
import { renderFrame } from '@smithers-orchestrator/engine';
import { SmithersCtx } from '@smithers-orchestrator/driver/SmithersCtx';
import type { GraphSnapshot, TaskDescriptor, XmlNode } from '@smithers-orchestrator/graph';
import { smithersSnapshotToRenderGraph } from '../src/runs/smithersGraph.js';
import { createRunRecorder } from '../src/runs/recorder.js';

function task(nodeId: string, overrides: Partial<TaskDescriptor> = {}): TaskDescriptor {
  return {
    nodeId,
    ordinal: overrides.ordinal ?? 0,
    iteration: 0,
    outputTable: null,
    outputTableName: 'task',
    needsApproval: false,
    skipIf: false,
    retries: 0,
    timeoutMs: null,
    heartbeatTimeoutMs: null,
    continueOnFail: false,
    prompt: `${nodeId} prompt`,
    ...overrides,
  };
}

function el(tag: string, props: Record<string, string>, children: XmlNode[] = []): XmlNode {
  return { kind: 'element', tag, props, children };
}

function text(value: string): XmlNode {
  return { kind: 'text', text: value };
}

function snapshot(xml: XmlNode, tasks: TaskDescriptor[]): GraphSnapshot {
  return { runId: 'graph-test', frameNo: 1, xml, tasks };
}

const graphMeta = {
  goal: 'visualize native Smithers',
  path: 'workflow' as const,
  reason: 'test graph',
  runId: 'graph-test',
  planningLatencyMs: 12,
  tokens: null,
  submittedAt: new Date('2026-05-06T00:00:00.000Z'),
};

describe('Smithers graph snapshot mapper', () => {
  it('maps Workflow -> Sequence -> Task -> Task into an ordered vertical graph', () => {
    const graph = smithersSnapshotToRenderGraph({
      snapshot: snapshot(
        el('smithers:workflow', { name: 'ordered' }, [
          el('smithers:sequence', {}, [
            el('smithers:task', { id: 'first' }, [text('First prompt')]),
            el('smithers:task', { id: 'second' }, [text('Second prompt')]),
          ]),
        ]),
        [task('first', { ordinal: 0 }), task('second', { ordinal: 1 })],
      ),
      ...graphMeta,
    });

    expect(graph.nodes.map((node) => node.id)).toEqual(['goal', 'first', 'second']);
    expect(graph.nodes.find((node) => node.id === 'first')?.y).toBeLessThan(
      graph.nodes.find((node) => node.id === 'second')?.y ?? 0,
    );
    expect(graph.edges).toContainEqual({ from: 'goal', to: 'first', label: '' });
    expect(graph.edges).toContainEqual({ from: 'first', to: 'second', label: '' });
  });

  it('maps Sequence -> Parallel(Task, Task) -> Task into split and converge edges from Smithers xml', () => {
    const graph = smithersSnapshotToRenderGraph({
      snapshot: snapshot(
        el('smithers:workflow', { name: 'split-converge' }, [
          el('smithers:sequence', {}, [
            el('smithers:task', { id: 'plan' }, [text('Plan prompt')]),
            el('smithers:parallel', {}, [
              el('smithers:task', { id: 'left' }, [text('Left prompt')]),
              el('smithers:task', { id: 'right' }, [text('Right prompt')]),
            ]),
            el('smithers:task', { id: 'done' }, [text('Done prompt')]),
          ]),
        ]),
        [task('plan', { ordinal: 0 }), task('left', { ordinal: 1 }), task('right', { ordinal: 2 }), task('done', { ordinal: 3 })],
      ),
      ...graphMeta,
    });

    expect(graph.nodes.map((node) => node.id)).toEqual(['goal', 'plan', 'left', 'right', 'done']);
    expect(graph.edges).toContainEqual({ from: 'plan', to: 'left', label: 'parallel' });
    expect(graph.edges).toContainEqual({ from: 'plan', to: 'right', label: '' });
    expect(graph.edges).toContainEqual({ from: 'left', to: 'done', label: 'barrier' });
    expect(graph.edges).toContainEqual({ from: 'right', to: 'done', label: '' });
  });

  it('adds TaskDescriptor.dependsOn edges when xml nesting alone is insufficient', () => {
    const graph = smithersSnapshotToRenderGraph({
      snapshot: snapshot(
        el('smithers:workflow', { name: 'descriptor-deps' }, [
          el('smithers:parallel', {}, [
            el('smithers:task', { id: 'producer' }, [text('Producer')]),
            el('smithers:task', { id: 'consumer' }, [text('Consumer')]),
          ]),
        ]),
        [task('producer', { ordinal: 0 }), task('consumer', { ordinal: 1, dependsOn: ['producer'] })],
      ),
      ...graphMeta,
    });

    expect(graph.edges).toContainEqual({ from: 'producer', to: 'consumer', label: 'dependsOn' });
  });

  it('preserves non-task Smithers host nodes that are not reduced to layout containers', () => {
    const graph = smithersSnapshotToRenderGraph({
      snapshot: snapshot(
        el('smithers:workflow', { name: 'host-nodes' }, [
          el('smithers:branch', { id: 'choose-path' }, [
            el('smithers:loop', { id: 'repeat-until-done' }, [
              el('smithers:worktree', { id: 'feature-worktree' }, [
                el('smithers:task', { id: 'inside' }, [text('Inside prompt')]),
              ]),
            ]),
          ]),
        ]),
        [task('inside', { ordinal: 0 })],
      ),
      ...graphMeta,
    });

    expect(graph.nodes.find((node) => node.id === 'choose-path')?.smithers?.kind).toBe('branch');
    expect(graph.nodes.find((node) => node.id === 'repeat-until-done')?.smithers?.kind).toBe('loop');
    expect(graph.nodes.find((node) => node.id === 'feature-worktree')?.smithers?.kind).toBe('worktree');
    expect(graph.edges).toContainEqual({ from: 'feature-worktree', to: 'inside', label: '' });
  });

  it('writes plan.json from a real renderFrame snapshot without depending on the planner workflow DSL layout', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'custom-harness-smithers-graph-'));
    const recorder = createRunRecorder('frame-plan-test', { goal: 'frame graph' }, { runsDir });
    const schemas = { task: z.object({ result: z.string() }) };
    const { Workflow, Task, Sequence, Parallel, smithers, outputs } = createSmithers(schemas);
    const agent = { id: 'fake-agent', generate: async () => ({ text: JSON.stringify({ result: 'ok' }) }) };
    const workflow = smithers(() =>
      React.createElement(
        Workflow,
        { name: 'native-frame' },
        React.createElement(
          Sequence,
          {},
          React.createElement(Task, { id: 'plan', output: outputs.task, agent }, 'Plan prompt'),
          React.createElement(
            Parallel,
            {},
            React.createElement(Task, { id: 'left', output: outputs.task, agent }, 'Left prompt'),
            React.createElement(Task, { id: 'right', output: outputs.task, agent }, 'Right prompt'),
          ),
        ),
      ),
    );
    const ctx = new SmithersCtx({
      runId: 'frame-plan-test',
      iteration: 0,
      input: {},
      outputs: {},
      zodToKeyName: workflow.zodToKeyName,
    });
    const frame = await Effect.runPromise(renderFrame(workflow, ctx));

    recorder.writePlan({
      path: 'workflow',
      reason: 'native graph',
      workflow: {
        name: 'legacy-should-not-drive-graph',
        description: 'This fallback shape should not be used once a frame exists.',
        root: { type: 'task', name: 'Legacy Only', prompt: 'legacy prompt' },
      },
    });
    recorder.writeSmithersGraphSnapshot(frame);

    const planJson = JSON.parse(readFileSync(join(runsDir, 'frame-plan-test', 'plan.json'), 'utf8'));
    expect(planJson.graph.source).toEqual({ kind: 'smithers', frameNo: 0 });
    expect(planJson.graph.nodes.map((node: { id: string }) => node.id)).toContain('left');
    expect(planJson.graph.nodes.map((node: { id: string }) => node.id)).not.toContain('legacy-only');
    expect(planJson.graph.edges).toContainEqual({ from: 'plan', to: 'left', label: 'parallel' });
  });
});
