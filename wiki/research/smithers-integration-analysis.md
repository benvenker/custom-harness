---
title: Smithers Integration Analysis
type: research
created: 2026-05-07
last_updated: 2026-05-07
related: ["[[Smithers Orchestrator]]", "[[Alpha Plan Simplification]]"]
sources: ["_research"]
---

# Smithers Integration Analysis

Comprehensive research into Smithers orchestrator capabilities revealing that custom orchestration implementation is unnecessary for the alpha plan.

## Key Discovery

Smithers already owns most required orchestration behaviors: workflow discovery, graph rendering, scheduling, max concurrency, durable SQLite state, resume capability, approvals, run inspection, and event/log surfaces. Custom Harness can simplify to thin integration around workflow-pack files and CLI invocation.

## Technical Findings

**Workflow Pack Structure**: `bunx smithers-orchestrator init` generates complete `.smithers/` structure including workflows, prompts, components, configuration, tickets, and execution directories. Documentation recommends starting with this pack rather than manual assembly.

**Discovery Rules**: CLI discovers `.tsx` files directly under `.smithers/workflows/`, sorts them, and derives IDs from filenames without extension. Enforces lowercase kebab-case naming. Display metadata comes from inline comments.

**Execution Model**: `workflow run` wraps `up` command, delegating to the same execution path. Graph rendering via `renderFrame` is non-executing by design, returning `GraphSnapshot` objects without persistence or state mutation.

**State Management**: Run behavior is durable and resumable through SQLite persistence. Resume loads state, skips completed tasks, abandons stale attempts over 15 minutes old, and requires workflow hash compatibility.

## Integration Implications

**Simplification Opportunities**: No need for custom scheduling, concurrency management, resume logic, approval systems, event logging, or SQLite persistence. Smithers provides these behaviors natively.

**Integration Points**: Use `graph`/`renderFrame` for previews, `workflow list/path/run` for discovered workflows, `up <file>` for explicit files. Leverage stable integration shapes through `GraphSnapshot`, `TaskDescriptor`, and `RunOptions` types.

**Constraints**: Keep only harness-level concerns like version pinning (`bunx smithers-orchestrator`), task ID stability guidance, input validation, and status forwarding. Avoid custom pack layouts or discovery rules.

## Evidence Quality

Research confidence is high for workflow pack layout, discovery IDs, graph behavior, and run/resume behavior based on official documentation and published package source code examination. Medium confidence for specific alpha plan mapping due to plan details not being included in research scope.