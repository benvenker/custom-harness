---
title: Smithers Orchestrator
type: tool
created: 2026-05-07
last_updated: 2026-05-07
related: ["[[Custom Harness]]", "[[Workflow Discovery]]"]
sources: ["_research", "_CONTEXT"]
---

# Smithers Orchestrator

Smithers Orchestrator is a workflow execution engine that provides durable, resumable orchestration of multi-agent workflows. The tool serves as the canonical runtime for the Custom Harness project.

## Key Capabilities

**Workflow Management**: Discovers workflows from `.tsx` files in `.smithers/workflows/` directory, enforcing lowercase kebab-case IDs derived from filenames. Provides commands for listing (`workflow list`), running (`workflow run <name>`), and creating (`workflow create <name>`) workflows.

**Execution Model**: Renders JSX workflows to directed graphs, extracts task descriptors, computes ready tasks based on dependencies and concurrency limits, executes tasks, and persists outputs to SQLite before re-rendering. This render-execute-persist-re-render cycle enables dynamic workflow adaptation.

**State Persistence**: Uses SQLite database (`smithers.db`) to store run identity, frame snapshots, node states, outputs, and approval status. Event logs are written to NDJSON format at `executions/<runId>/logs/stream.ndjson` for observability.

**Resume and Recovery**: Supports resuming interrupted runs by loading state from SQLite, skipping completed tasks, and abandoning stale in-progress attempts older than 15 minutes. Requires workflow hash and VCS revision compatibility for safety.

## Integration Points

The CLI exposes stable integration surfaces through commands like `graph` for non-executing previews and `up` for file-based execution. The `workflow run` command is a wrapper over `up` that resolves discovered workflow IDs.

Graph rendering via `renderFrame` returns `GraphSnapshot` objects containing run ID, frame number, XML representation, and task descriptors. This enables preview generation without task execution or state mutation.

## Package Structure

Version 0.18.0 is distributed as `smthrs` on npm, with CLI binary named `smithers`. The package exports facade functions and depends on specialized packages for CLI, engine, database, graph, scheduler, server, and time-travel capabilities.

## Workflow Pack Convention

Smithers defines a standard project structure via `bunx smthrs init` that creates `.smithers/` containing workflows, prompts, components, package configuration, and execution directories. This convention eliminates the need for custom discovery rules or pack layouts.