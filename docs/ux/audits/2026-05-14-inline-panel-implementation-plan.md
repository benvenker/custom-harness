# Inline Panel UX Fixes — Implementation Plan

**Audit:** `docs/ux/audits/2026-05-14-inline-panel-ux-audit.md`
**Files:** `src/mcp/workbenchApp.ts`, `src/server.ts`
**Constraint:** Changes target inline display mode only — fullscreen layout must not regress.
**Validation:** `bun tsc --noEmit && bun test tests/server.test.ts tests/workflowViewer.ui.test.ts`

---

## Phase 1 — Reorder inline sections (I-1)

**What:** In `render()`, emit a different section order for inline mode.
The graph+inspector should appear before the toolbar controls.

**Approach:**

- Add a `currentDisplayMode()` check at the top of `render()`.
- For inline: header → workflow-identity row → workspace → collapsed-preview-input → collapsed-creator.
- For fullscreen (and default/unknown): keep existing order unchanged.

**Key constraint:** The DOM IDs (`#workflow`, `#prompt`, `#render`, `#create-prompt`, `#create-workflow`, `#fullscreen`) and `attachEvents()` bindings must still work regardless of order.

**Files:** `src/mcp/workbenchApp.ts:311-351`
**Risk:** Medium — touching the main render function. Tests will catch regressions.

---

## Phase 2 — Rename "Runtime input" → "Preview input" (I-2)

**What:** Change label text and add helper copy.

**Approach:**

- In `render()`, change the `<label>` from `Runtime input` to `Preview input`.
- Add a `<small>` helper: `Renders the graph preview. Does not run the workflow.`
- In inline mode, wrap the prompt+render section in a `<details>` disclosure (collapsed by default, open if graph is already rendered from a non-default prompt).

**Files:** `src/mcp/workbenchApp.ts:326-333`
**Risk:** Low — label/copy changes. Disclosure collapse needs CSS.

---

## Phase 3 — Move creator below workspace (I-3)

**What:** In inline mode, the `<details class="creator-panel">` should appear after the workspace section, not before it.

**Approach:** Already handled by Phase 1 reordering. This phase just verifies the new position works visually and the expanded state doesn't push the graph off-screen.

**Files:** `src/mcp/workbenchApp.ts:334-344` (position), `src/server.ts` (inline CSS for creator-panel)
**Risk:** Low.

---

## Phase 4 — Compact inspector in inline mode (I-4)

**What:** Inspector should default to a compact summary bar in inline mode, expandable on click.

**Approach:**

- Wrap the inspector in a `<details>` element for inline mode.
- Summary line: `Selected: [node title]` with type badge and status.
- Expanded: full prompt `<pre>`, metadata, timeline (existing content).
- Auto-open when user clicks a non-default node.
- In fullscreen mode: keep inspector always-visible (current behavior).

**Files:** `src/mcp/workbenchApp.ts` (`renderInspector()` function), `src/server.ts` (inline inspector CSS)
**Risk:** Medium — inspector rendering is shared between modes.

---

## Phase 5 — Improve status feedback (I-5)

**What:** Replace raw truncated workflow ID in status with clean user-facing labels.

**Approach:**

- `setStatus()` messages become:
  - Rendering: `Rendering…`
  - Success: `Preview updated` (no workflow ID)
  - Error: `Could not render: [short message]`
  - Creating: `Generating workflow…`
  - Created: `Workflow created`
- Status element gets a `role="status"` and `aria-live="polite"`.
- In inline mode, reposition status inside the graph title area or action cell.

**Files:** `src/mcp/workbenchApp.ts:139-144, 162-202, 214-247`
**Risk:** Low.

---

## Phase 6 — Unify focus/selection styling (I-6)

**What:** Use a single `--focus-ring` token for all interactive focus states.

**Approach:**

- Add `--focus-ring: var(--accent);` to `:root`.
- Apply to:
  - `select:focus`, `textarea:focus`, `button:focus-visible` → `outline: 2px solid var(--focus-ring)`
  - `.node.selected` → `outline-color: var(--focus-ring)`
  - `.creator-panel summary:focus-visible` → same
- Remove any browser-default orange focus rings.

**Files:** `src/server.ts` (CSS block)
**Risk:** Low — cosmetic only.

---

## Execution Order

```
Phase 1 (reorder)  ← highest impact, most risk → do first with full test pass
Phase 2 (rename)   ← pairs naturally with Phase 1
Phase 3 (creator)  ← verified by Phase 1, minimal extra work
Phase 4 (inspector)← medium risk, test after Phases 1-3 stabilize
Phase 5 (status)   ← low risk, can do anytime
Phase 6 (focus)    ← cosmetic, do last
```

Each phase should end with:

1. `bun tsc --noEmit`
2. `bun test tests/server.test.ts tests/workflowViewer.ui.test.ts`
3. Playwright/CDP screenshot comparison
4. `git add && git commit --amend --no-edit` (or new commit per phase, TBD)

---

## Out of Scope (for later)

- Compact graph node cards (S-3) — layout change that affects fullscreen too
- Inspector copy button (S-4) — nice-to-have, separate PR
- Tab order skip for collapsed creator (S-5) — `tabindex="-1"` on hidden fields
- Workflow picker as identity element (S-2) — larger refactor of the toolbar concept
