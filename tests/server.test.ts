import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { createHarnessServerHandler } from "../src/server.js";
import type {
  SmithersRunDetail,
  SmithersRunEventsResult,
  SmithersRunReader,
  SmithersRunSummary,
} from "../src/smithersProject/runReaderTypes.js";

function tempRunsDir() {
  return mkdtempSync(join(tmpdir(), "custom-harness-server-runs-"));
}

function smithersRunSummary(
  overrides: Partial<SmithersRunSummary> = {}
): SmithersRunSummary {
  return {
    runId: "smithers-run-true",
    parentRunId: null,
    workflowName: "truth-workflow",
    workflowPath: "/project/.smithers/workflows/truth-workflow.tsx",
    workflowHash: "hash-true",
    status: "running",
    createdAtMs: 1000,
    startedAtMs: 1001,
    finishedAtMs: null,
    heartbeatAtMs: 1002,
    runtimeOwnerId: "owner-true",
    errorJson: null,
    error: null,
    configJson: '{"source":"reader"}',
    config: { source: "reader" },
    ...overrides,
  };
}

function smithersRunDetail(
  overrides: Partial<SmithersRunDetail> = {}
): SmithersRunDetail {
  const run = overrides.run ?? smithersRunSummary();
  const readerFrameXml = smithersWorkflowXml("reader-workflow", [
    smithersTaskXml("reader-node", "Reader node"),
  ]);
  return {
    run,
    nodes: [
      {
        runId: run.runId,
        nodeId: "reader-node",
        iteration: 0,
        state: "running",
        status: "running",
        lastAttempt: 1,
        updatedAtMs: 1010,
        outputTable: "reader_outputs",
        label: "Reader node",
      },
    ],
    attempts: [],
    events: [
      {
        runId: run.runId,
        seq: 7,
        timestampMs: 1020,
        type: "reader.event",
        payloadJson: '{"nodeId":"reader-node"}',
        payload: { nodeId: "reader-node" },
        nodeId: "reader-node",
        iteration: null,
        attempt: null,
      },
    ],
    frames: [
      {
        runId: run.runId,
        frameNo: 3,
        createdAtMs: 1030,
        xmlHash: "xml-hash-true",
        encoding: "json",
        xmlJson: JSON.stringify(readerFrameXml),
        xml: readerFrameXml,
        mountedTaskIdsJson: '["reader-node"]',
        mountedTaskIds: ["reader-node"],
        taskIndexJson:
          '{"reader-node":{"nodeId":"reader-node","label":"Reader node"}}',
        taskIndex: {
          "reader-node": { nodeId: "reader-node", label: "Reader node" },
        },
        note: "from fake reader",
      },
    ],
    outputs: [],
    cursors: { nextEventSeq: 8 },
    parseWarnings: [],
    ...overrides,
  };
}

function smithersEventsResult(
  overrides: Partial<SmithersRunEventsResult> = {}
): SmithersRunEventsResult {
  return {
    events: [
      {
        runId: "smithers-run-true",
        seq: 11,
        timestampMs: 1040,
        type: "reader.events-endpoint",
        payloadJson: '{"source":"reader-events"}',
        payload: { source: "reader-events" },
        nodeId: null,
        iteration: null,
        attempt: null,
      },
    ],
    cursors: { nextEventSeq: 12 },
    ...overrides,
  };
}

function fakeSmithersRunReader(
  options: {
    runs?: SmithersRunSummary[];
    detail?: SmithersRunDetail | null;
    events?: SmithersRunEventsResult;
    onListRuns?: (options: unknown) => void;
    onGetRunDetail?: (runId: string, options: unknown) => void;
    onListEvents?: (runId: string, options: unknown) => void;
    onClose?: () => void;
  } = {}
): SmithersRunReader {
  return {
    async listRuns(listOptions) {
      options.onListRuns?.(listOptions);
      return options.runs ?? [smithersRunSummary()];
    },
    async getRunDetail(runId, detailOptions) {
      options.onGetRunDetail?.(runId, detailOptions);
      return options.detail === undefined
        ? smithersRunDetail({ run: smithersRunSummary({ runId }) })
        : options.detail;
    },
    async listEvents(runId, eventsOptions) {
      options.onListEvents?.(runId, eventsOptions);
      return (
        options.events ??
        smithersEventsResult({
          events: smithersEventsResult().events.map((event) => ({
            ...event,
            runId,
          })),
        })
      );
    },
    close() {
      options.onClose?.();
    },
  };
}

