# Prototype before Poolside Studio port

Status: accepted

`custom-harness` is an incubation repo for the Smithers Studio feature, not the intended long-term application boundary. We are prototyping the workflow authoring, preview, launch, and inspection UX here so the Smithers integration model can be made concrete before porting it into Poolside Studio. The eventual artifact should be a Poolside Studio feature module with renderer UI, Electron services/IPC, the Smithers runtime adapter, project initialization/repair, and overlay persistence, while Smithers itself remains the runtime rather than being reimplemented by Studio.
