---
name: codexrun
description: Delegate a focused task to CodexRun and return structured text, generated or edited images, or completed workspace changes. Use when another Agent should call the codexrun CLI for text-to-text, text-to-image, image-to-image, or a bounded Codex workspace task, including resuming a task that needs user input.
---

# CodexRun

Use the installed `codexrun` CLI as a companion tool. This skill teaches the calling Agent how to invoke the CLI; it is not injected into the Codex worker.

## Resolve the CLI

The skill and the executable are separate. Installing this skill does not install the npm package.

1. Prefer `codexrun` when `command -v codexrun` succeeds.
2. Otherwise, when npm and network access are available, use `npx --yes codexrun@latest` in place of `codexrun` in every command below.
3. If neither is available, tell the user to install the unscoped package with `npm install -g codexrun`.

Do not silently perform a global npm installation. The package name is `codexrun`, not `@wang121ye/codexrun`.

## Choose the command

- Need only a text result: run `codexrun text --backend direct`.
- Need a new or edited image: run `codexrun image --backend direct`.
- Need shell commands, file edits, repository work, project rules, or local tools: run `codexrun task --backend sdk`.
- Have a prior `needs_input` result: ask the user the returned questions, then run `codexrun resume`.

Never send workspace work to Direct. Direct cannot run local tools, read a repository, use local MCP, or modify files.

## Invoke safely

Prefer stdin for long or quote-heavy prompts:

```bash
printf '%s' "$PROMPT" | codexrun text --backend direct
```

For an image that must survive temporary cleanup, always pass an explicit output directory:

```bash
codexrun image "A clean technical diagram" \
  --backend direct \
  --output ./artifacts
```

For image-to-image, repeat `--image` up to five times:

```bash
codexrun image "Keep the subject, change the lighting" \
  --backend direct \
  --image ./reference.png \
  --output ./artifacts
```

For repository work, pass the intended directory explicitly:

```bash
codexrun task "Implement the requested change and run focused tests" \
  --backend sdk \
  --cwd /absolute/path/to/repo
```

The SDK task default is `danger-full-access`, network enabled, and approval `never`. Invoke it only when the user's request authorizes the workspace task. Use `--no-followup` when the caller explicitly requires a single caller turn and accepts reasonable assumptions.

## Handle the result

Parse stdout as JSON. Treat these statuses as follows:

- `completed`: return `text`, show or link `artifacts`, and summarize `changes` and `commands` when present.
- `needs_input`: relay every question to the user. Preserve `taskId`; after the user answers, run `codexrun resume <taskId>` with the answer through stdin or as the argument.
- `failed`: report `error.code` and `error.message`. Retry only when `error.retryable` is true.
- `cancelled`: report cancellation or timeout; do not claim the task completed.

Use `--stream` only when progress events are useful. It changes stdout from one JSON object to JSONL events; it is an item/progress stream, not guaranteed token streaming.

## Diagnose

Run `codexrun doctor` when Direct authentication, native transport, model resolution, or SDK availability is uncertain. The command is read-only and does not send a model request.

Run `codexrun gc` only to clean CodexRun-managed temporary artifacts and expired pending-task metadata. Files created under an explicit `--output` path are never managed by this cleanup.