function tempProjectWithCurrentWorkflowSource(source = "CURRENT SOURCE ONLY") {
  const projectRoot = mkdtempSync(
    join(tmpdir(), "custom-harness-server-project-")
  );
  const workflowsDir = join(projectRoot, ".smithers", "workflows");
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(join(workflowsDir, "truth-workflow.tsx"), `${source}\n`);
  return projectRoot;
}

function smithersWorkflowXml(
  name: string,
  children: Array<Record<string, unknown>>
) {
  return {
    kind: "element",
    tag: "smithers:workflow",
    props: { name },
    children: [
      {
        kind: "element",
        tag: "smithers:sequence",
        props: {},
        children,
      },
    ],
  };
}

function smithersTaskXml(
  id: string,
  label: string,
  children: Array<Record<string, unknown>> = []
) {
  return {
    kind: "element",
    tag: "smithers:task",
    props: { id, label },
    children,
  };
}

function smithersTextXml(text: string) {
  return { kind: "text", text };
}

function smithersFrame(args: {
  runId: string;
  frameNo: number;
  xml: Record<string, unknown> | null;
  xmlJson?: string;
  taskIndexJson?: string | null;
  taskIndex?: unknown;
}): SmithersRunDetail["frames"][number] {
  return {
    runId: args.runId,
    frameNo: args.frameNo,
    createdAtMs: 1000 + args.frameNo,
    xmlHash: `xml-hash-${args.frameNo}`,
    encoding: "full",
    xmlJson: args.xmlJson ?? JSON.stringify(args.xml),
    xml: args.xml as SmithersRunDetail["frames"][number]["xml"],
    mountedTaskIdsJson: null,
    mountedTaskIds: [],
    taskIndexJson: args.taskIndexJson ?? null,
    taskIndex: (args.taskIndex ??
      null) as SmithersRunDetail["frames"][number]["taskIndex"],
    note: null,
  };
}

function smithersHistoricalNode(
  runId: string,
  nodeId: string,
  label = "Historical persisted node label"
): SmithersRunDetail["nodes"][number] {
  return {
    runId,
    nodeId,
    iteration: 0,
    state: "finished",
    status: "finished",
    lastAttempt: 1,
    updatedAtMs: 2000,
    outputTable: "historical_outputs",
    label,
  };
}

