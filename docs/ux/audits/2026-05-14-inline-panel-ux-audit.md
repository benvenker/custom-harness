# UX Audit: MCP App Inline Panel

**Date:** 2026-05-14
**Auditor:** Automated (Playwright/Electron CDP at 127.0.0.1:9222)
**Scope:** Initial inline display mode of the Smithers Workflow Workbench MCP app panel
**Artifacts:** `/tmp/custom-harness-ux-audit/*.png`, `/tmp/custom-harness-ux-audit/metrics.json`

---

## Summary

**Score:** 5.5/10 | **Critical:** 0 | **Important:** 6 | **Suggestions:** 5

The inline panel works but feels like a fullscreen authoring app crammed into a 519px side drawer. Workflow selection, runtime input, rendering controls, workflow creation, graph browsing, and node inspection all compete equally for attention.

The panel should default to a **preview/inspection-first** layout, with authoring and creation behind secondary affordances.

---

## Quick Check

| Area              | Status | Notes                                                            |
| ----------------- | :----: | ---------------------------------------------------------------- |
| Navigation        |   🟡   | Fullscreen toggle obvious; graph↔inspector navigation unclear    |
| Forms             |   🟡   | Runtime input and create input compete conceptually              |
| Errors/status     |   🟡   | "Rendered comprehensive-review-workfl…" truncates; feels stale   |
| Accessibility     |   🟡   | Keyboard works, focus visible, but tab order long & context weak |
| Responsive/Inline |   🔴   | Layout too dense for 519px panel                                 |

---

## Measured Layout (inline mode)

```json
{
  "displayMode": "inline",
  "viewport": { "width": 519, "height": 963 },
  "toolbar": { "y": 86.8, "height": 197.6 },
  "creator": { "y": 294.4, "height": 60 },
  "workspace": { "y": 364.4, "height": 590 },
  "inspector": { "y": 774.4, "height": 180 }
}
```

The toolbar+header+creator consume **~300px** before the graph appears. In a 963px panel, that's 31% of vertical space spent on controls before the user sees the actual workflow.

---

## Important Issues

### I-1. Information order is backwards for a preview panel

**Heuristic:** #8 Minimalism, #6 Recognition
**Location:** `src/mcp/workbenchApp.ts:311-351`
**Screenshot:** `03-panel-default-view.png`

Current order:

1. App header (eyebrow + title + subtitle + fullscreen button)
2. Workflow dropdown
3. Runtime input textarea
4. Render button + status
5. New workflow creator disclosure
6. Graph canvas
7. Inspector

The user opens the panel to answer: _"What workflow am I looking at, and what does it do?"_ Instead, the first screenful is dominated by controls.

**Fix:** Reorder for inline mode:

1. Compact header with workflow identity
2. Graph preview (the primary content)
3. Selected node details (compact)
4. Collapsed "Preview with input" section
5. Collapsed "Create a new workflow" section

### I-2. "Runtime input" is too prominent and ambiguous

**Heuristic:** #2 Real-world language, #6 Recognition
**Location:** `src/mcp/workbenchApp.ts:326-329`
**Screenshot:** `05-runtime-input-focused.png`

The label "Runtime input" sounds like an internal API name. It's unclear whether typing here edits the workflow, previews it, starts a run, or just changes how the graph renders.

**Fix:**

- Rename to **"Preview input"**
- Add helper text: _"Used to render this preview. Does not run the workflow."_
- In inline mode, wrap in a disclosure (collapsed by default)

### I-3. Workflow creation interrupts the read path

**Heuristic:** #8 Minimalism, #5 Error prevention
**Location:** `src/mcp/workbenchApp.ts:334-344`
**Screenshot:** `09-creator-expanded.png`

"New workflow from natural language" sits between the toolbar and the graph. Even collapsed, it occupies 60px and breaks the visual flow from controls → content.

**Fix:** Move below the workspace/inspector, or into a compact footer action (`Create workflow…`) that only expands on intentional click.

### I-4. Graph and inspector duplicate content on first load

