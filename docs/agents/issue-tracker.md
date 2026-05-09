# Issue tracker: Beads + Local Markdown

Issues for this repo are tracked locally with Beads (`br`) in `.beads/`.

Use `.scratch/` for PRDs, planning notes, and markdown issue breakdowns when a skill expects file-based planning artifacts.

## Beads conventions

- Use `br` for issue lifecycle: create, update, label, comment, close.
- Use `br --json` when output will be parsed by an agent.
- Use Beads statuses as native lifecycle states: `open`, `deferred`, `in_progress`, `closed`.
- Use triage roles as labels, not custom statuses. See `triage-labels.md`.
- Do not edit `.beads/issues.jsonl` manually except for merge-conflict repair.
- Run `br sync --flush-only` before committing Beads changes.

## Common commands

```bash
br ready --json
br create "Title" --type task --priority 2 --description "Details"
br update <id> --status in_progress --assignee "$(git config user.email)"
br label add <id> ready-for-agent
br comments add <id> "Implemented X; verified with <command>."
br close <id> --reason "Completed and verified"
br sync --flush-only
```

## Local markdown convention

When a skill says "publish a PRD" or needs markdown planning files, create files under `.scratch/<feature-slug>/`.

Suggested layout:

```txt
.scratch/<feature-slug>/
├── PRD.md
└── issues/
    ├── 01-first-slice.md
    └── 02-second-slice.md
```

If implementation issues are ready to track, convert them to Beads and link back to the `.scratch/` plan path.