describe("HTTP server DB-backed Smithers run inspection API", () => {
  it("lists Smithers runs using the injected reader and closes it after the request", async () => {
    const calls: unknown[] = [];
    let closeCalls = 0;
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot: process.cwd(),
      createSmithersRunReader: () =>
        fakeSmithersRunReader({
          runs: [
            smithersRunSummary({
              runId: "reader-list-run",
              workflowName: "reader-list",
            }),
          ],
          onListRuns: (options) => calls.push(options),
          onClose: () => {
            closeCalls += 1;
          },
        }),
    });

    const response = await handler(
      new Request(
        "http://localhost/api/smithers/runs?limit=25&status=running&workflowId=reader-list"
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      runs: [
        smithersRunSummary({
          runId: "reader-list-run",
          workflowName: "reader-list",
        }),
      ],
    });
    expect(calls).toEqual([
      { limit: 25, status: "running", workflowId: "reader-list" },
    ]);
    expect(closeCalls).toBe(1);
  });

  it("clamps list limits before passing them to the reader", async () => {
    const calls: unknown[] = [];
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot: process.cwd(),
      createSmithersRunReader: () =>
        fakeSmithersRunReader({ onListRuns: (options) => calls.push(options) }),
    });

    const low = await handler(
      new Request("http://localhost/api/smithers/runs?limit=-50")
    );
    const high = await handler(
      new Request("http://localhost/api/smithers/runs?limit=50000")
    );

    expect(low.status).toBe(200);
    expect(high.status).toBe(200);
    expect(calls).toEqual([{ limit: 1 }, { limit: 500 }]);
  });

  it("returns Smithers run detail using the injected reader and parsed detail query options", async () => {
    const detail = smithersRunDetail({
      run: smithersRunSummary({
        runId: "reader-detail-run",
        status: "finished",
      }),
      outputs: [
        {
          runId: "reader-detail-run",
          nodeId: "reader-node",
          iteration: 0,
          outputTable: "reader_outputs",
          row: { source: "reader-output" },
        },
      ],
    });
    const calls: Array<{ runId: string; options: unknown }> = [];
    let closeCalls = 0;
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot: process.cwd(),
      createSmithersRunReader: () =>
        fakeSmithersRunReader({
          detail,
          onGetRunDetail: (runId, options) => calls.push({ runId, options }),
          onClose: () => {
            closeCalls += 1;
          },
        }),
    });

    const response = await handler(
      new Request(
        "http://localhost/api/smithers/runs/reader-detail-run?eventsAfterSeq=41&eventLimit=2000&frameLimit=0&includeOutputs=true"
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, detail });
    expect(calls).toEqual([
      {
        runId: "reader-detail-run",
        options: {
          eventsAfterSeq: 41,
          eventLimit: 1000,
          frameLimit: 1,
          includeOutputs: true,
        },
      },
    ]);
    expect(closeCalls).toBe(1);
  });

  it("adds historical view.graph from the selected run latest persisted Smithers frame by default", async () => {
    const runId = "historical-frame-run";
    const projectRoot = tempProjectWithCurrentWorkflowSource(
      "throw new Error('current Workflow Source must not be imported for historical Run Inspection');"
    );
    const latestXml = smithersWorkflowXml("historical-frame-workflow", [
      smithersTaskXml("historical-node", "Latest persisted frame label", [
        smithersTextXml("Prompt captured in the persisted Run Frame"),
      ]),
    ]);
    const detail = smithersRunDetail({
      run: smithersRunSummary({
        runId,
        workflowName: "truth-workflow",
        workflowPath: join(
          projectRoot,
          ".smithers/workflows/truth-workflow.tsx"
        ),
        status: "finished",
      }),
      nodes: [smithersHistoricalNode(runId, "historical-node")],
      frames: [
        smithersFrame({
          runId,
          frameNo: 1,
          xml: smithersWorkflowXml("old-frame", [
            smithersTaskXml("old-node", "Stale frame label", [
              smithersTextXml("Stale prompt"),
            ]),
          ]),
          taskIndexJson: '[{"nodeId":"old-node","ordinal":0,"iteration":0}]',
          taskIndex: [{ nodeId: "old-node", ordinal: 0, iteration: 0 }],
        }),
        smithersFrame({
          runId,
          frameNo: 2,
          xml: latestXml,
          taskIndexJson:
            '[{"nodeId":"historical-node","ordinal":0,"iteration":0}]',
          taskIndex: [{ nodeId: "historical-node", ordinal: 0, iteration: 0 }],
        }),
      ],
    });
    let currentWorkflowGraphCalls = 0;
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot,
      createSmithersRunReader: () => fakeSmithersRunReader({ detail }),
      renderProjectWorkflowGraph: async () => {
        currentWorkflowGraphCalls += 1;
        throw new Error(
          "current Workflow Source graph fallback is forbidden for historical Run Inspection"
        );
      },
    });

    const response = await handler(
      new Request(`http://localhost/api/smithers/runs/${runId}`)
    );
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.detail.view.graphSource).toEqual({
      kind: "smithers-frame",
      runId,
      frameNo: 2,
      fallback: false,
    });
    expect(body.detail.view.graph.source).toEqual({
      kind: "smithers",
      frameNo: 2,
    });
    expect(body.detail.view.graph.runId).toBe(runId);
    expect(
      body.detail.view.graph.nodes.map((node: { id: string }) => node.id)
    ).toContain("historical-node");
    expect(
      body.detail.view.graph.nodes.map((node: { id: string }) => node.id)
    ).not.toContain("old-node");
    const historicalNode = body.detail.view.graph.nodes.find(
      (node: { id: string }) => node.id === "historical-node"
    );
    expect(historicalNode?.status).toBe("finished");
    const graphJson = JSON.stringify(body.detail.view.graph);
    expect(graphJson).toContain("Latest persisted frame label");
    expect(graphJson).toContain("Prompt captured in the persisted Run Frame");
    expect(graphJson).not.toContain("current Workflow Source");
    expect(graphJson).not.toContain("Stale frame label");
    expect(body.detail.view.graphSource.kind).not.toBe(
      "fallback-current-source"
    );
    expect(currentWorkflowGraphCalls).toBe(0);
  });

  it("marks historical view.graph unavailable when a run has no persisted frames and never falls back to current Workflow Source", async () => {
    const runId = "historical-no-frame-run";
    const projectRoot = tempProjectWithCurrentWorkflowSource(
      "throw new Error('current source fallback must not run for no-frame history');"
    );
    let currentWorkflowGraphCalls = 0;
    const detail = smithersRunDetail({
      run: smithersRunSummary({
        runId,
        workflowName: "truth-workflow",
        workflowPath: join(
          projectRoot,
          ".smithers/workflows/truth-workflow.tsx"
        ),
        status: "finished",
      }),
      nodes: [smithersHistoricalNode(runId, "historical-node")],
      frames: [],
    });
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot,
      createSmithersRunReader: () => fakeSmithersRunReader({ detail }),
      renderProjectWorkflowGraph: async () => {
        currentWorkflowGraphCalls += 1;
        throw new Error(
          "current Workflow Source graph fallback is forbidden for historical Run Inspection"
        );
      },
    });

    const response = await handler(
      new Request(`http://localhost/api/smithers/runs/${runId}`)
    );
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(body.detail.view.graphSource).toEqual({
      kind: "unavailable",
      runId,
      fallback: false,
      reason: expect.stringMatching(/frame/i),
    });
    expect(body.detail.view).not.toHaveProperty("graph");
    expect(body.detail.view.graphSource.kind).not.toBe(
      "fallback-current-source"
    );
    expect(currentWorkflowGraphCalls).toBe(0);
  });

  it("marks historical view.graph unavailable for malformed frame XML without consulting current Workflow Source", async () => {
    const runId = "historical-bad-frame-run";
    const projectRoot = tempProjectWithCurrentWorkflowSource(
      "throw new Error('current source fallback must not run for malformed frames');"
    );
    let currentWorkflowGraphCalls = 0;
    const detail = smithersRunDetail({
      run: smithersRunSummary({
        runId,
        workflowName: "truth-workflow",
        workflowPath: join(
          projectRoot,
          ".smithers/workflows/truth-workflow.tsx"
        ),
        status: "failed",
      }),
      nodes: [smithersHistoricalNode(runId, "historical-node")],
      frames: [
        smithersFrame({
          runId,
          frameNo: 5,
          xml: null,
          xmlJson: "{malformed-frame-xml",
          taskIndexJson:
            '[{"nodeId":"historical-node","ordinal":0,"iteration":0}]',
          taskIndex: [{ nodeId: "historical-node", ordinal: 0, iteration: 0 }],
        }),
      ],
      parseWarnings: [
        {
          field: "frame.xmlJson",
          message: "malformed fixture frame",
          runId,
          frameNo: 5,
        },
      ],
    });
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot,
      createSmithersRunReader: () => fakeSmithersRunReader({ detail }),
      renderProjectWorkflowGraph: async () => {
        currentWorkflowGraphCalls += 1;
        throw new Error(
          "current Workflow Source graph fallback is forbidden for historical Run Inspection"
        );
      },
    });

    const response = await handler(
      new Request(`http://localhost/api/smithers/runs/${runId}`)
    );
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(body.detail.view.graphSource).toEqual({
      kind: "unavailable",
      runId,
      frameNo: 5,
      fallback: false,
      reason: expect.stringMatching(/xml|frame|project/i),
    });
    expect(body.detail.view).not.toHaveProperty("graph");
    expect(body.detail.view.graphSource.kind).not.toBe(
      "fallback-current-source"
    );
    expect(currentWorkflowGraphCalls).toBe(0);
  });

  it("does not backfill missing historical prompt model or editor metadata from current Workflow Source", async () => {
    const runId = "historical-missing-task-metadata-run";
    const projectRoot = tempProjectWithCurrentWorkflowSource(`
      export const currentOnly = {
        label: 'CURRENT SOURCE ONLY LABEL',
        prompt: 'CURRENT SOURCE ONLY PROMPT',
        model: 'openrouter/current-source-only-model',
        meta: { editor: { editable: true } },
      };
    `);
    const historicalXml = smithersWorkflowXml(
      "historical-missing-task-metadata",
      [smithersTaskXml("metadata-missing-node", "Persisted historical label")]
    );
    const detail = smithersRunDetail({
      run: smithersRunSummary({
        runId,
        workflowName: "truth-workflow",
        workflowPath: join(
          projectRoot,
          ".smithers/workflows/truth-workflow.tsx"
        ),
        status: "finished",
      }),
      nodes: [smithersHistoricalNode(runId, "metadata-missing-node")],
      frames: [
        smithersFrame({
          runId,
          frameNo: 8,
          xml: historicalXml,
          taskIndexJson:
            '[{"nodeId":"metadata-missing-node","ordinal":0,"iteration":0}]',
          taskIndex: [
            { nodeId: "metadata-missing-node", ordinal: 0, iteration: 0 },
          ],
        }),
      ],
    });
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot,
      createSmithersRunReader: () => fakeSmithersRunReader({ detail }),
    });

    const response = await handler(
      new Request(`http://localhost/api/smithers/runs/${runId}`)
    );
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(body.detail.view.graphSource).toEqual({
      kind: "smithers-frame",
      runId,
      frameNo: 8,
      fallback: false,
    });
    const historicalNode = body.detail.view.graph.nodes.find(
      (node: { id: string }) => node.id === "metadata-missing-node"
    );
    expect(historicalNode).toEqual(
      expect.objectContaining({
        title: "Persisted historical label",
        prompt: expect.stringMatching(/unknown|not captured/i),
        agent: expect.stringMatching(/unknown|not captured/i),
      })
    );
    expect(historicalNode?.smithers?.meta?.editor).toBeUndefined();
    expect(JSON.stringify(body.detail.view.graph)).not.toContain(
      "CURRENT SOURCE ONLY"
    );
    expect(JSON.stringify(body.detail.view.graph)).not.toContain(
      "openrouter/current-source-only-model"
    );
    expect(body.detail.view.graphSource.kind).not.toBe(
      "fallback-current-source"
    );
  });

  it("uses persisted attempt metadata for historical prompt and model when frame taskIndex is minimal", async () => {
    const runId = "historical-attempt-metadata-run";
    const projectRoot = tempProjectWithCurrentWorkflowSource(`
      export const currentOnly = {
        prompt: 'CURRENT SOURCE ONLY PROMPT',
        model: 'openrouter/current-source-only-model',
      };
    `);
    const historicalXml = smithersWorkflowXml("historical-attempt-metadata", [
      smithersTaskXml("attempt-metadata-node", "Frame label"),
    ]);
    const detail = smithersRunDetail({
      run: smithersRunSummary({
        runId,
        workflowName: "truth-workflow",
        workflowPath: join(
          projectRoot,
          ".smithers/workflows/truth-workflow.tsx"
        ),
        status: "finished",
      }),
      nodes: [smithersHistoricalNode(runId, "attempt-metadata-node")],
      attempts: [
        {
          runId,
          nodeId: "attempt-metadata-node",
          iteration: 0,
          attempt: 1,
          state: "finished",
          status: "finished",
          startedAtMs: 2000,
          finishedAtMs: 2500,
          heartbeatAtMs: null,
          heartbeatDataJson: null,
          heartbeatData: null,
          errorJson: null,
          error: null,
          jjPointer: null,
          responseText: null,
          jjCwd: null,
          cached: false,
          metaJson: JSON.stringify({
            prompt: "Prompt captured in Smithers attempt metadata",
            label: "Attempt metadata label",
            outputTable: "attempt_outputs",
            agentId: "captured-agent",
            agentModel: "openrouter/captured-model",
          }),
          meta: {
            prompt: "Prompt captured in Smithers attempt metadata",
            label: "Attempt metadata label",
            outputTable: "attempt_outputs",
            agentId: "captured-agent",
            agentModel: "openrouter/captured-model",
          },
        },
      ],
      frames: [
        smithersFrame({
          runId,
          frameNo: 9,
          xml: historicalXml,
          taskIndexJson:
            '[{"nodeId":"attempt-metadata-node","ordinal":0,"iteration":0}]',
          taskIndex: [
            { nodeId: "attempt-metadata-node", ordinal: 0, iteration: 0 },
          ],
        }),
      ],
    });
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot,
      createSmithersRunReader: () => fakeSmithersRunReader({ detail }),
    });

    const response = await handler(
      new Request(`http://localhost/api/smithers/runs/${runId}`)
    );
    const body = (await response.json()) as any;
    const historicalNode = body.detail.view.graph.nodes.find(
      (node: { id: string }) => node.id === "attempt-metadata-node"
    );

    expect(response.status).toBe(200);
    expect(historicalNode).toEqual(
      expect.objectContaining({
        prompt: "Prompt captured in Smithers attempt metadata",
        agent: "smithers · openrouter/captured-model",
      })
    );
    expect(JSON.stringify(body.detail.view.graph)).not.toContain(
      "CURRENT SOURCE ONLY"
    );
  });

  it("returns a structured 404 and closes the reader when a Smithers run is missing", async () => {
    const calls: Array<{ runId: string; options: unknown }> = [];
    let closeCalls = 0;
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot: process.cwd(),
      createSmithersRunReader: () =>
        fakeSmithersRunReader({
          detail: null,
          onGetRunDetail: (runId, options) => calls.push({ runId, options }),
          onClose: () => {
            closeCalls += 1;
          },
        }),
    });

    const response = await handler(
      new Request("http://localhost/api/smithers/runs/missing-run")
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Smithers run not found: missing-run",
      code: "SMITHERS_RUN_NOT_FOUND",
    });
    expect(calls).toEqual([{ runId: "missing-run", options: {} }]);
    expect(closeCalls).toBe(1);
  });

  it("returns Smithers run events using afterSeq, limit, nodeId, types, and timestamp query options", async () => {
    const events = smithersEventsResult({
      events: [
        {
          runId: "reader-events-run",
          seq: 19,
          timestampMs: 1100,
          type: "reader.typeB",
          payloadJson: '{"source":"events"}',
          payload: { source: "events" },
          nodeId: null,
          iteration: null,
          attempt: null,
        },
      ],
      cursors: { nextEventSeq: 20 },
    });
    const calls: Array<{ runId: string; options: unknown }> = [];
    let closeCalls = 0;
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot: process.cwd(),
      createSmithersRunReader: () =>
        fakeSmithersRunReader({
          events,
          onListEvents: (runId, options) => calls.push({ runId, options }),
          onClose: () => {
            closeCalls += 1;
          },
        }),
    });

    const response = await handler(
      new Request(
        "http://localhost/api/smithers/runs/reader-events-run/events?afterSeq=10&limit=2000&nodeId=reader-node&types=reader.typeA,reader.typeB,,&sinceTimestampMs=1090"
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ...events });
    expect(calls).toEqual([
      {
        runId: "reader-events-run",
        options: {
          afterSeq: 10,
          limit: 1000,
          nodeId: "reader-node",
          types: ["reader.typeA", "reader.typeB"],
          sinceTimestampMs: 1090,
        },
      },
    ]);
    expect(closeCalls).toBe(1);
  });

  it("passes parse warnings through from the Smithers events reader", async () => {
    const events = smithersEventsResult({
      events: [
        {
          runId: "reader-events-warning-run",
          seq: 21,
          timestampMs: 1200,
          type: "reader.bad-json",
          payloadJson: "{bad-json",
          payload: null,
          nodeId: null,
          iteration: null,
          attempt: null,
        },
      ],
      cursors: { nextEventSeq: 21 },
      parseWarnings: [
        {
          field: "event.payloadJson",
          message: "Expected property name or } in JSON at position 1",
          runId: "reader-events-warning-run",
          seq: 21,
        },
      ],
    } as Partial<SmithersRunEventsResult>);
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot: process.cwd(),
      createSmithersRunReader: () => fakeSmithersRunReader({ events }),
    });

    const response = await handler(
      new Request(
        "http://localhost/api/smithers/runs/reader-events-warning-run/events"
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ...events });
  });

  it("uses afterSeq as an alias for eventsAfterSeq on detail requests", async () => {
    const calls: unknown[] = [];
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot: process.cwd(),
      createSmithersRunReader: () =>
        fakeSmithersRunReader({
          onGetRunDetail: (_runId, options) => calls.push(options),
        }),
    });

    const response = await handler(
      new Request(
        "http://localhost/api/smithers/runs/reader-detail-run?afterSeq=15&includeOutputs=false"
      )
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([{ eventsAfterSeq: 15, includeOutputs: false }]);
  });

  it("ignores contradictory legacy runs artifacts for all Smithers run inspection endpoints", async () => {
    const runsDir = tempRunsDir();
    mkdirSync(join(runsDir, "legacy-false-run"), { recursive: true });
    writeFileSync(
      join(runsDir, "index.json"),
      `${JSON.stringify({ runs: [{ id: "legacy-false-run", status: "failed", workflowName: "legacy-lie" }] })}\n`
    );
    writeFileSync(
      join(runsDir, "legacy-false-run", "plan.json"),
      `${JSON.stringify({ raw: { source: "legacy-plan-lie" }, graph: { nodes: [{ id: "legacy-node" }] } })}\n`
    );
    writeFileSync(
      join(runsDir, "legacy-false-run", "run.json"),
      `${JSON.stringify({ id: "legacy-false-run", status: "failed", goal: "legacy lie" })}\n`
    );
    writeFileSync(
      join(runsDir, "legacy-false-run", "events.jsonl"),
      `${JSON.stringify({ type: "legacy.lie", payload: { source: "legacy-events" } })}\n`
    );

    const readerList = smithersRunSummary({
      runId: "reader-true-run",
      status: "finished",
      workflowName: "reader-truth",
    });
    const readerDetail = smithersRunDetail({ run: readerList });
    const readerEvents = smithersEventsResult({
      events: [
        {
          ...smithersEventsResult().events[0]!,
          runId: "reader-true-run",
          type: "reader.truth",
        },
      ],
    });
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot: process.cwd(),
      createSmithersRunReader: () =>
        fakeSmithersRunReader({
          runs: [readerList],
          detail: readerDetail,
          events: readerEvents,
        }),
    });

    expect(
      await (
        await handler(new Request("http://localhost/api/smithers/runs"))
      ).json()
    ).toEqual({ ok: true, runs: [readerList] });
    expect(
      await (
        await handler(
          new Request("http://localhost/api/smithers/runs/reader-true-run")
        )
      ).json()
    ).toEqual({ ok: true, detail: readerDetail });
    expect(
      await (
        await handler(
          new Request(
            "http://localhost/api/smithers/runs/reader-true-run/events"
          )
        )
      ).json()
    ).toEqual({ ok: true, ...readerEvents });
  });

  it("guides workflow authoring to use explicit context handoff rather than implying same chat/thread continuity", () => {
    const source = readFileSync(join(process.cwd(), "src", "server.ts"), "utf8");
    const promptStart = source.indexOf("function smithersAuthorSystemPrompt()");
    const promptSource = source.slice(promptStart);

    expect(promptSource).toContain('"same agent", "same chat", "same thread", "original planner"');
    expect(promptSource).toContain("continuity of role and context");
    expect(promptSource).toContain("reusing the same PiAgent variable/config/model");
    expect(promptSource).toContain("ctx.outputMaybe/ctx.latest");
    expect(promptSource).toContain("Do not imply real same-chat/thread continuity");
    expect(promptSource).toContain("hidden memory");
    expect(promptSource).toContain("session/resume flags");
    expect(promptSource).toContain("same role/config + explicit prior outputs/context");
  });

  it("creates generated Workflow Source from a prompt and records failed render verification", async () => {
    const projectRoot = tempProjectWithCurrentWorkflowSource();
    let authorPrompt = "";
    let firstAuthorModel = "";
    let authorCalls = 0;
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot,
      authorWorkflowSource: async ({
        prompt,
        workflowId,
        displayName,
        model,
        repairError,
      }) => {
        authorCalls += 1;
        authorPrompt = prompt;
        firstAuthorModel ||= model ?? "";
        const validRuntimeConfig = repairError
          ? 'const editable = { agents: { main: { model: "openai/gpt-5.5" } }, tasks: { summarize: { label: ' +
            JSON.stringify(displayName) +
            ', prompt: "Summarize {{userPrompt}}" } } } as const;\nconst agent = new PiAgent({ provider: "openrouter", model: editable.agents.main.model });'
          : 'const editable = { agents: { main: { model: "openrouter/openai/gpt-5.5" } }, tasks: { summarize: { label: ' +
            JSON.stringify(displayName) +
            ', prompt: "Summarize {{userPrompt}}" } } } as const;\nconst agent = new PiAgent({ provider: "openai", model: editable.agents.main.model });';
        return {
          model: "fake-author",
          source: `/** @jsxImportSource smithers-orchestrator */
import { createSmithers, PiAgent } from "smithers-orchestrator";
import { z } from "zod";
const inputSchema = z.object({ prompt: z.string().default(${JSON.stringify(prompt)}) });
const outputSchema = z.looseObject({ summary: z.string() });
${validRuntimeConfig}
const { Workflow, Task, Sequence, smithers } = createSmithers({ input: inputSchema, summary: outputSchema });
export default smithers((ctx) => (<Workflow name=${JSON.stringify(workflowId)}><Sequence><Task id="summarize" label={editable.tasks.summarize.label} output={outputSchema} agent={agent}>{ctx.input.prompt}</Task></Sequence></Workflow>));
`,
        };
      },
      renderProjectWorkflowGraph: async () => {
        throw new Error("render intentionally unavailable in this unit test");
      },
    });

    const response = await handler(
      new Request("http://localhost/api/workflows/create-from-prompt", {
        method: "POST",
        body: JSON.stringify({
          prompt: "Review a pull request and summarize risks",
          workflowId: "review-risk-summary",
          displayName: "Review Risk Summary",
          model: "openrouter/openai/gpt-5.5",
        }),
      })
    );
    const body = (await response.json()) as any;
    const workflowPath = join(
      projectRoot,
      ".smithers",
      "workflows",
      "review-risk-summary.tsx"
    );

    expect(response.status).toBe(202);
    expect(body.ok).toBe(true);
    expect(body.workflowId).toBe("review-risk-summary");
    expect(body.verified).toBe(false);
    expect(body.verificationError).toContain(
      "render intentionally unavailable"
    );
    expect(authorPrompt).toBe("Review a pull request and summarize risks");
    expect(firstAuthorModel).toBe("openai/gpt-5.5");
    expect(authorCalls).toBeGreaterThanOrEqual(2);
    expect(existsSync(workflowPath)).toBe(true);
    const savedSource = readFileSync(workflowPath, "utf8");
    expect(savedSource).toContain(
      "// smithers-display-name: Review Risk Summary"
    );
    expect(savedSource).toContain('model: "openai/gpt-5.5"');
    expect(savedSource).toContain('provider: "openrouter"');
    expect(savedSource).not.toContain("openrouter/openai/gpt-5.5");
    expect(existsSync(body.tracePath)).toBe(true);
    expect(
      body.tracePath.startsWith(
        join(
          projectRoot,
          ".smithers",
          "workbench",
          "creation-traces",
          "review-risk-summary"
        )
      )
    ).toBe(true);
    expect(existsSync(join(projectRoot, ".poolside"))).toBe(false);
  });

  it("closes the reader when a reader operation throws", async () => {
    let closeCalls = 0;
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot: process.cwd(),
      createSmithersRunReader: () => ({
        async listRuns() {
          throw new Error("reader exploded");
        },
        async getRunDetail() {
          throw new Error("should not call detail");
        },
        async listEvents() {
          throw new Error("should not call events");
        },
        close() {
          closeCalls += 1;
        },
      }),
    });

    const response = await handler(
      new Request("http://localhost/api/smithers/runs")
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      error: "reader exploded",
    });
    expect(closeCalls).toBe(1);
  });
});
