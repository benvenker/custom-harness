# Pi Coordination

This repo primarily uses Pi as the coding-agent harness. The following Pi extensions are installed and available in sessions after Pi reload/restart:

- `pi-messenger` — shared project mesh, file reservations, activity feed, and Crew task orchestration.
- `pi-intercom` — direct 1:1 messaging between local Pi sessions.
- `pi-review-loop` — repeated plan/code review loop until no issues are found.

## Project Pi configuration

Tracked project files:

- `.pi/pi-messenger.json` — project-level messenger config.
- `.pi/messenger/crew/config.json` — project-level Crew execution config.
- `.pi/messenger/crew/skills/custom-harness-smithers.md` — project Crew skill for Smithers work.

Ignored runtime files:

- `.pi/messenger/feed.jsonl`
- `.pi/messenger/crew/tasks/**`
- `.pi/messenger/crew/artifacts/**`
- other generated project coordination state not explicitly unignored in `.gitignore`

## pi-messenger usage

Use `pi_messenger` for same-repo multi-agent coordination, especially when multiple agents may edit files concurrently.

Common commands:

```ts
pi_messenger({ action: "join" });
pi_messenger({ action: "list" });
pi_messenger({ action: "feed", limit: 20 });
pi_messenger({
  action: "reserve",
  paths: ["src/smithersProject/"],
  reason: "Run reader changes",
});
pi_messenger({ action: "release" });
```

Guidelines:

- Join the mesh for multi-agent work or when using Crew.
- Reserve paths before editing in parallel sessions.
- Release reservations when done.
- Use `feed` to understand recent project activity.
- Use Crew only for work that benefits from multi-agent orchestration; this repo also uses Beads (`br`) as the primary issue tracker.

## Crew usage

Crew can plan and execute tasks from a PRD/spec/plan, but for this repo Beads remains the durable issue tracker. Prefer converting accepted plans to Beads for normal work tracking.

Use Crew when explicitly requested for parallel implementation or review:

```ts
pi_messenger({
  action: "plan",
  prd: "docs/plans/some-plan.md",
  autoWork: false,
});
pi_messenger({ action: "review", target: "plan", type: "plan" });
pi_messenger({ action: "work", autonomous: true, concurrency: 2 });
```

Crew workers should load `.pi/messenger/crew/skills/custom-harness-smithers.md` for Smithers-related tasks.

## pi-intercom usage

Use `intercom` for targeted 1:1 coordination with another local Pi session.

Use it when:

- coordinating planner/worker sessions,
- asking a specific session for a blocking decision,
- sending findings to another session in a related codebase,
- responding to subagent/supervisor escalations.

Prefer `send` for notifications and `ask` only when blocked waiting for a response:

```ts
intercom({ action: "list" });
intercom({ action: "send", to: "worker", message: "Task context..." });
intercom({
  action: "ask",
  to: "planner",
  message: "Need decision on X before proceeding.",
});
intercom({ action: "reply", message: "Decision: use X." });
```

Do not use intercom for unrelated repos, trivial questions, or decisions the current agent can make from the docs/code.

## pi-review-loop usage

Use `review_loop` for plan review before implementation and code review before declaring work done.

Recommended defaults for this repo:

```ts
review_loop({ start: true, freshContext: true, maxIterations: 3 });
```

Use focus strings for targeted reviews:

```ts
review_loop({
  start: true,
  freshContext: true,
  maxIterations: 3,
  focus: "focus on Smithers provenance and current-source fallbacks",
});
```

Review loop should not replace tests. After review fixes, still run the relevant validation commands from the bead/plan.
