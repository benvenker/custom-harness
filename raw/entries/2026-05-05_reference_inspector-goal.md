---
id: "reference_inspector-goal"
date: "2026-05-05"
time: "12:00:00"
source_type: "markdown"
filepath: "runs/reference/inspector-goal.txt"
title: "Inspector Goal"
category: "reference"
---
### Result
"GOAL · ROOT\nDONE\nUser goal\nid goal · agent user\nAGENT PROMPT\nAdd a --version flag to the CLI.\nACTIVITY TIMELINE\n1 events\n01\n14:31:08\nsubmitted"
### Ran Playwright code
```js
await page.evaluate('() => document.querySelector("#inspector").innerText');
```