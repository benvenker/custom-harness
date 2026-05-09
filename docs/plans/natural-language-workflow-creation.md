# Natural-language Smithers workflow creation

## Goal

Let a user or agent describe the workflow they want in natural language and get back a **draft Smithers workflow** that is immediately inspectable, editable, and runnable through the existing CustomHarness project-mode UI.

The draft must be an ordinary Smithers workflow-pack artifact, not a CustomHarness-only graph IR:

- source lives in `.smithers/workflows/*.tsx`
- prompt/model/label edits are source-backed and use the same Studio controls we already have
- graph preview is produced by Smithers render APIs
- runs execute through Smithers and persist in Smithers SQLite
- historical inspection remains frame-backed/read-only

This is the logical next slice after read-only/live/historical inspection: we can now trust the viewer, so we should make it easy to create new workflows for the viewer.

## Research notes

### MCP code execution / Anthropic

Anthropic’s “Code execution with MCP” argues that large MCP tool surfaces should often be exposed to agents as **code APIs** rather than hundreds of direct tool calls.

Useful takeaways for CustomHarness:

- **Progressive disclosure:** agents should load only the APIs/types they need, not every tool definition up front.
- **Typed filesystem/API surface:** a TypeScript wrapper around capabilities is easier for agents to compose than flat tool calls.
- **Context-efficient intermediate state:** generated code can filter, transform, and join data without sending all intermediate data back through the model.
- **State persistence:** code execution can write intermediate artifacts that later executions reuse.
- **Sandbox requirement:** generated code must run with resource limits, monitoring, and an explicit capability boundary.

Source: <https://www.anthropic.com/engineering/code-execution-with-mcp>

### Cloudflare Code Mode / Dynamic Workers

Cloudflare Codemode gives the LLM a single `code` tool. The LLM writes an async JavaScript function against generated TypeScript definitions. The function runs in an isolated Worker sandbox and calls host tools through RPC.

Useful takeaways:

- Generate concise **TypeScript declarations** from the host tool surface.
- Give the model one high-leverage code-execution tool when it needs chaining, conditionals, loops, or multi-step orchestration.
- Keep network blocked by default (`globalOutbound: null`); expose only explicit host capabilities.
- Capture console logs separately from returned results.
- Implement a minimal executor interface: `execute(code, fns) -> { result, error, logs }`.
- Code mode is not always right: single simple operations should stay normal tools.
- Approval-required tools are a known weak spot for code mode; keep destructive/approval-gated operations outside the code tool until the approval story is explicit.

Sources:

- <https://developers.cloudflare.com/agents/api-reference/codemode/>
- <https://blog.cloudflare.com/dynamic-workers/>

### Cloudflare durable agents/workflows

Cloudflare’s Agent + Workflow split maps closely to the Smithers-first direction:

- Agents handle realtime interaction and stateful chat.
- Workflows handle durable, retryable, multi-step execution.
- Each workflow step is a replayable/retryable unit.
- Long-running work should be visible through progress updates, not hidden behind one request.

For CustomHarness, Smithers already owns the durable workflow runtime. The creation feature should not introduce another durable executor; it should author Smithers source and let Smithers run it.

Source: <https://developers.cloudflare.com/workflows/get-started/durable-agents/>

## Product shape

### User-facing flow

1. User clicks **New workflow from prompt** or invokes an agent/CLI/MCP tool.
2. User describes the desired graph:
   - “Take a bug report, reproduce it, inspect logs, propose a fix, then run tests.”
   - “Fan out to three planning agents, synthesize, then run an engineering review gate.”
3. System creates a draft Smithers workflow source file.
4. CustomHarness immediately opens the generated draft in project-mode preview.
5. User edits prompts/models/labels using the existing source-backed controls.
6. User starts a full run through Smithers.
7. Historical inspection remains tied to the resulting Smithers run frames.

### Agent-facing flow

Expose the same capability as a small typed authoring API:

