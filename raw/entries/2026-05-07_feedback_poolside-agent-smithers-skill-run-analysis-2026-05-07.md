---
id: "feedback_poolside-agent-smithers-skill-run-analysis-2026-05-07"
date: "2026-05-07"
time: "12:00:00"
source_type: "markdown"
filepath: "docs/feedback/poolside-agent-smithers-skill-run-analysis-2026-05-07.md"
title: "Poolside Agent + Smithers Skill Run Analysis"
category: "feedback"
---
# Poolside Agent + Smithers Skill Run Analysis

Date: 2026-05-07

Source artifacts:

- Log: `/Users/ben/Library/Application Support/Poolside Studio Dev/logs/runs/poolside-studio-2026-05-07T12-10-02-372Z-80ffa82f.log`
- ACP trajectory: `/Users/ben/Library/Application Support/Poolside Studio Dev/trajectories/poolside-skill-context-begin-the-user-explicitly-selected-the-following-skills-f.json`

## Summary

The run ultimately shipped a verified Smithers workflow, but it required many small discovery and repair steps.

Main conclusion: improvements are split between the Smithers skill and Poolside/agent harness. The "too step-by-step" behavior is partly skill-induced, but several extra steps came from tool/harness failures.

## Run shape

Observed from the ACP trajectory:

- 127 ACP notifications
- 45 tool calls
- 5 tool/tooling failures
- 6 plan updates

The agent completed the task, but had to recover from multiple avoidable failures.

## Key failures

### 1. Selected skill mirror path failed

The prompt instructed the agent to read:

```text
.poolside-studio/active-skills/smithers-workflow-authoring/SKILL.md
```

The read failed with:

```text
Internal error
```

The agent recovered by manually searching and reading:

```text
skills/smithers-workflow-authoring/SKILL.md
```

This points to Poolside skill mirroring or ACP filesystem read behavior.

### 2. Read tool failed on readable absolute paths

The `read` tool failed with `Internal error` on files that shell commands (`cat`, `sed`) could read successfully.

This is likely not a skill issue. It points to the Poolside ACP read adapter or poolside_agent tool implementation.

### 3. Elicitation failed

The agent attempted a `Question` tool call for clarifying model/agent choices. It failed with:

```text
"Method not found": _poolside/elicitation
```

The agent recovered by applying defaults. Either this method should be implemented or the tool should not be exposed/advertised in this harness.

### 4. Write failed because file had not been read first

The first write to `.smithers/workflows/plan-fanout.tsx` failed with:

```text
file ... has not been read yet. Read it first before writing to it
```

The agent recovered by reading the scaffolded file and retrying.

This is a harness safety rule. The skill can mention it, but the implementation lives in poolside_agent/harness.

### 5. Skill recommended `bunx smthrs`

The skill instructed the agent to use `bunx smthrs` for Smithers commands. During graph verification, this caused a duplicate React / invalid hook call issue.

The agent discovered the fix: use the locally installed CLI instead:

```bash
./node_modules/.bin/smithers
```

This is the clearest skill bug.

## Recommended skill improvements

Target file:

```text
skills/smithers-workflow-authoring/SKILL.md
```

### 1. Prefer local Smithers CLI over `bunx`

Replace direct `bunx smthrs ...` examples with a local-first pattern:

```bash
if [ -x ./node_modules/.bin/smithers ]; then
  SMITHERS=./node_modules/.bin/smithers
else
  SMITHERS="bunx smthrs"
fi
```

Then use:

```bash
$SMITHERS workflow list --format json
$SMITHERS workflow path <workflow-id> --format json
$SMITHERS graph .smithers/workflows/<workflow-id>.tsx \
  --input '{"prompt":"Smoke test workflow"}' \
  --format json
```

Reason: `bunx` can materialize a separate dependency tree and cause duplicate React issues.

### 2. Do not use `{}` as mandatory graph input

The run showed `USER REQUEST: undefined` with:

```bash
--input '{}'
```

Use a minimal realistic input instead:

```bash
--input '{"prompt":"Build a markdown-to-csv CLI"}'
```

### 3. Add explicit batching guidance

The agent performed many small independent inspection calls. Add guidance like:

> Batch independent read-only inspection in one shell command before doing multiple separate tool calls. Resolve project layout, package.json, Smithers binary, `.smithers/` dirs, workflow files, and relevant docs in one pass when safe.

Example:

```bash
pwd
printf '\n--- package ---\n'
cat package.json 2>/dev/null | head -80
printf '\n--- smithers binary ---\n'
ls node_modules/.bin/smithers 2>/dev/null || true
printf '\n--- smithers dirs ---\n'
find .smithers -maxdepth 3 -type f 2>/dev/null | sort | head -80
```

### 4. Soften "confirm before mutating"

The skill currently encourages a confirm-before-mutation loop. That pushed the agent toward elicitation even though the user request was concrete enough.

Recommended replacement:

> Draft a concise spec. If the request is high confidence and only minor defaults are needed, proceed with explicit defaults and document them. Ask only when blocked or when a choice materially changes runtime behavior.

### 5. Include a known-good workflow template in the skill

The agent spent many calls rediscovering Smithers APIs and example patterns:

- `createSmithers`
- `Workflow`, `Task`, `Sequence`, `Parallel`
- `PiAgent`, `ClaudeCodeAgent`, `CodexAgent`, `GeminiAgent`

Include a short canonical template in the skill so future runs need less source spelunking.

## Recommended Poolside / harness improvements

Relevant files to inspect first:

```text
/Users/ben/code/poolside/poolside-studio/src/lib/skills/skill-core.ts
/Users/ben/code/poolside/poolside-studio/src/lib/skills/skill-mirror.ts
```

### 1. Fix or harden active skill mirroring

If Poolside tells the agent to read:

```text
.poolside-studio/active-skills/<skill>/SKILL.md
```

that path must exist and be readable before sending the prompt.

If mirroring can fail, the generated prompt should include a fallback:

```text
If this path is missing, look for skills/<skill-name>/SKILL.md or .poolside/skills/<skill-name>/SKILL.md.
```

### 2. Fix read tool `Internal error`

The `read` tool failed on files that shell commands could read. Investigate the ACP filesystem/read adapter or poolside_agent read tool implementation.

### 3. Do not advertise elicitation unless available

The `Question` tool should not be exposed if `_poolside/elicitation` is not implemented. Either implement the method or remove/disable the tool for this harness.

### 4. Improve write-after-read ergonomics

The write guard is reasonable, but after `workflow create` scaffolded a file, requiring a separate read caused another avoidable micro-step.

Possible improvements:

- Mark scaffolded/generated files as write-eligible.
- Improve the error message to suggest reading and retrying.
- Expose a separate safe `overwrite_file` tool for generated files.

## Why the run felt too step-by-step

Attribution:

- Skill-caused: yes, partly. The skill has a checklist-heavy authoring loop: spec, confirm, scaffold, author, verify, repair, trace, handoff.
- Agent/model-caused: likely. The agent preferred serial tool calls and narration.
- Harness-caused: yes. Tool failures forced fallback calls: missing skill mirror, read internal errors, elicitation unavailable, and write guard retry.

## Priority order

1. Update the Smithers skill to use local-first Smithers CLI and realistic graph input.
2. Add batching guidance and a known-good workflow template to the skill.
3. Fix Poolside skill mirroring or add fallback instructions to generated skill context.
4. Investigate ACP read tool `Internal error` failures.
5. Disable or implement elicitation.
6. Improve write-after-read ergonomics for scaffolded files.