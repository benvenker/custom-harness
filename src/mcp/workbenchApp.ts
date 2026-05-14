import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type WorkflowInfo = { id: string; path?: string };
type RenderNode = {
  id: string;
  type?: string;
  title?: string;
  x?: number;
  y?: number;
  agent?: string;
  prompt?: string;
  status?: string;
  timeline?: Array<{ ts?: string; what?: string }>;
  smithers?: { nodeId?: string; meta?: unknown; [key: string]: unknown };
};
type RenderGraph = {
  title?: string;
  goal?: string;
  reason?: string;
  runId?: string;
  nodes?: RenderNode[];
  edges?: Array<{ from: string; to: string }>;
  defaultSelected?: string;
};

type BootstrapState = {
  ok?: boolean;
  contractVersion?: number;
  launch?: {
    title?: string;
    subtitle?: string;
    status?: string;
    viewId?: string;
    resourceUri?: string;
  };
  project?: {
    projectRoot?: string;
    label?: string;
    defaultWorkflowId?: string;
  };
  workflows?: WorkflowInfo[];
  selectedWorkflowId?: string;
  workflow?: { id?: string; title?: string; path?: string };
  graphSummary?: {
    defaultSelectedNodeId?: string;
    nodeCount?: number;
    edgeCount?: number;
    hasErrors?: boolean;
  };
  graph?: RenderGraph | null;
  graphHydration?: { included?: boolean; truncated?: boolean; reason?: string };
  error?: string | { code?: string; message?: string };
};

const app = new App(
  { name: "CustomHarness Workbench", version: "0.1.0" },
  { availableDisplayModes: ["inline", "fullscreen"] }
);

let bootstrap: BootstrapState = {};
let workflows: WorkflowInfo[] = [];
let selectedWorkflowId = "";
let selectedNodeId = "";
let graph: RenderGraph | null = null;
let hostContext: McpUiHostContext | undefined;
let busyAction: "render" | "create" | "display-mode" | null = null;

const root = document.getElementById("root")!;