```ts
interface WorkflowAuthoringApi {
  createDraft(input: {
    projectRoot: string;
    workflowId?: string;
    description: string;
    mode?: "simple" | "fanout" | "review-gate" | "custom";
  }): Promise<WorkflowDraftResult>;

  renderDraft(input: {
    projectRoot: string;
    workflowId: string;
    sampleInput?: Record<string, unknown>;
  }): Promise<GraphRenderResult>;

  verifyDraft(input: {
    projectRoot: string;
    workflowId: string;
  }): Promise<VerificationResult>;

  applySourceEdit(input: {
    projectRoot: string;
    workflowId: string;
    source: string;
  }): Promise<GraphRenderResult>;
}
```

A future MCP/code-mode wrapper can expose this API as:

- ordinary MCP tools for simple calls (`createDraft`, `renderDraft`, `verifyDraft`)
- a single code-mode `execute` tool for agents that need multi-step orchestration across docs, source edits, renders, and repairs

## Draft artifact model

A draft is ordinary Smithers source plus provenance docs:

```txt
.smithers/workflows/<workflow-id>.tsx
.smithers/docs/workflows/<workflow-id>.md
.poolside/workflows/creation-traces/<workflow-id>/<timestamp>.md   # optional trace/eval material
```

No CustomHarness draft database is required for the MVP.

Draft-ness can be represented in source/doc metadata, not runtime state:

```ts
const editable = {
  workflow: {
    status: "draft",
    description: "...",
  },
  agents: { ... },
  tasks: { ... },
};
```

The UI can treat any selected workflow as editable if its rendered Smithers task metadata exposes `meta.editor` fields.

## Generated workflow source pattern

Generated workflows should be boring, source-backed, and easy to patch:

```tsx
const editable = {
  agents: {
    primary: { model: "openai/gpt-5.5" },
  },
  tasks: {
    "reproduce": {
      label: "Reproduce",
      prompt: "Reproduce the issue from {{userPrompt}} and capture exact steps.",
    },
  },
} as const;
```

Each generated `Task` should include `meta.editor` fields:

```tsx
<Task
  id="reproduce"
  label={editable.tasks.reproduce.label}
  agent={agents.primary}
  meta={{
    editor: {
      editable: true,
      fields: {
        label: {
          label: "Display label",
          kind: "text",
          sourcePath: ["tasks", "reproduce", "label"],
        },
        prompt: {
          label: "Prompt template",
          kind: "multiline-text",
          sourcePath: ["tasks", "reproduce", "prompt"],
        },
        model: {
          label: "Model",
          kind: "model-select",
          sourcePath: ["agents", "primary", "model"],
        },
      },
    },
  }}
>
  {renderTemplate(editable.tasks.reproduce.prompt, { userPrompt })}
</Task>
```

Important: use `meta.editor`, not the older `meta.studio` spelling.

## Proposed implementation phases

### Phase 1 — Local CLI/API draft generator

Build the smallest deterministic authoring endpoint/command:

```bash
bun src/index.ts workflow create-draft \
  --project /path/to/project \
  --workflow bug-triage \
  --description "Reproduce a bug, inspect likely files, propose a fix, run tests"
```

Server API equivalent:

```http
POST /api/workflows/drafts
{
  "workflowId": "bug-triage",
  "description": "..."
}
```

MVP behavior:

1. Convert natural language to a constrained `WorkflowDraftSpec` JSON object.
2. Generate `.smithers/workflows/<workflow-id>.tsx` from templates.
3. Generate `.smithers/docs/workflows/<workflow-id>.md` with spec/provenance.
4. Render with existing graph endpoint.
5. Return workflow ID, source path, graph preview, verification status, and viewer URL.

For the first cut, prefer constrained templates over arbitrary source generation:

- sequence
- parallel fanout + synthesis
- review gate
- map/reduce-style fanout

### Phase 2 — Repair loop

Add a Smithers render verification loop:

1. `workflow list --format json`
2. `workflow path <id> --format json`
3. `graph .smithers/workflows/<id>.tsx --input '{}' --format json`
4. If render fails, run a repair pass against the generated source and error output.
5. Save trace material.

