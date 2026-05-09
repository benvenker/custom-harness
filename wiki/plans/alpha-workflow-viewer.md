---
title: Alpha Workflow Viewer
type: plan
created: 2026-05-07
last_updated: 2026-05-07
related: ["[[Custom Harness]]", "[[Meta Smithers Editing]]"]
sources: ["plans_alpha-workflow-authoring-and-viewer", "plans_meta-smithers-editing"]
---

# Alpha Workflow Viewer

The alpha implementation plan for Smithers workflow authoring and viewer loop, designed to provide basic workflow visualization and execution capabilities.

## Core Loop

The alpha establishes a workflow authoring and viewer cycle where users can discover workflows in `.smithers/workflows/`, preview them as graphs without execution, and launch runs with basic monitoring. The focus is on proving the integration pattern rather than full feature coverage.

## Implementation Approach

**Project-Aware Endpoints**: Add server endpoints that discover workflows from specified projects and return `RenderGraph` objects built from Smithers `GraphSnapshot` data, while maintaining existing `smithersGraph.ts` renderer mapper.

**Smithers CLI Integration**: Use Smithers CLI from project root for discovery and execution, passing `--root <projectRoot>` to ensure canonical `.smithers/executions/<runId>/logs` placement.

**Preview Strategy**: For fresh graph previews, avoid persisted outputs by either using unique preview run IDs known to have no outputs or maintaining empty-output in-process rendering behind the adapter.

## Scope Boundaries

The alpha avoids implementing full CLI hierarchy before dogfooding. Server-based project/workflow handling, workflow discovery, render endpoints, and run endpoints provide sufficient foundation for the alpha validation loop.

## Integration Pattern

Rather than reimplementing orchestration, the alpha leverages existing Smithers graph rendering and HTTP viewer components. The shortest path adds project-aware endpoints returning discovered workflows and `RenderGraph` objects while preserving current browser compatibility through existing JSON response formats.

## Meta Editing Extension

A complementary meta-editing plan extends the alpha with Smithers workflow editing capabilities, enabling inline workflow modification and rapid iteration cycles within the viewer interface.