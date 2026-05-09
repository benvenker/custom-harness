import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

type InspectorNode = {
  id: string;
  type: string;
  title: string;
  prompt: string;
  smithers?: {
    meta?: unknown;
  };
};

type InspectorState = {
  structuredFields: Array<{
    id: string;
    label: string;
    kind: string;
    control: "textarea" | "input" | "select";
    value: string;
    sourcePath: string[];
    destinationLabel: string;
  }>;
  canSaveStructuredEdits: boolean;
  canEditSource: boolean;
  renderedPromptPreview: {
    label: string;
    value: string;
    help: string;
  } | null;
  actions: Array<{
    id: string;
    label: string;
    visible: boolean;
  }>;
  visibleCopy: string[];
};

type BuildStudioInspectorState = (options: {
  mode: "project-workflow" | "run";
  workflowId?: string;
  workflowPath?: string;
  node: InspectorNode;
  sourceValuesByPath?: Record<string, string>;
}) => InspectorState;

type ProjectRunInspectionResult = {
  runId: string;
  finalStatus: string | null;
  polls: number;
  fetchedUrls: string[];
};

type WorkflowRunUiHelper = {
  buildProjectWorkflowRunPayload(
    input: Record<string, unknown>,
    extras?: Record<string, unknown>
  ): Record<string, unknown>;
  isTerminalSmithersRunStatus(status: string | null | undefined): boolean;
  pollProjectRunInspection(options: {
    runId: string;
    inspectionUrl?: string;
    fetch: (input: string, init?: RequestInit) => Promise<Response>;
    setTimeout?: (callback: () => void, delayMs: number) => unknown;
    maxNotFoundRetries?: number;
    intervalMs?: number;
  }): Promise<ProjectRunInspectionResult>;
};

type OverlayRenderNode = InspectorNode & {
  status: string;
  smithers?: {
    nodeId?: string;
    meta?: unknown;
  };
  timeline: unknown[];
};

type OverlayRenderGraph = {
  goal: string;
  path: "workflow";
  reason: string;
  latency: string;
  tokens: string;
  runId: string;
  title: string;
  nodes: OverlayRenderNode[];
  edges: Array<{ from: string; to: string; label?: string }>;
  defaultSelected: string;
};

type SmithersRunDetailFixture = {
  run: {
    runId: string;
    status: string;
    workflowName?: string;
    workflowPath?: string | null;
  };
  nodes: Array<{
    runId: string;
    nodeId: string;
    iteration: number;
    state: string;
    status: string;
    outputTable: string;
    label: string | null;
  }>;
  attempts: Array<{
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    state: string;
    status: string;
    error: unknown;
    responseText?: string | null;
    startedAtMs: number;
    finishedAtMs?: number | null;
  }>;
  events: Array<{
    runId: string;
    seq: number;
    timestampMs: number;
    type: string;
    payload: unknown;
    nodeId: string | null;
    iteration: number | null;
    attempt: number | null;
  }>;
  frames: Array<{
    runId: string;
    frameNo: number;
    createdAtMs: number;
    mountedTaskIds: string[];
    taskIndex: unknown;
    note: string | null;
  }>;
  outputs: Array<{
    runId: string;
    nodeId: string;
    iteration: number;
    outputTable: string;
    row: Record<string, unknown>;
  }>;
  cursors: { nextEventSeq: number | null };
  parseWarnings: unknown[];
  view?: {
    graph?: OverlayRenderGraph;
    graphSource: unknown;
  };
};

type SmithersRunOverlayHelper = {
  buildSmithersRunOverlayState(options: {
    graph: OverlayRenderGraph;
    detail: SmithersRunDetailFixture;
  }): {
    graph: OverlayRenderGraph;
    provenanceLabel: string;
    nodeOverlays: Array<{
      graphNodeId: string;
      nodeId: string;
      selectedIteration: number;
      rawStatus: string;
      rawState: string;
      visualStatus: string;
      source: "smithers-db";
    }>;
    visibleCopy: string[];
  };
  buildSmithersRunInspectorState(options: {
    graph: OverlayRenderGraph;
    detail: SmithersRunDetailFixture;
    selectedGraphNodeId: string;
    liveMode: true;
  }): {
    provenanceLabel: string;
    run: { runId: string; rawStatus: string };
    selectedNode: {
      graphNodeId: string;
      nodeId: string;
      selectedIteration: number;
      rawStatus: string;
      rawState: string;
    } | null;
    attempts: Array<{
      nodeId: string;
      iteration: number;
      attempt: number;
      rawStatus: string;
      errorText: string | null;
    }>;
    outputs: {
      empty: boolean;
      emptyMessage: string | null;
      rows: Array<{
        nodeId: string;
        iteration: number;
        row: Record<string, unknown>;
      }>;
    };
    timeline: Array<{
      seq: number;
      type: string;
      nodeId: string | null;
      source: "smithers-db";
    }>;
    frames: Array<{
      frameNo: number;
      mountedTaskIds: string[];
      kind: "summary";
    }>;
    pretendOutputControls: {
      enabled: boolean;
      mode: "preview-only" | "live";
      help: string;
    };
    visibleCopy: string[];
  };
};

