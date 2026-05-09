# custom-harness

Smithers-first durable outcome runner. The CLI accepts a user goal, records a
planner decision as `path: "harness" | "workflow"` for artifact compatibility,
then executes either one Smithers CLI-agent task or a deterministic workflow DAG.

```bash
bun src/index.ts --goal "summarize this repo" --context "focus on tests"
```

Run artifacts are written under `runs/<run-id>/` with `run.json`, `plan.json`,
`events.jsonl`, and task artifacts for the web inspector.
