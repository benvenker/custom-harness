# Triage Labels

The skills speak in terms of five canonical triage roles. In this repo, map those roles to Beads/local-markdown labels, not custom Beads statuses.

Beads native statuses remain: `open`, `deferred`, `in_progress`, `closed`.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (for example, "apply the AFK-ready triage label"), apply the corresponding label string with Beads:

```bash
br label add <id> ready-for-agent
```

For markdown-only planning files under `.scratch/`, record the label string near the top of the issue file.