**Heuristic:** #8 Minimalism, #1 Visibility
**Location:** `src/mcp/workbenchApp.ts:346-351`, `src/server.ts:1201-1212`
**Screenshot:** `13-graph-node-selected.png`

Default view shows graph node content (title, prompt snippet), then immediately repeats the same info in the inspector panel below. In a narrow inline panel this wastes vertical space.

**Fix options:**

- Best: Inspector starts collapsed/compact — just a "Selected: [node name]" bar that expands on tap.
- Alternative: Don't show the inspector until a non-default node is selected.

### I-5. Status feedback is weak and sometimes stale-feeling

**Heuristic:** #1 Visibility, #9 Error recovery
**Location:** `src/mcp/workbenchApp.ts:162-202`, `src/server.ts:1198-1200`
**Screenshot:** `07-render-click-loading.png`

The status line shows:

```
Rendered comprehensive-review-workfl...
```

This truncates the workflow name and reads like developer logging rather than user confirmation.

**Fix:**

- Replace with a compact pill: `Preview updated` / `Rendering…` / `Could not render`
- Don't try to embed the full workflow ID in inline status
- In inline mode, put status adjacent to the graph title rather than the render button

### I-6. Focus styles are visible but inconsistent

**Heuristic:** Accessibility, #4 Consistency
**Location:** `src/server.ts:1190-1196`, node selection CSS around `src/server.ts:1208-1210`
**Screenshot:** `05-runtime-input-focused.png` (orange focus), `13-graph-node-selected.png` (blue selection)

Textareas focus with an orange/yellow ring; graph selection uses blue (`var(--accent)`). Both are visible, but they look like two different apps stitched together.

**Fix:** Use one host-aware focus token consistently:

```css
--focus-ring: var(--accent);
```

Apply to: inputs, buttons, selected graph node, disclosure summary.

---

## Suggestions

### S-1. Reduce header vertical footprint in inline mode

The eyebrow + h1 + subtitle + fullscreen button could be a single compact row:

```
Smithers workflow workbench    [Fullscreen]
comprehensive-review-workflow      [▾]
```

### S-2. Make workflow picker a compact identity element, not a form field

Instead of `<label>Workflow <select>`, show the workflow name as the panel identity with a change affordance.

### S-3. Graph node cards are too tall for inline scrolling

Each node is 118px minimum height. In a 360px graph scroll area, only ~3 nodes are visible. Compact node cards (80px) would show more of the workflow.

### S-4. The inspector `<pre>` prompt block has no copy affordance

Users might want to copy the rendered prompt. Add a small copy button.

### S-5. Tab order should skip the creator panel when collapsed

Currently 6+ Tab presses traverse the full panel including hidden creator fields.

---

## Heuristic Scores

| Heuristic              | Score |
| ---------------------- | ----: |
| 1. Visibility          |     6 |
| 2. Real-world language |     5 |
| 3. User control        |     7 |
| 4. Consistency         |     5 |
| 5. Error prevention    |     6 |
| 6. Recognition         |     5 |
| 7. Flexibility         |     6 |
| 8. Minimalism          |     4 |
| 9. Error recovery      |     6 |
| 10. Documentation      |     6 |

---

## Proposed Inline Layout

```
┌─────────────────────────────────────────────┐
│ Smithers workflow workbench      [Fullscreen]│
│ comprehensive-review-workflow           [▾]  │
├─────────────────────────────────────────────┤
│ ┌ COMPREHENSIVE-REVIEW-WORKFLOW ──────────┐ │
│ │ [Goal] → [Tech Review] → [Biz Review]  │ │
│ │ → [Risk] → [Human Gate] → [Branch]     │ │
│ └─────────────────────────────────────────┘ │
│                                              │
│ ▸ Selected: Initial workflow prompt          │
│   ctx.input.prompt · goal · done             │
│   Describe what this workflow should do...   │
│                                              │
│ ▸ Preview with input                         │
│ ▸ Create a new workflow                      │
└─────────────────────────────────────────────┘
```

---

## Implementation Plan

See `docs/ux/audits/2026-05-14-inline-panel-implementation-plan.md`
