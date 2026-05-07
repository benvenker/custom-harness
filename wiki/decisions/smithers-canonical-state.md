---
title: Smithers Canonical State
type: decision
created: 2026-05-06
last_updated: 2026-05-07
related: ["[[Custom Harness]]", "[[Studio Integration Strategy]]"]
sources: ["adr_0001-runs-in-smithers-canonical-location"]
---

# Smithers Canonical State

The decision to converge on Smithers as the canonical source of run state rather than maintaining parallel databases or custom run tracking systems.

## The Decision

Studio-launched runs use Smithers' runtime, database, and logging conventions so that Smithers CLI commands (`ps`, `chat`, `logs`, `fork`) see the same runs the Studio shows, and vice versa. This eliminates divergence between AI agents using Smithers CLI and Studio UI surfaces.

## What Canonical State Means

**Run Identity**: Lives in `_smithers_runs` table in the nearest `smithers.db` file, including run ID, status, workflow path/name, and parent/fork relationships.

**Event Logs**: Default to `<workspace>/executions/<runId>/logs/stream.ndjson` format, though this is observability evidence rather than primary state.

**Execution State**: Stored in SQLite tables including frame snapshots, node states, task attempts, outputs, approvals, and signals across `_smithers_*` tables and per-schema output tables.

## Studio Overlays

Studio-specific metadata like rendered graph layouts, prompt baselines, and UI annotations are treated as optional decoration, not run state. Overlays must be optional (runs work without them) and never authoritative (removing overlays doesn't affect Smithers operation).

## Rejected Alternatives

**Status Quo**: Maintaining separate `<repo>/runs/<runId>/` trees would perpetuate divergence between agent CLI tools and Studio interfaces.

**Studio Sidecar**: Placing Studio metadata under `.smithers/executions/<runId>/studio/` was considered but creates ownership ambiguity within Smithers-managed directories.

## Implementation Impact

The legacy `runs/` tree becomes deprecated, requiring migration or acceptance of data loss. Studio's `runs/index.json` becomes a derived view computed from Smithers DB state rather than a primary database.

Studio launch code must use Smithers runtime APIs rather than creating fake runs through JSON files or partial DB insertions. All Studio listing and inspection must work from Smithers DB state first, with logs and overlays as optional enrichments.