import { describe, expect, it } from "bun:test";
import type {
  GraphSnapshot,
  TaskDescriptor,
  XmlNode,
} from "@smithers-orchestrator/graph";
import { smithersSnapshotToRenderGraph } from "../src/runs/smithersGraph.js";

function task(
  nodeId: string,
  overrides: Partial<TaskDescriptor> = {}
): TaskDescriptor {
  return {
    nodeId,
    ordinal: overrides.ordinal ?? 0,
    iteration: 0,
    outputTable: null,
    outputTableName: "task",
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

function el(
  tag: string,
  props: Record<string, string>,
  children: XmlNode[] = []
): XmlNode {
  return { kind: "element", tag, props, children };
}

function text(value: string): XmlNode {
  return { kind: "text", text: value };
}

function snapshot(xml: XmlNode, tasks: TaskDescriptor[]): GraphSnapshot {
  return { runId: "graph-test", frameNo: 1, xml, tasks };
}

const graphMeta = {
  goal: "visualize native Smithers",
  path: "workflow" as const,
  reason: "test graph",
  runId: "graph-test",
  planningLatencyMs: 12,
  tokens: null,
  submittedAt: new Date("2026-05-06T00:00:00.000Z"),
};

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

describe("Smithers graph snapshot mapper", () => {
  it("maps Workflow -> Sequence -> Task -> Task into an ordered vertical graph", () => {
    const graph = smithersSnapshotToRenderGraph({
      snapshot: snapshot(
        el("smithers:workflow", { name: "ordered" }, [
          el("smithers:sequence", {}, [
            el("smithers:task", { id: "first" }, [text("First prompt")]),
            el("smithers:task", { id: "second" }, [text("Second prompt")]),
          ]),
        ]),
        [task("first", { ordinal: 0 }), task("second", { ordinal: 1 })]
      ),
      ...graphMeta,
    });

    expect(graph.nodes.map((node) => node.id)).toEqual([
      "goal",
      "first",
      "second",
    ]);
    expect(graph.nodes.find((node) => node.id === "first")?.y).toBeLessThan(
      graph.nodes.find((node) => node.id === "second")?.y ?? 0
    );
    expect(graph.edges).toContainEqual({
      from: "goal",
      to: "first",
      label: "",
    });
    expect(graph.edges).toContainEqual({
      from: "first",
      to: "second",
      label: "",
    });
  });

  it("maps Sequence -> Parallel(Task, Task) -> Task into split and converge edges from Smithers xml", () => {
    const graph = smithersSnapshotToRenderGraph({
      snapshot: snapshot(
        el("smithers:workflow", { name: "split-converge" }, [
          el("smithers:sequence", {}, [
            el("smithers:task", { id: "plan" }, [text("Plan prompt")]),
            el("smithers:parallel", {}, [
              el("smithers:task", { id: "left" }, [text("Left prompt")]),
              el("smithers:task", { id: "right" }, [text("Right prompt")]),
            ]),
            el("smithers:task", { id: "done" }, [text("Done prompt")]),
          ]),
        ]),
        [
          task("plan", { ordinal: 0 }),
          task("left", { ordinal: 1 }),
          task("right", { ordinal: 2 }),
          task("done", { ordinal: 3 }),
        ]
      ),
      ...graphMeta,
    });

    expect(graph.nodes.map((node) => node.id)).toEqual([
      "goal",
      "plan",
      "left",
      "right",
      "done",
    ]);
    expect(graph.edges).toContainEqual({
      from: "plan",
      to: "left",
      label: "parallel",
    });
    expect(graph.edges).toContainEqual({
      from: "plan",
      to: "right",
      label: "",
    });
    expect(graph.edges).toContainEqual({
      from: "left",
      to: "done",
      label: "barrier",
    });
    expect(graph.edges).toContainEqual({
      from: "right",
      to: "done",
      label: "",
    });
  });

  it("adds TaskDescriptor.dependsOn edges when xml nesting alone is insufficient", () => {
    const graph = smithersSnapshotToRenderGraph({
      snapshot: snapshot(
        el("smithers:workflow", { name: "descriptor-deps" }, [
          el("smithers:parallel", {}, [
            el("smithers:task", { id: "producer" }, [text("Producer")]),
            el("smithers:task", { id: "consumer" }, [text("Consumer")]),
          ]),
        ]),
        [
          task("producer", { ordinal: 0 }),
          task("consumer", { ordinal: 1, dependsOn: ["producer"] }),
        ]
      ),
      ...graphMeta,
    });

    expect(graph.edges).toContainEqual({
      from: "producer",
      to: "consumer",
      label: "dependsOn",
    });
  });

  it("preserves TaskDescriptor meta.editor as structured Smithers node metadata", () => {
    const graph = smithersSnapshotToRenderGraph({
      snapshot: snapshot(
        el("smithers:workflow", { name: "metadata" }, [
          el("smithers:sequence", {}, [
            el("smithers:task", { id: "editable-task" }, [
              text("Editable prompt"),
            ]),
            el("smithers:task", { id: "plain-task" }, [text("Plain prompt")]),
          ]),
        ]),
        [
          task("editable-task", {
            ordinal: 0,
            label: "Editable Task",
            prompt: "Editable prompt from descriptor",
            meta: editableStudioMeta,
          }),
          task("plain-task", {
            ordinal: 1,
            label: "Plain Task",
            prompt: "Plain prompt from descriptor",
          }),
        ]
      ),
      ...graphMeta,
    });

    const editableNode = graph.nodes.find(
      (node) => node.id === "editable-task"
    );
    const plainNode = graph.nodes.find((node) => node.id === "plain-task");

    expect(editableNode?.title).toBe("Editable Task");
    expect(editableNode?.prompt).toBe("Editable prompt from descriptor");
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
    expect(graph.edges).toContainEqual({
      from: "editable-task",
      to: "plain-task",
      label: "",
    });
  });

  it("preserves non-task Smithers host nodes that are not reduced to layout containers", () => {
    const graph = smithersSnapshotToRenderGraph({
      snapshot: snapshot(
        el("smithers:workflow", { name: "host-nodes" }, [
          el("smithers:branch", { id: "choose-path" }, [
            el("smithers:loop", { id: "repeat-until-done", maxIterations: "5" }, [
              el("smithers:worktree", { id: "feature-worktree" }, [
                el("smithers:task", { id: "inside" }, [text("Inside prompt")]),
              ]),
            ]),
          ]),
        ]),
        [task("inside", { ordinal: 0 })]
      ),
      ...graphMeta,
    });

    expect(
      graph.nodes.find((node) => node.id === "choose-path")?.smithers?.kind
    ).toBe("branch");
    expect(
      graph.nodes.find((node) => node.id === "repeat-until-done")?.smithers
        ?.kind
    ).toBe("loop");
    expect(
      graph.nodes.find((node) => node.id === "repeat-until-done")?.smithers
        ?.controlFlow
    ).toEqual([
      expect.objectContaining({ kind: "branch", label: "BRANCH" }),
      expect.objectContaining({ kind: "loop", label: "LOOP · max 5" }),
    ]);
    expect(
      graph.nodes.find((node) => node.id === "feature-worktree")?.smithers?.kind
    ).toBe("worktree");
    expect(
      graph.nodes.find((node) => node.id === "inside")?.smithers?.controlFlow
    ).toEqual([
      expect.objectContaining({ kind: "branch", label: "BRANCH" }),
      expect.objectContaining({ kind: "loop", label: "LOOP · max 5" }),
    ]);
    expect(graph.edges).toContainEqual({
      from: "feature-worktree",
      to: "inside",
      label: "",
    });
  });

  it("annotates tasks inside Smithers ralph/Loop and Parallel control-flow containers", () => {
    const graph = smithersSnapshotToRenderGraph({
      snapshot: snapshot(
        el("smithers:workflow", { name: "control-flow" }, [
          el(
            "smithers:ralph",
            { maxIterations: "10", onMaxReached: "return-last" },
            [el("smithers:task", { id: "refine" }, [text("Refine")])]
          ),
          el("smithers:parallel", { maxConcurrency: "2" }, [
            el("smithers:task", { id: "left" }, [text("Left")]),
            el("smithers:task", { id: "right" }, [text("Right")]),
          ]),
        ]),
        [
          task("refine", { ordinal: 0 }),
          task("left", {
            ordinal: 1,
            parallelGroupId: "parallel:1",
            parallelMaxConcurrency: 2,
          }),
          task("right", {
            ordinal: 2,
            parallelGroupId: "parallel:1",
            parallelMaxConcurrency: 2,
          }),
        ]
      ),
      ...graphMeta,
    });

    expect(graph.nodes.find((node) => node.id === "loop-0")?.smithers).toEqual(
      expect.objectContaining({
        kind: "loop",
        controlFlow: [
          expect.objectContaining({
            kind: "loop",
            label: "LOOP · max 10",
            maxIterations: "10",
            onMaxReached: "return-last",
          }),
        ],
      })
    );
    expect(graph.nodes.find((node) => node.id === "refine")?.smithers?.controlFlow).toEqual([
      expect.objectContaining({
        kind: "loop",
        label: "LOOP · max 10",
        detail: "maxIterations=10 · onMaxReached=return-last",
      }),
    ]);
    expect(graph.nodes.find((node) => node.id === "left")?.smithers?.controlFlow).toEqual([
      expect.objectContaining({
        kind: "parallel",
        label: "PARALLEL · max 2",
        maxConcurrency: "2",
      }),
    ]);
    expect(graph.nodes.find((node) => node.id === "right")?.smithers?.controlFlow).toEqual([
      expect.objectContaining({ kind: "parallel", label: "PARALLEL · max 2" }),
    ]);
  });
});