type ProjectRenderedGraphDecision = {
  mode: "preview" | "live" | "live-overlay-error";
  graph: OverlayRenderGraph | null;
  provenance: {
    liveSmithers: boolean;
    label?: string;
    status?: string;
    error?: string;
  };
  visibleCopy: string[];
  error?: string;
};

type ProjectHistoricalRunGraphDecision = {
  mode: "historical-frame" | "historical-unavailable";
  graph: OverlayRenderGraph | null;
  provenance: {
    historicalSmithers: boolean;
    label: string;
    runId: string;
    status: string;
    graphSource: unknown;
    error?: string;
  };
  visibleCopy: string[];
  error?: string;
};

type ProjectLiveStateHelper = {
  deriveProjectRenderedGraph(options: {
    previewGraph: OverlayRenderGraph;
    liveMode?: boolean;
    liveDetail?: SmithersRunDetailFixture | null;
    overlayBuilder?: (options: {
      graph: OverlayRenderGraph;
      detail: SmithersRunDetailFixture;
    }) => {
      graph: OverlayRenderGraph;
      provenanceLabel: string;
      visibleCopy?: string[];
    };
  }): ProjectRenderedGraphDecision;
  deriveHistoricalProjectRunGraph(options: {
    detail: SmithersRunDetailFixture;
    workflowId?: string | null;
  }): ProjectHistoricalRunGraphDecision;
};

async function loadInspectorHelper(): Promise<{
  buildStudioInspectorState: BuildStudioInspectorState;
}> {
  return import("../src/ui/studioInspector.js") as Promise<{
    buildStudioInspectorState: BuildStudioInspectorState;
  }>;
}

async function loadWorkflowRunUiHelper(): Promise<WorkflowRunUiHelper> {
  return import("../src/ui/workflowRunUi.js") as Promise<WorkflowRunUiHelper>;
}

async function loadSmithersRunOverlayHelper(): Promise<SmithersRunOverlayHelper> {
  return import("../src/ui/smithersRunOverlay.js") as Promise<SmithersRunOverlayHelper>;
}

async function loadProjectLiveStateHelper(): Promise<ProjectLiveStateHelper> {
  return import("../src/ui/projectLiveState.js") as Promise<ProjectLiveStateHelper>;
}

function projectInspectorState(
  node: InspectorNode,
  sourceValuesByPath: Record<string, string> = {}
): Promise<InspectorState> {
  return loadInspectorHelper().then(({ buildStudioInspectorState }) =>
    buildStudioInspectorState({
      mode: "project-workflow",
      workflowId: "foo",
      workflowPath: ".smithers/workflows/foo.tsx",
      node,
      sourceValuesByPath,
    })
  );
}

