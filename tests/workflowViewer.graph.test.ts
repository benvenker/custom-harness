import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHarnessServerHandler } from "../src/server.js";
import type { GraphSnapshot } from "@smithers-orchestrator/graph";

function tempProject(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeWorkflow(projectRoot: string, id: string) {
  const workflowsDir = join(projectRoot, ".smithers", "workflows");
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(join(workflowsDir, `${id}.tsx`), "export default {}\n");
}

const editableStudioMeta = {
  editor: {
    editable: true,
    fields: {
      prompt: {
        label: "Prompt template",
        kind: "multiline-text",
        sourcePath: ["tasks", "editable-task", "prompt"],
      },
    },
  },
};

function fakeSnapshot(): GraphSnapshot {
  return {
    runId: "fake-render-run",
    frameNo: 0,
    xml: {
      kind: "element",
      tag: "smithers:workflow",
      props: { name: "Fake Workflow" },
      children: [
        {
          kind: "element",
          tag: "smithers:sequence",
          props: {},
          children: [
            {
              kind: "element",
              tag: "smithers:task",
              props: { id: "collect-input" },
              children: [],
            },
            {
              kind: "element",
              tag: "smithers:task",
              props: { id: "write-summary" },
              children: [],
            },
          ],
        },
      ],
    },
    tasks: [
      {
        nodeId: "collect-input",
        label: "Collect Input",
        ordinal: 0,
        prompt: "Collect input",
      },
      {
        nodeId: "write-summary",
        label: "Write Summary",
        ordinal: 1,
        prompt: "Write summary",
        dependsOn: ["collect-input"],
      },
    ],
  } as GraphSnapshot;
}

function fakeControlFlowSnapshot(): GraphSnapshot {
  return {
    runId: "fake-control-flow-run",
    frameNo: 0,
    xml: {
      kind: "element",
      tag: "smithers:workflow",
      props: { name: "Control Flow Workflow" },
      children: [
        {
          kind: "element",
          tag: "smithers:ralph",
          props: { maxIterations: "10", onMaxReached: "return-last" },
          children: [
            {
              kind: "element",
              tag: "smithers:task",
              props: { id: "refinement" },
              children: [],
            },
          ],
        },
        {
          kind: "element",
          tag: "smithers:parallel",
          props: { maxConcurrency: "2" },
          children: [
            {
              kind: "element",
              tag: "smithers:task",
              props: { id: "alt-a" },
              children: [],
            },
            {
              kind: "element",
              tag: "smithers:task",
              props: { id: "alt-b" },
              children: [],
            },
          ],
        },
      ],
    },
    tasks: [
      {
        nodeId: "refinement",
        label: "Plan Refinement Loop",
        ordinal: 0,
        prompt: "Refine plan",
      },
      {
        nodeId: "alt-a",
        label: "Alternative A",
        ordinal: 1,
        prompt: "Alternative A",
        parallelGroupId: "parallel:1",
        parallelMaxConcurrency: 2,
      },
      {
        nodeId: "alt-b",
        label: "Alternative B",
        ordinal: 2,
        prompt: "Alternative B",
        parallelGroupId: "parallel:1",
        parallelMaxConcurrency: 2,
      },
    ],
  } as GraphSnapshot;
}

function fakeMetadataSnapshot(): GraphSnapshot {
  return {
    runId: "fake-render-run",
    frameNo: 0,
    xml: {
      kind: "element",
      tag: "smithers:workflow",
      props: { name: "Metadata Workflow" },
      children: [
        {
          kind: "element",
          tag: "smithers:sequence",
          props: {},
          children: [
            {
              kind: "element",
              tag: "smithers:task",
              props: { id: "editable-task" },
              children: [],
            },
            {
              kind: "element",
              tag: "smithers:task",
              props: { id: "plain-task" },
              children: [],
            },
          ],
        },
      ],
    },
    tasks: [
      {
        nodeId: "editable-task",
        label: "Editable Task",
        ordinal: 0,
        prompt: "Editable prompt",
        meta: editableStudioMeta,
      },
      {
        nodeId: "plain-task",
        label: "Plain Task",
        ordinal: 1,
        prompt: "Plain prompt",
      },
    ],
  } as GraphSnapshot;
}

describe("project workflow graph API", () => {
  it("returns not found for unknown workflow IDs before calling the renderer", async () => {
    const projectRoot = tempProject("custom-harness-workflow-graph-missing-");
    writeWorkflow(projectRoot, "foo");
    let renderCalls = 0;
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot,
      workflowId: "foo",
      renderProjectWorkflowGraph: async () => {
        renderCalls += 1;
        return fakeSnapshot();
      },
    });

    const response = await handler(
      new Request("http://localhost/api/workflows/missing/graph")
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Workflow not found: missing");
    expect(renderCalls).toBe(0);
  });

  it("renders a selected workflow through Smithers graph data without legacy runs artifacts", async () => {
    const projectRoot = tempProject("custom-harness-workflow-graph-");
    writeWorkflow(projectRoot, "foo");
    const calls: Array<{
      projectRoot: string;
      workflowId: string;
      workflowPath: string;
    }> = [];
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot,
      workflowId: "foo",
      renderProjectWorkflowGraph: async (options) => {
        calls.push(options);
        return fakeSnapshot();
      },
    });

    const response = await handler(
      new Request("http://localhost/api/workflows/foo/graph")
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      workflowId: string;
      workflowPath: string;
      graph: {
        source?: { kind: string };
        nodes: Array<{ id: string }>;
        edges: Array<{ from: string; to: string; label?: string }>;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.workflowId).toBe("foo");
    expect(body.workflowPath).toBe(
      join(resolve(projectRoot), ".smithers", "workflows", "foo.tsx")
    );
    expect(body.graph.source).toEqual({ kind: "smithers", frameNo: 0 });
    expect(body.graph.nodes.map((node) => node.id)).toContain("collect-input");
    expect(body.graph.nodes.map((node) => node.id)).toContain("write-summary");
    expect(body.graph.edges).toContainEqual({
      from: "collect-input",
      to: "write-summary",
      label: "",
    });
    expect(body.graph.edges).toContainEqual({
      from: "collect-input",
      to: "write-summary",
      label: "dependsOn",
    });
    expect(calls).toEqual([
      {
        projectRoot: resolve(projectRoot),
        workflowId: "foo",
        workflowPath: join(
          resolve(projectRoot),
          ".smithers",
          "workflows",
          "foo.tsx"
        ),
        input: {},
        outputs: {},
      },
    ]);
    expect(existsSync(join(projectRoot, "runs"))).toBe(false);
    expect(existsSync(join(projectRoot, ".poolside"))).toBe(false);
  });

  it("returns safe control-flow metadata for loop and parallel badges", async () => {
    const projectRoot = tempProject("custom-harness-workflow-control-flow-");
    writeWorkflow(projectRoot, "foo");
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot,
      workflowId: "foo",
      renderProjectWorkflowGraph: async () => fakeControlFlowSnapshot(),
    });

    const response = await handler(
      new Request("http://localhost/api/workflows/foo/graph")
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      graph: {
        nodes: Array<{
          id: string;
          smithers?: {
            kind?: string;
            controlFlow?: Array<{
              kind: string;
              label: string;
              detail?: string;
              maxIterations?: string;
              maxConcurrency?: string;
            }>;
          };
        }>;
      };
    };
    const refinement = body.graph.nodes.find((node) => node.id === "refinement");
    const altA = body.graph.nodes.find((node) => node.id === "alt-a");

    expect(body.ok).toBe(true);
    expect(refinement?.smithers?.controlFlow).toEqual([
      expect.objectContaining({
        kind: "loop",
        label: "LOOP · max 10",
        detail: "maxIterations=10 · onMaxReached=return-last",
        maxIterations: "10",
      }),
    ]);
    expect(altA?.smithers?.controlFlow).toEqual([
      expect.objectContaining({
        kind: "parallel",
        label: "PARALLEL · max 2",
        maxConcurrency: "2",
      }),
    ]);
  });

  it("returns TaskDescriptor meta.editor metadata as structured graph JSON", async () => {
    const projectRoot = tempProject("custom-harness-workflow-graph-meta-");
    writeWorkflow(projectRoot, "foo");
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot,
      workflowId: "foo",
      renderProjectWorkflowGraph: async () => fakeMetadataSnapshot(),
    });

    const response = await handler(
      new Request("http://localhost/api/workflows/foo/graph")
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      graph: {
        nodes: Array<{
          id: string;
          title: string;
          prompt: string;
          smithers?: { meta?: typeof editableStudioMeta };
        }>;
        edges: Array<{ from: string; to: string; label?: string }>;
      };
    };
    const editableNode = body.graph.nodes.find(
      (node) => node.id === "editable-task"
    );
    const plainNode = body.graph.nodes.find((node) => node.id === "plain-task");

    expect(body.ok).toBe(true);
    expect(editableNode?.title).toBe("Editable Task");
    expect(editableNode?.prompt).toBe("Editable prompt");
    expect(editableNode?.smithers?.meta).toEqual(editableStudioMeta);
    expect(
      editableNode?.smithers?.meta?.editor.fields.prompt.sourcePath
    ).toEqual(["tasks", "editable-task", "prompt"]);
    expect(
      Array.isArray(
        editableNode?.smithers?.meta?.editor.fields.prompt.sourcePath
      )
    ).toBe(true);
    expect(plainNode?.title).toBe("Plain Task");
    expect(plainNode?.smithers?.meta).toBeUndefined();
    expect(body.graph.edges).toContainEqual({
      from: "editable-task",
      to: "plain-task",
      label: "",
    });
  });
});
