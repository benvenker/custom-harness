---
id: "adr_0002-prototype-before-poolside-studio-port"
date: "2026-05-06"
time: "12:00:00"
source_type: "markdown"
filepath: "docs/adr/0002-prototype-before-poolside-studio-port.md"
title: "Prototype before Poolside Studio port"
category: "adr"
---
# Prototype before Poolside Studio port

Status: accepted

`custom-harness` is an incubation repo for the Smithers Studio feature, not the intended long-term application boundary. We are prototyping the workflow authoring, preview, launch, and inspection UX here so the Smithers integration model can be made concrete before porting it into Poolside Studio. The eventual artifact should be a Poolside Studio feature module with renderer UI, Electron services/IPC, the Smithers runtime adapter, project initialization/repair, and overlay persistence, while Smithers itself remains the runtime rather than being reimplemented by Studio.