function allVisibleText(value: unknown): string {
  const parts: string[] = [];
  const visit = (item: unknown) => {
    if (typeof item === "string") {
      parts.push(item);
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (item && typeof item === "object") {
      Object.values(item).forEach(visit);
    }
  };
  visit(value);
  return parts.join("\n");
}

function visibleActionLabels(state: InspectorState): string[] {
  return state.actions
    .filter((action) => action.visible)
    .map((action) => action.label);
}

const promptFieldMeta = {
  editor: {
    editable: true,
    fields: {
      prompt: {
        label: "Prompt template",
        kind: "multiline-text",
        sourcePath: ["tasks", "variant-claude", "prompt"],
      },
    },
  },
};

function previewGraphForOverlay(
  nodes: OverlayRenderNode[]
): OverlayRenderGraph {
  return {
    goal: "Inspect Smithers run",
    path: "workflow",
    reason: "preview graph should remain only the visual projection",
    latency: "n/a",
    tokens: "n/a",
    runId: "preview-run",
    title: "Overlay Fixture",
    nodes,
    edges: [],
    defaultSelected: nodes[0]?.id ?? "missing",
  };
}

function previewTaskNode(
  overrides: Partial<OverlayRenderNode> = {}
): OverlayRenderNode {
  return {
    id: "ui-task",
    type: "task",
    title: "Preview Task",
    prompt: "Rendered preview prompt",
    status: "running",
    timeline: [],
    smithers: { nodeId: "smithers-task" },
    ...overrides,
  };
}

function smithersRunDetailFixture(
  overrides: Partial<SmithersRunDetailFixture> = {}
): SmithersRunDetailFixture {
  return {
    run: {
      runId: "live-run",
      status: "finished",
      workflowName: "foo",
      workflowPath: ".smithers/workflows/foo.tsx",
    },
    nodes: [
      {
        runId: "live-run",
        nodeId: "smithers-task",
        iteration: 0,
        state: "finished",
        status: "finished",
        outputTable: "task_output",
        label: "Smithers Task",
      },
    ],
    attempts: [
      {
        runId: "live-run",
        nodeId: "smithers-task",
        iteration: 0,
        attempt: 1,
        state: "failed",
        status: "failed",
        error: { message: "Model timeout" },
        responseText: null,
        startedAtMs: 10,
        finishedAtMs: 20,
      },
    ],
    events: [
      {
        runId: "live-run",
        seq: 5,
        timestampMs: 30,
        type: "node.finished",
        payload: { nodeId: "smithers-task", iteration: 0 },
        nodeId: "smithers-task",
        iteration: 0,
        attempt: 1,
      },
    ],
    frames: [
      {
        runId: "live-run",
        frameNo: 2,
        createdAtMs: 40,
        mountedTaskIds: ["smithers-task"],
        taskIndex: { "smithers-task": { label: "Smithers Task" } },
        note: "latest frame metadata only",
      },
    ],
    outputs: [
      {
        runId: "live-run",
        nodeId: "smithers-task",
        iteration: 0,
        outputTable: "task_output",
        row: { summary: "done" },
      },
    ],
    cursors: { nextEventSeq: 6 },
    parseWarnings: [],
    ...overrides,
  };
}

describe("workflow viewer studio inspector state", () => {
  it("keeps project workflow tasks without studio metadata read-only while exposing rendered prompt preview and source fallback", async () => {
    const state = await projectInspectorState({
      id: "plain-task",
      type: "task",
      title: "Plain Task",
      prompt: "USER REQUEST: Ship the alpha",
    });

    expect(state.structuredFields).toEqual([]);
    expect(state.canSaveStructuredEdits).toBe(false);
    expect(state.canEditSource).toBe(true);
    expect(state.renderedPromptPreview).toEqual({
      label: "Rendered prompt",
      value: "USER REQUEST: Ship the alpha",
      help: "computed from workflow source + preview input",
    });

    const copy = allVisibleText(state);
    expect(copy).toContain("Rendered prompt");
    expect(copy).toContain("computed from workflow source + preview input");
    expect(copy).not.toContain("Temporary override");
    expect(copy).not.toContain("Agent prompt override");
    expect(copy).not.toContain("Prompt template");
    expect(copy).not.toContain("Save to workflow");
    expect(copy).not.toContain("Run with edits");
    expect(visibleActionLabels(state)).not.toContain("Start run with override");
  });

  it("shows a metadata-backed Prompt template textarea from source while keeping rendered prompt preview separate", async () => {
    const sourcePromptTemplate = "USER REQUEST: ${ctx.input.prompt}";
    const state = await projectInspectorState(
      {
        id: "variant-claude",
        type: "task",
        title: "Variant Claude",
        prompt: "USER REQUEST: Ship the alpha",
        smithers: { meta: promptFieldMeta },
      },
      { "tasks.variant-claude.prompt": sourcePromptTemplate }
    );

    const promptField = state.structuredFields.find(
      (field) => field.id === "prompt"
    );
    expect(promptField).toEqual({
      id: "prompt",
      label: "Prompt template",
      kind: "multiline-text",
      control: "textarea",
      value: sourcePromptTemplate,
      sourcePath: ["tasks", "variant-claude", "prompt"],
      destinationLabel:
        ".smithers/workflows/foo.tsx · tasks.variant-claude.prompt",
    });
    expect(state.renderedPromptPreview).toEqual({
      label: "Rendered prompt",
      value: "USER REQUEST: Ship the alpha",
      help: "computed from workflow source + preview input",
    });
    expect(promptField?.value).not.toBe(state.renderedPromptPreview?.value);
    expect(state.canSaveStructuredEdits).toBe(true);
    expect(state.canEditSource).toBe(true);

    const copy = allVisibleText(state);
    expect(copy).toContain("Rendered prompt");
    expect(copy).toContain("USER REQUEST: Ship the alpha");
    expect(copy).toContain("Prompt template");
    expect(copy).toContain("USER REQUEST: ${ctx.input.prompt}");
    expect(copy).toContain(
      ".smithers/workflows/foo.tsx · tasks.variant-claude.prompt"
    );
    expect(copy).not.toContain("Agent prompt override");
    expect(copy).not.toContain("Temporary override");
    expect(copy).not.toContain("Start run with override");

    const actions = visibleActionLabels(state);
    expect(
      actions.some(
        (label) => label === "Save to workflow" || label === "Save as copy"
      )
    ).toBe(true);
    expect(actions).not.toContain("Start run with override");
  });

  it("does not make a project workflow task editable unless studio metadata explicitly enables a supported field", async () => {
    const state = await projectInspectorState(
      {
        id: "variant-claude",
        type: "task",
        title: "Variant Claude",
        prompt: "USER REQUEST: Ship the alpha",
        smithers: {
          meta: {
            editor: {
              fields: {
                prompt: {
                  label: "Prompt template",
                  kind: "multiline-text",
                  sourcePath: ["tasks", "variant-claude", "prompt"],
                },
              },
            },
          },
        },
      },
      { "tasks.variant-claude.prompt": "USER REQUEST: ${ctx.input.prompt}" }
    );

    expect(state.structuredFields).toEqual([]);
    expect(state.canSaveStructuredEdits).toBe(false);
    expect(state.canEditSource).toBe(true);

    const copy = allVisibleText(state);
    expect(copy).toContain("Rendered prompt");
    expect(copy).not.toContain("Prompt template");
    expect(copy).not.toContain("Save to workflow");
    expect(copy).not.toContain("Run with edits");
    expect(copy).not.toContain("Temporary override");
    expect(visibleActionLabels(state)).not.toContain("Start run with override");
  });
});

describe("project workflow live run inspection helpers", () => {
  it("builds a project Start Full Run payload from only saved workflow input", async () => {
    const { buildProjectWorkflowRunPayload } = await loadWorkflowRunUiHelper();

    const payload = buildProjectWorkflowRunPayload(
      { request: "Ship the alpha", prompt: "Ship the alpha" },
      {
        promptOverrides: { task: "temporary override must not ship" },
        outputs: { draft: [{ value: "pretend output must not ship" }] },
        sourceDraft: "export default changedWorkflow",
        structuredDrafts: { prompt: "draft prompt template" },
        runId: "ui-selected-run",
      }
    );

    expect(payload).toEqual({
      input: { request: "Ship the alpha", prompt: "Ship the alpha" },
    });
    expect(Object.keys(payload).sort()).toEqual(["input"]);
    expect(payload).not.toHaveProperty("promptOverrides");
    expect(payload).not.toHaveProperty("outputs");
    expect(payload).not.toHaveProperty("sourceDraft");
    expect(payload).not.toHaveProperty("structuredDrafts");
  });

  it("polls the DB-backed Smithers inspection endpoint after project run launch and never fetches legacy run artifacts", async () => {
    const { pollProjectRunInspection } = await loadWorkflowRunUiHelper();
    const fetchedUrls: string[] = [];
    const fetcher = async (input: string) => {
      fetchedUrls.push(input);
      if (input.includes("/runs/live-run/")) {
        throw new Error(
          `legacy artifact fetch is forbidden in project mode: ${input}`
        );
      }
      return Response.json({
        ok: true,
        detail: { run: { runId: "live-run", status: "finished" } },
      });
    };

    const result = await pollProjectRunInspection({
      runId: "live-run",
      inspectionUrl: "/api/smithers/runs/live-run",
      fetch: fetcher,
      setTimeout: (callback) => callback(),
    });

    expect(result.finalStatus).toBe("finished");
    expect(fetchedUrls).toContain(
      "/api/smithers/runs/live-run?eventsAfterSeq=0&includeOutputs=true"
    );
    expect(
      fetchedUrls.some((url) =>
        /\/runs\/live-run\/(plan\.json|run\.json|events\.jsonl)$/.test(url)
      )
    ).toBe(false);
  });

  it("retries initial 404s from detached-launch races in a bounded way", async () => {
    const { pollProjectRunInspection } = await loadWorkflowRunUiHelper();
    let calls = 0;
    const result = await pollProjectRunInspection({
      runId: "eventual-run",
      fetch: async () => {
        calls += 1;
        if (calls <= 2) {
          return Response.json(
            { ok: false, code: "SMITHERS_RUN_NOT_FOUND" },
            { status: 404 }
          );
        }
        return Response.json({
          ok: true,
          detail: { run: { runId: "eventual-run", status: "running" } },
        });
      },
      setTimeout: (callback) => callback(),
      maxNotFoundRetries: 2,
      intervalMs: 1,
    });

    expect(calls).toBe(3);
    expect(result.finalStatus).toBe("running");
    expect(result.polls).toBe(3);
  });

  it("stops polling on terminal Smithers statuses including British and American cancellation spellings", async () => {
    const { isTerminalSmithersRunStatus, pollProjectRunInspection } =
      await loadWorkflowRunUiHelper();
    expect(
      ["finished", "failed", "cancelled", "canceled"].every((status) =>
        isTerminalSmithersRunStatus(status)
      )
    ).toBe(true);
    expect(isTerminalSmithersRunStatus("running")).toBe(false);

    let calls = 0;
    const result = await pollProjectRunInspection({
      runId: "failed-run",
      fetch: async () => {
        calls += 1;
        return Response.json({
          ok: true,
          detail: { run: { runId: "failed-run", status: "failed" } },
        });
      },
      setTimeout: (callback) => callback(),
    });

    expect(calls).toBe(1);
    expect(result.finalStatus).toBe("failed");
  });

  it("keeps waitForRunToRender out of the project Start Full Run branch", () => {
    const html = readFileSync("web/index.html", "utf8");
    const branchMatch = html.match(
      /if \(currentWorkflowId\) \{(?<body>[\s\S]*?)\n    \}\n\n    if \(!currentRunMeta/
    );
    expect(branchMatch?.groups?.body ?? "").not.toContain(
      "waitForRunToRender("
    );
  });
});

describe("project workflow live render state helpers", () => {
  it("uses the frame-backed view.graph for historical Smithers runs instead of the current preview graph", async () => {
    const { deriveHistoricalProjectRunGraph } = await loadProjectLiveStateHelper();
    const currentPreviewGraph = previewGraphForOverlay([
      previewTaskNode({
        id: "current-source-only",
        title: "Current Source Only",
        prompt: "Current Workflow Source prompt must not appear historically",
        smithers: { nodeId: "current-source-only" },
      }),
    ]);
    const historicalGraph = previewGraphForOverlay([
      previewTaskNode({
        id: "historical-node",
        title: "Persisted Historical Node",
        prompt: "Prompt captured by persisted Run Frame",
        status: "finished",
        smithers: { nodeId: "historical-node" },
      }),
    ]);
    historicalGraph.runId = "historical-run";
    historicalGraph.source = { kind: "smithers", frameNo: 7 };
    const detail = smithersRunDetailFixture({
      run: { runId: "historical-run", status: "finished", workflowName: "foo" },
      nodes: [
        {
          runId: "historical-run",
          nodeId: "historical-node",
          iteration: 0,
          state: "finished",
          status: "finished",
          outputTable: "historical_outputs",
          label: "Persisted Historical Node",
        },
      ],
      view: {
        graph: historicalGraph,
        graphSource: {
          kind: "smithers-frame",
          runId: "historical-run",
          frameNo: 7,
          fallback: false,
        },
      },
    });

    const decision = deriveHistoricalProjectRunGraph({ detail, workflowId: "foo" });

    expect(decision.mode).toBe("historical-frame");
    expect(decision.graph?.runId).toBe("historical-run");
    expect(decision.graph?.source).toEqual(
      expect.objectContaining({
        kind: "smithers",
        frameNo: 7,
        note: expect.stringContaining("historical-run"),
      })
    );
    expect(decision.provenance.label).toContain("Smithers Run Frame");
    expect(decision.provenance.label).toContain("frame 7");
    expect(decision.visibleCopy).toContain("Smithers Run Frame · historical run");
    expect(decision.visibleCopy).toContain("frame 7");
    expect(decision.graph?.nodes.map((node) => node.id)).toContain("historical-node");
    expect(decision.graph?.nodes.map((node) => node.id)).not.toContain("current-source-only");
    expect(JSON.stringify(decision.graph)).not.toContain("Current Workflow Source");
    expect(JSON.stringify(currentPreviewGraph)).toContain("Current Workflow Source");
  });

  it("returns an explicit historical unavailable graph instead of falling back to the preview graph", async () => {
    const { deriveHistoricalProjectRunGraph } = await loadProjectLiveStateHelper();
    const detail = smithersRunDetailFixture({
      run: { runId: "historical-run", status: "finished", workflowName: "foo" },
      view: {
        graphSource: {
          kind: "unavailable",
          runId: "historical-run",
          frameNo: 3,
          fallback: false,
          reason: "Persisted Smithers Run Frame XML is missing or malformed.",
        },
      },
    });

    const decision = deriveHistoricalProjectRunGraph({ detail, workflowId: "foo" });

    expect(decision.mode).toBe("historical-unavailable");
    expect(decision.error).toMatch(/missing|malformed/i);
    expect(decision.graph?.nodes).toEqual([
      expect.objectContaining({
        id: "historical-graph-unavailable",
        title: "Historical graph unavailable",
        prompt: expect.stringContaining("No current Workflow Source graph fallback"),
      }),
    ]);
    expect(decision.provenance.label).toContain("Smithers Run Frame unavailable");
    expect(decision.visibleCopy).toContain("No current Workflow Source graph fallback was used.");
  });

  it("renders a refreshed preview graph through the DB overlay when live Smithers detail exists", async () => {
    const { deriveProjectRenderedGraph } = await loadProjectLiveStateHelper();
    const refreshedPreview = previewGraphForOverlay([
      previewTaskNode({
        id: "ui-task",
        status: "running",
        smithers: { nodeId: "smithers-task" },
      }),
    ]);
    const liveDetail = smithersRunDetailFixture({
      run: {
        runId: "live-run",
        status: "finished",
        workflowName: "foo",
        workflowPath: ".smithers/workflows/foo.tsx",
      },
      nodes: [
        {
          runId: "live-run",
          nodeId: "smithers-task",
          iteration: 0,
          state: "finished",
          status: "finished",
          outputTable: "task_output",
          label: "Smithers Task",
        },
      ],
    });

    const decision = deriveProjectRenderedGraph({
      previewGraph: refreshedPreview,
      liveMode: true,
      liveDetail,
    });

    expect(decision.mode).toBe("live");
    expect(decision.provenance).toEqual(
      expect.objectContaining({
        liveSmithers: true,
        label: "Smithers SQLite · live run",
        status: "finished",
      })
    );
    expect(decision.graph?.runId).toBe("live-run");
    expect(decision.graph?.runStatus).toBe("finished");
    const renderedNode = decision.graph?.nodes.find(
      (node) => node.id === "ui-task"
    );
    expect(renderedNode?.status).toBe("done");
    expect(renderedNode?.smithers).toEqual(
      expect.objectContaining({
        nodeId: "smithers-task",
        rawStatus: "finished",
        rawState: "finished",
        statusSource: "smithers-db",
      })
    );
    expect(decision.visibleCopy).toContain("Smithers SQLite · live run");
    expect(decision.visibleCopy).toContain("raw status: finished");
  });

  it("does not return a raw preview graph under live Smithers provenance when overlaying fails", async () => {
    const { deriveProjectRenderedGraph } = await loadProjectLiveStateHelper();
    const rawPreview = previewGraphForOverlay([
      previewTaskNode({
        id: "ui-task",
        status: "running",
        smithers: { nodeId: "smithers-task" },
      }),
    ]);

    const decision = deriveProjectRenderedGraph({
      previewGraph: rawPreview,
      liveMode: true,
      liveDetail: smithersRunDetailFixture(),
      overlayBuilder: () => {
        throw new Error("overlay exploded");
      },
    });

    expect(decision.mode).toBe("live-overlay-error");
    expect(decision.provenance.liveSmithers).toBe(false);
    expect(decision.provenance.error).toContain("overlay exploded");
    expect(decision.error).toContain("overlay exploded");
    if (decision.graph) {
      expect(
        decision.graph.nodes.find((node) => node.id === "ui-task")?.status
      ).toBe("running");
      expect(decision.provenance.label).not.toBe("Smithers SQLite · live run");
    }
  });
});

describe("project workflow Smithers run overlay helpers", () => {
  it("maps DB node status finished to visual done without trusting preview node status", async () => {
    const { buildSmithersRunOverlayState } =
      await loadSmithersRunOverlayHelper();
    const graph = previewGraphForOverlay([
      previewTaskNode({
        id: "ui-task",
        status: "running",
        smithers: { nodeId: "smithers-task" },
      }),
    ]);
    const detail = smithersRunDetailFixture({
      nodes: [
        {
          runId: "live-run",
          nodeId: "smithers-task",
          iteration: 0,
          state: "finished",
          status: "finished",
          outputTable: "task_output",
          label: "Smithers Task",
        },
      ],
    });

    const state = buildSmithersRunOverlayState({ graph, detail });
    const overlay = state.nodeOverlays.find(
      (node) => node.graphNodeId === "ui-task"
    );

    expect(overlay).toEqual(
      expect.objectContaining({
        graphNodeId: "ui-task",
        nodeId: "smithers-task",
        selectedIteration: 0,
        rawStatus: "finished",
        rawState: "finished",
        visualStatus: "done",
        source: "smithers-db",
      })
    );
    expect(
      state.graph.nodes.find((node) => node.id === "ui-task")?.status
    ).toBe("done");
    expect(state.visibleCopy).toContain("Smithers SQLite · live run");
    expect(state.visibleCopy).toContain("raw status: finished");
  });

  it("matches graph node ids or smithers.nodeId and chooses the latest DB iteration by default", async () => {
    const { buildSmithersRunOverlayState } =
      await loadSmithersRunOverlayHelper();
    const graph = previewGraphForOverlay([
      previewTaskNode({
        id: "plain-matching-id",
        status: "pending",
        smithers: undefined,
      }),
      previewTaskNode({
        id: "ui-wrapper",
        status: "pending",
        smithers: { nodeId: "real-node-id" },
      }),
    ]);
    const detail = smithersRunDetailFixture({
      nodes: [
        {
          runId: "live-run",
          nodeId: "plain-matching-id",
          iteration: 0,
          state: "running",
          status: "running",
          outputTable: "plain_out",
          label: null,
        },
        {
          runId: "live-run",
          nodeId: "real-node-id",
          iteration: 0,
          state: "running",
          status: "running",
          outputTable: "real_out",
          label: null,
        },
        {
          runId: "live-run",
          nodeId: "real-node-id",
          iteration: 2,
          state: "failed",
          status: "failed",
          outputTable: "real_out",
          label: null,
        },
        {
          runId: "live-run",
          nodeId: "real-node-id",
          iteration: 1,
          state: "finished",
          status: "finished",
          outputTable: "real_out",
          label: null,
        },
      ],
    });

    const state = buildSmithersRunOverlayState({ graph, detail });

    expect(state.nodeOverlays).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          graphNodeId: "plain-matching-id",
          nodeId: "plain-matching-id",
          selectedIteration: 0,
          rawStatus: "running",
          visualStatus: "running",
        }),
        expect.objectContaining({
          graphNodeId: "ui-wrapper",
          nodeId: "real-node-id",
          selectedIteration: 2,
          rawStatus: "failed",
          visualStatus: "failed",
        }),
      ])
    );
    expect(
      state.graph.nodes.find((node) => node.id === "ui-wrapper")?.status
    ).toBe("failed");
  });

  it("builds inspector state from Smithers DB run state, attempts, output rows, event timeline, and frame summaries", async () => {
    const { buildSmithersRunInspectorState } =
      await loadSmithersRunOverlayHelper();
    const graph = previewGraphForOverlay([
      previewTaskNode({
        id: "ui-task",
        status: "running",
        outputPreview: "pretend preview output",
        smithers: { nodeId: "smithers-task" },
      } as Partial<OverlayRenderNode>),
    ]);
    const detail = smithersRunDetailFixture();

    const state = buildSmithersRunInspectorState({
      graph,
      detail,
      selectedGraphNodeId: "ui-task",
      liveMode: true,
    });

    expect(state.provenanceLabel).toBe("Smithers SQLite · live run");
    expect(state.run).toEqual(
      expect.objectContaining({ runId: "live-run", rawStatus: "finished" })
    );
    expect(state.selectedNode).toEqual(
      expect.objectContaining({
        graphNodeId: "ui-task",
        nodeId: "smithers-task",
        selectedIteration: 0,
        rawStatus: "finished",
        rawState: "finished",
      })
    );
    expect(state.attempts).toEqual([
      expect.objectContaining({
        nodeId: "smithers-task",
        iteration: 0,
        attempt: 1,
        rawStatus: "failed",
        errorText: expect.stringContaining("Model timeout"),
      }),
    ]);
    expect(state.outputs).toEqual({
      empty: false,
      emptyMessage: null,
      rows: [
        expect.objectContaining({
          nodeId: "smithers-task",
          iteration: 0,
          row: { summary: "done" },
        }),
      ],
    });
    expect(state.timeline).toEqual([
      expect.objectContaining({
        seq: 5,
        type: "node.finished",
        nodeId: "smithers-task",
        source: "smithers-db",
      }),
    ]);
    expect(state.frames).toEqual([
      expect.objectContaining({
        frameNo: 2,
        mountedTaskIds: ["smithers-task"],
        kind: "summary",
      }),
    ]);
    expect(state.frames[0]).not.toHaveProperty("renderGraph");
    expect(state.frames[0]).not.toHaveProperty("nodes");
    expect(state.visibleCopy).toContain("Smithers SQLite · live run");
    expect(state.visibleCopy).toContain("raw run status: finished");
    expect(state.visibleCopy).toContain("raw node status: finished");
    expect(state.visibleCopy).toContain("node.finished");
    expect(state.visibleCopy).toContain("Run output");
  });

  it("shows a clear empty output state for live run nodes without output rows", async () => {
    const { buildSmithersRunInspectorState } =
      await loadSmithersRunOverlayHelper();
    const graph = previewGraphForOverlay([
      previewTaskNode({ id: "ui-task", smithers: { nodeId: "smithers-task" } }),
    ]);
    const detail = smithersRunDetailFixture({ outputs: [] });

    const state = buildSmithersRunInspectorState({
      graph,
      detail,
      selectedGraphNodeId: "ui-task",
      liveMode: true,
    });

    expect(state.outputs).toEqual({
      empty: true,
      emptyMessage: "No Smithers output rows recorded for this node yet.",
      rows: [],
    });
    expect(state.visibleCopy).toContain(
      "No Smithers output rows recorded for this node yet."
    );
  });

  it("marks pretend output controls preview-only during live inspection", async () => {
    const { buildSmithersRunInspectorState } =
      await loadSmithersRunOverlayHelper();
    const graph = previewGraphForOverlay([
      previewTaskNode({
        id: "ui-task",
        outputPreview: "pretend output from preview graph",
        smithers: { nodeId: "smithers-task" },
      } as Partial<OverlayRenderNode>),
    ]);

    const state = buildSmithersRunInspectorState({
      graph,
      detail: smithersRunDetailFixture({ outputs: [] }),
      selectedGraphNodeId: "ui-task",
      liveMode: true,
    });

    expect(state.pretendOutputControls).toEqual({
      enabled: false,
      mode: "preview-only",
      help: "Preview graph output is not live Smithers run state.",
    });
    expect(state.visibleCopy).toContain(
      "Preview graph output is not live Smithers run state."
    );
    expect(allVisibleText(state)).not.toContain(
      "pretend output from preview graph"
    );
  });

  it("uses DB events as the live timeline source and does not expose legacy events.jsonl provenance", async () => {
    const { buildSmithersRunInspectorState } =
      await loadSmithersRunOverlayHelper();
    const graph = previewGraphForOverlay([
      previewTaskNode({ id: "ui-task", smithers: { nodeId: "smithers-task" } }),
    ]);
    const detail = smithersRunDetailFixture({
      events: [
        {
          runId: "live-run",
          seq: 7,
          timestampMs: 50,
          type: "attempt.started",
          payload: { source: "sqlite" },
          nodeId: "smithers-task",
          iteration: 0,
          attempt: 1,
        },
      ],
    });

    const state = buildSmithersRunInspectorState({
      graph,
      detail,
      selectedGraphNodeId: "ui-task",
      liveMode: true,
    });

    expect(state.timeline).toEqual([
      expect.objectContaining({
        seq: 7,
        type: "attempt.started",
        source: "smithers-db",
      }),
    ]);
    expect(allVisibleText(state)).toContain("attempt.started");
    expect(allVisibleText(state)).not.toContain("events.jsonl");
  });
});