This mirrors the existing `smithers-workflow-authoring` skill but makes it productized and repeatable.

### Phase 3 — UI creation flow

Add a project-mode UI entry point:

- top-level **New workflow from prompt** button
- modal/inspector panel with description textarea and optional workflow ID
- create draft, then select/open it as the current workflow
- render graph as `Current Workflow Source preview`
- show creation/verification messages in the existing action status area

The generated draft should then behave like existing workflows:

- node prompt/model/label edits use source-backed controls
- Save to workflow re-renders current preview
- Start Full Run launches Smithers
- historical runs inspect persisted frames

### Phase 4 — Agent/MCP surface

Expose the same authoring API as an MCP server.

Recommended first MCP shape:

- `workflow_create_draft`
- `workflow_render_graph`
- `workflow_verify`
- `workflow_read_source`
- `workflow_write_source`

Recommended code-mode shape after the simple tools work:

- `search` — find relevant workflow templates/docs/examples
- `execute` — run sandboxed TypeScript against a typed `WorkflowAuthoringApi`

The code-mode executor should have:

- no ambient filesystem writes
- no ambient network
- explicit project-root allowlist
- timeout
- captured logs
- dry-run/plan mode for source edits
- approval boundary before applying generated source edits

Do **not** put destructive operations or run launch behind code mode until approval semantics are explicit.

## Safety and trust boundaries

Natural-language workflow creation produces executable TypeScript. Rendering a Smithers workflow imports that TypeScript. That is powerful and dangerous.

MVP safety rules:

- Only write inside the selected project root.
- Only write expected workflow-pack paths.
- Generate from templates where possible.
- Require render verification before handing back a viewer link.
- Treat draft source as untrusted until it renders in a constrained verification process.
- Never manually mutate Smithers SQLite tables.
- Never use current source as fallback for historical run inspection.

Future hardening:

- render draft workflows in a child process with timeout and controlled env
- consider a sandbox executor for generated source verification
- add static checks for forbidden imports/side effects before render
- separate “generate source” from “apply source” with a reviewable diff

## WorkflowDraftSpec sketch

The spec is an authoring intermediate, not a persisted runtime IR:

```ts
type WorkflowDraftSpec = {
  workflowId: string;
  displayName: string;
  description: string;
  input: {
    fields: Array<{ name: string; label: string; kind: "text" | "json" }>;
  };
  agents: Array<{
    id: string;
    label: string;
    model: string;
  }>;
  nodes: Array<
    | { type: "task"; id: string; label: string; agentId: string; prompt: string; outputs?: string[] }
    | { type: "parallel"; id: string; children: string[] }
    | { type: "sequence"; id: string; children: string[] }
  >;
  edges: Array<{ from: string; to: string; label?: string }>;
  outputs: Array<{ name: string; description: string }>;
  assumptions: string[];
  openQuestions: string[];
};
```

This gives the generator a constrained plan, but Smithers source remains canonical once written.

## Open questions

1. Should draft workflows live directly in `.smithers/workflows/` or in a subfolder that Smithers discovery also supports?
2. Do we want a “publish” action, or is saving the `.tsx` file enough?
3. Should the first version use a local LLM call, an external agent, or deterministic templates plus user editing?
4. Should generated workflows default to `OpenAIAgent`, `ClaudeCodeAgent`, `PiAgent`, or project-configured agents?
5. How much source-edit approval is required when the caller is an MCP/code-mode agent?
6. What is the minimum sandbox we need before we are comfortable importing generated workflow source?

## Suggested branch tasks

1. Define `WorkflowDraftSpec` and template generator.
2. Add CLI command: `workflow create-draft`.
3. Add server endpoint: `POST /api/workflows/drafts`.
4. Generate source-backed `meta.editor` fields by default.
5. Verify generated draft through Smithers graph render.
6. Add UI button/modal to create and open a draft.
7. Add tests for draft generation, source edit persistence, and no historical/live provenance mixing.
8. Follow with an MCP/code-mode spike after the local API is stable.
