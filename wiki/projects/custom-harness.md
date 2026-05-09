---
title: Custom Harness
type: project
created: 2026-05-07
last_updated: 2026-05-07
related: ["[[Smithers Orchestrator]]", "[[Poolside Studio Integration]]"]
sources: ["_research", "_CONTEXT", "plans_alpha-workflow-authoring-and-viewer"]
---

# Custom Harness

Custom Harness is a development project building a thin integration layer around Smithers workflow orchestration for Poolside Studio. The project evolved from reimplementing orchestration semantics to leveraging Smithers' existing capabilities as a canonical runtime.

## Purpose

The project serves as a bridge between Poolside Studio's workflow authoring interface and Smithers' orchestration engine. Rather than maintaining parallel run databases or custom scheduling logic, Custom Harness converges on Smithers as the source of truth for run state, execution, and persistence.

## Architecture

The system follows a "Smithers-canonical" approach where workflow discovery, graph rendering, scheduling, concurrency management, durable state, resume capability, approvals, and event logging are owned by Smithers. Custom Harness provides only harness-level constraints around version pinning, task ID stability, input validation, and status forwarding.

Key architectural decisions:
- Workflow pack structure follows Smithers conventions (`.smithers/workflows/`, `.smithers/executions/`)
- Run identity lives in Smithers SQLite database (`_smithers_runs` table)
- Event logs default to `<workspace>/executions/<runId>/logs/stream.ndjson`
- Studio overlays are optional decoration, not authoritative state

## Evolution

The project transitioned from custom orchestration to Smithers integration based on research showing Smithers already provided the needed orchestration behaviors. This shift simplified the alpha plan from reimplementation to thin integration around existing Smithers workflow-pack files and CLI invocation.

## Current Status

As of 2026-05-07, the project maintains legacy `runs/` artifacts for prototype compatibility while working toward Smithers-canonical state. The implementation includes custom graph rendering and HTTP viewer components that will be adapted to consume Smithers `GraphSnapshot` data.