function toolStructured<T>(result: CallToolResult): T {
  const structured = result.structuredContent as
    | { error?: string | { message?: string }; ok?: boolean }
    | undefined;
  if (result.isError || structured?.ok === false) {
    const structuredMessage =
      typeof structured?.error === "string"
        ? structured.error
        : structured?.error?.message;
    const text =
      structuredMessage ||
      result.content
        ?.map((item) => (item.type === "text" ? item.text : ""))
        .join("\n") ||
      "Tool call failed";
    throw new Error(text);
  }
  return result.structuredContent as T;
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function nodeById(id: string) {
  return graph?.nodes?.find((node) => node.id === id) ?? null;
}

async function syncModelContext() {
  if (!app.getHostCapabilities()?.updateModelContext) return;
  const node = nodeById(selectedNodeId);
  const status =
    bootstrap.launch?.status || (bootstrap.ok === false ? "error" : "ready");
  const text = [
    "---",
    "app: custom-harness",
    `viewId: ${bootstrap.launch?.viewId ?? "unknown"}`,
    `workflowId: ${selectedWorkflowId || "none"}`,
    selectedNodeId ? `selectedNodeId: ${selectedNodeId}` : undefined,
    `status: ${status}`,
    "---",
    `User is viewing CustomHarness Smithers workflow ${selectedWorkflowId || "none"}.`,
    node
      ? `Selected node: ${node.title || node.id} (${node.id})`
      : "No node is selected.",
    node?.type ? `Node type: ${node.type}` : undefined,
    node?.status ? `Node status: ${node.status}` : undefined,
    node?.prompt ? `Prompt excerpt: ${node.prompt.slice(0, 600)}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  try {
    await app.updateModelContext({ content: [{ type: "text", text }] });
  } catch (error) {
    console.debug("updateModelContext unavailable or rejected", error);
  }
}

function setStatus(message: string, kind: "ok" | "error" | "muted" = "muted") {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = message;
  el.className = `status ${kind}`;
}

async function refreshWorkflows() {
  const result = await app.callServerTool({
    name: "ch_workflows_list",
    arguments: {},
  });
  const data = toolStructured<{
    ok: boolean;
    workflows: WorkflowInfo[];
    defaultWorkflowId?: string;
  }>(result);
  workflows = data.workflows ?? [];
  if (!selectedWorkflowId) {
    selectedWorkflowId = data.defaultWorkflowId || workflows[0]?.id || "";
  }
}

async function renderSelectedGraph() {
  if (!selectedWorkflowId) return;
  const prompt =
    (document.getElementById("prompt") as HTMLTextAreaElement | null)?.value ??
    "";
  setBusyAction("render", true);
  setStatus("Rendering workflow graph…");
  try {
    const result = await app.callServerTool({
      name: "ch_workflow_graph_render",
      arguments: {
        workflowId: selectedWorkflowId,
        input: {
          prompt,
          request: prompt,
          plan: prompt,
          idea: prompt,
          text: prompt,
        },
      },
    });
    const data = toolStructured<{
      ok: boolean;
      workflowId: string;
      graph: RenderGraph;
      error?: string | { message?: string };
    }>(result);
    if (!data.ok)
      throw new Error(
        typeof data.error === "string"
          ? data.error
          : data.error?.message || "Render failed"
      );
    graph = data.graph;
    selectedNodeId = graph.defaultSelected || graph.nodes?.[0]?.id || "";
    render();
    setStatus(`Rendered ${selectedWorkflowId}`, "ok");
    void syncModelContext();
  } finally {
    setBusyAction("render", false);
  }
}

async function createWorkflowFromPrompt() {
  const prompt =
    (
      document.getElementById("create-prompt") as HTMLTextAreaElement | null
    )?.value.trim() ?? "";
  if (!prompt) {
    setStatus("Describe the workflow to create first", "error");
    return;
  }
  setBusyAction("create", true);
  setStatus("Generating Smithers Workflow Source…");
  try {
    const result = await app.callServerTool({
      name: "ch_workflow_create_from_prompt",
      arguments: { prompt },
    });
    const data = toolStructured<{
      ok: boolean;
      workflowId?: string;
      graph?: RenderGraph;
      verified?: boolean;
      error?: string;
      verificationError?: string;
    }>(result);
    if (!data.ok || !data.workflowId)
      throw new Error(data.error || "Workflow generation failed");
    await refreshWorkflows();
    selectedWorkflowId = data.workflowId;
    graph = data.graph ?? null;
    selectedNodeId = graph?.defaultSelected || graph?.nodes?.[0]?.id || "";
    render();
    if (!graph) {
      await renderSelectedGraph();
    }
    setStatus(
      data.verified
        ? `Created and rendered ${selectedWorkflowId}`
        : `Created ${selectedWorkflowId}; verification needs repair`,
      data.verified ? "ok" : "error"
    );
    void syncModelContext();
  } finally {
    setBusyAction("create", false);
  }
}

function renderWorkflowPicker() {
  return `<select id="workflow" aria-label="Workflow">${workflows
    .map(
      (workflow) =>
        `<option value="${escapeHtml(workflow.id)}" ${workflow.id === selectedWorkflowId ? "selected" : ""}>${escapeHtml(workflow.id)}</option>`
    )
    .join("")}</select>`;
}

function renderGraph() {
  const nodes = graph?.nodes ?? [];
  if (!nodes.length) return `<div class="empty">No graph rendered yet.</div>`;
  const nodeWidth = 250;
  const nodeHeight = 118;
  const padding = 24;
  const minX = Math.min(...nodes.map((n) => Number(n.x ?? 0)));
  const minY = Math.min(...nodes.map((n) => Number(n.y ?? 0)));
  const positionedNodes = nodes.map((node) => ({
    node,
    x: Number(node.x ?? 0) - minX + padding,
    y: Number(node.y ?? 0) - minY + padding,
  }));
  const graphWidth = Math.max(
    360,
    ...positionedNodes.map(({ x }) => x + nodeWidth + padding)
  );
  const graphHeight = Math.max(
    220,
    ...positionedNodes.map(({ y }) => y + nodeHeight + padding)
  );
  return `<div class="graph-scroll"><div class="graph" style="min-width:${graphWidth}px;min-height:${graphHeight}px">${positionedNodes
    .map(({ node, x, y }) => {
      const selected = node.id === selectedNodeId ? " selected" : "";
      return `<button class="node${selected}" style="left:${x}px;top:${y}px" data-node-id="${escapeHtml(node.id)}">
        <span class="node-kicker">${escapeHtml(node.type || "task")} · ${escapeHtml(node.status || "idle")}</span>
        <strong>${escapeHtml(node.title || node.id)}</strong>
        <span class="node-agent">${escapeHtml(node.agent || "")}</span>
        <small>${escapeHtml((node.prompt || "").slice(0, 150))}</small>
      </button>`;
    })
    .join("")}</div></div>`;
}

function renderInspector() {
  const node = nodeById(selectedNodeId);
  if (!node)
    return `<aside class="inspector"><div class="empty">Select a node.</div></aside>`;
  const meta = node.smithers?.meta
    ? JSON.stringify(node.smithers.meta, null, 2)
    : "";
  return `<aside class="inspector">
    <div class="eyebrow">${escapeHtml(node.type || "node")} · ${escapeHtml(node.status || "unknown")}</div>
    <h2>${escapeHtml(node.title || node.id)}</h2>
    <p class="subtle">id ${escapeHtml(node.id)} · ${escapeHtml(node.agent || "no agent")}</p>
    <label>Rendered prompt</label>
    <pre>${escapeHtml(node.prompt || "No prompt captured for this node.")}</pre>
    ${meta ? `<label>Editor metadata</label><pre>${escapeHtml(meta)}</pre>` : ""}
  </aside>`;
}

function render() {
  const projectRoot = bootstrap.project?.projectRoot || "No project";
  const title = bootstrap.launch?.title || "Smithers workflow workbench";
  const subtitle = bootstrap.launch?.subtitle || projectRoot;
  root.innerHTML = `<main class="shell">
    <header>
      <div>
        <div class="eyebrow">CustomHarness MCP App</div>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(subtitle)}</p>
      </div>
      <button id="fullscreen" class="ghost" type="button">Fullscreen</button>
    </header>
    <section class="toolbar run-toolbar">
      <label class="workflow-field">Workflow ${renderWorkflowPicker()}</label>
      <label class="prompt-label">Runtime input
        <textarea id="prompt" rows="3" spellcheck="false">${escapeHtml(graph?.goal || "Describe what this workflow should do for this run.")}</textarea>
      </label>
      <div class="action-cell">
        <button id="render" type="button">Render graph</button>
        <span id="status" class="status muted">Ready</span>
      </div>
    </section>
    <details class="creator-panel">
      <summary><span>New workflow from natural language</span><small>Generate ordinary .smithers/workflows/*.tsx</small></summary>
      <section class="toolbar creator">
        <label class="create-field">Describe the workflow
          <textarea id="create-prompt" rows="3" spellcheck="true" placeholder="Example: Review a pull request, fan out to security and UX reviewers, then synthesize risks."></textarea>
        </label>
        <div class="action-cell">
          <button id="create-workflow" type="button">Generate workflow</button>
          <span class="status muted">Creates source, then renders the graph</span>
        </div>
      </section>
    </details>
    <section class="workspace">
      <div class="canvas">
        <div class="canvas-title">${escapeHtml(graph?.title || selectedWorkflowId || "Workflow graph")}</div>
        ${renderGraph()}
      </div>
      ${renderInspector()}
    </section>
  </main>`;
  attachEvents();
  applyHostChrome();
}

function attachEvents() {
  document
    .getElementById("workflow")
    ?.addEventListener("change", async (event) => {
      selectedWorkflowId = (event.target as HTMLSelectElement).value;
      selectedNodeId = "";
      await renderSelectedGraph().catch((error) =>
        setStatus(error.message, "error")
      );
    });
  document.getElementById("render")?.addEventListener("click", () => {
    renderSelectedGraph().catch((error) => setStatus(error.message, "error"));
  });
  document.getElementById("create-workflow")?.addEventListener("click", () => {
    createWorkflowFromPrompt().catch((error) =>
      setStatus(error.message, "error")
    );
  });
  document.getElementById("fullscreen")?.addEventListener("click", async () => {
    const mode =
      hostContext?.displayMode === "fullscreen" ? "inline" : "fullscreen";
    if (!canRequestDisplayMode(mode)) {
      setStatus(`${mode} display mode is not available in this host`, "error");
      return;
    }
    setBusyAction("display-mode", true);
    try {
      await app.requestDisplayMode({ mode });
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : String(error),
        "error"
      );
    } finally {
      setBusyAction("display-mode", false);
    }
  });
  document.querySelectorAll<HTMLElement>(".node").forEach((el) => {
    el.addEventListener("click", () => {
      selectedNodeId = el.dataset.nodeId || "";
      render();
      void syncModelContext();
    });
  });
  updateDisplayModeControl();
  updateBusyControls();
}

function currentDisplayMode() {
  return hostContext?.displayMode || "inline";
}

function canRequestDisplayMode(mode: string) {
  const modes = hostContext?.availableDisplayModes;
  if (!modes || modes.length === 0)
    return mode === "inline" || mode === "fullscreen";
  return (modes as readonly string[]).includes(mode);
}

function setBusyAction(action: typeof busyAction, isBusy: boolean) {
  busyAction = isBusy ? action : busyAction === action ? null : busyAction;
  updateBusyControls();
}

function updateBusyControls() {
  const renderButton = document.getElementById(
    "render"
  ) as HTMLButtonElement | null;
  const createButton = document.getElementById(
    "create-workflow"
  ) as HTMLButtonElement | null;
  const fullscreenButton = document.getElementById(
    "fullscreen"
  ) as HTMLButtonElement | null;
  if (renderButton) {
    renderButton.disabled = busyAction !== null;
    renderButton.textContent =
      busyAction === "render" ? "Rendering…" : "Render graph";
  }
  if (createButton) {
    createButton.disabled = busyAction !== null;
    createButton.textContent =
      busyAction === "create" ? "Generating…" : "Generate workflow";
  }
  if (fullscreenButton) {
    fullscreenButton.disabled = busyAction !== null;
  }
}

function updateDisplayModeControl() {
  const button = document.getElementById(
    "fullscreen"
  ) as HTMLButtonElement | null;
  if (!button) return;
  const displayMode = currentDisplayMode();
  const targetMode = displayMode === "fullscreen" ? "inline" : "fullscreen";
  const canToggle = canRequestDisplayMode(targetMode);
  button.hidden = !canToggle;
  button.textContent =
    displayMode === "fullscreen" ? "Inline view" : "Fullscreen";
  button.setAttribute("aria-pressed", String(displayMode === "fullscreen"));
  button.title =
    displayMode === "fullscreen"
      ? "Return to inline view"
      : "Open fullscreen workbench";
}

function applyHostChrome() {
  document.body.dataset.displayMode = currentDisplayMode();
  if (hostContext?.theme) applyDocumentTheme(hostContext.theme);
  if (hostContext?.styles?.variables)
    applyHostStyleVariables(hostContext.styles.variables);
  if (hostContext?.styles?.css?.fonts)
    applyHostFonts(hostContext.styles.css.fonts);
  if (hostContext?.containerDimensions) {
    const dimensions = hostContext.containerDimensions;
    const width =
      "width" in dimensions && dimensions.width
        ? dimensions.width
        : "maxWidth" in dimensions
          ? dimensions.maxWidth
          : undefined;
    const height =
      "height" in dimensions && dimensions.height
        ? dimensions.height
        : "maxHeight" in dimensions
          ? dimensions.maxHeight
          : undefined;
    if (width) document.body.style.setProperty("--host-width", `${width}px`);
    if (height) document.body.style.setProperty("--host-height", `${height}px`);
  }
  updateDisplayModeControl();
  updateBusyControls();
}

app.ontoolresult = async (result) => {
  bootstrap = (result.structuredContent as BootstrapState) || {};
  workflows = bootstrap.workflows ?? [];
  selectedWorkflowId =
    bootstrap.selectedWorkflowId ||
    bootstrap.workflow?.id ||
    bootstrap.project?.defaultWorkflowId ||
    workflows[0]?.id ||
    "";
  graph = bootstrap.graph ?? null;
  selectedNodeId =
    bootstrap.graphSummary?.defaultSelectedNodeId ||
    graph?.defaultSelected ||
    graph?.nodes?.[0]?.id ||
    "";
  render();
  if (bootstrap.ok === false) {
    const message =
      typeof bootstrap.error === "string"
        ? bootstrap.error
        : bootstrap.error?.message;
    setStatus(message || "Workbench opened with errors", "error");
  }
  if ((!graph || bootstrap.graphHydration?.truncated) && selectedWorkflowId) {
    await renderSelectedGraph().catch((error) =>
      setStatus(error.message, "error")
    );
  } else {
    void syncModelContext();
  }
};

app.onhostcontextchanged = (ctx) => {
  hostContext = { ...hostContext, ...ctx };
  applyHostChrome();
};

app.onteardown = async () => {
  // Future run-event polling/animations should be stopped here before unmount.
  return {};
};

app.onerror = (error) => {
  console.error(error);
  setStatus(error instanceof Error ? error.message : String(error), "error");
};

async function main() {
  root.innerHTML = `<div class="loading">Connecting to MCP host…</div>`;
  await app.connect();
  hostContext = app.getHostContext();
  if (!workflows.length) {
    await refreshWorkflows().catch((error) =>
      setStatus(error.message, "error")
    );
  }
  render();
  if (!graph && selectedWorkflowId) {
    await renderSelectedGraph().catch((error) =>
      setStatus(error.message, "error")
    );
  } else {
    void syncModelContext();
  }
}

main().catch((error) => {
  console.error(error);
  root.innerHTML = `<div class="loading error">${escapeHtml(error.message || error)}</div>`;
});
