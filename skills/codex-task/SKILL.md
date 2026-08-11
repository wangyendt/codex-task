---
name: codex-task
description: Delegate a focused task to CodexTask and return structured text, generated or edited images, or completed workspace changes. Use when another Agent should call the codex-task CLI for text-to-text, image-to-text, text-to-image, image-to-image, multimodal workspace work, or resuming a task that needs user input.
---

# CodexTask

Use the installed `codex-task` CLI as a companion tool. This skill teaches the calling Agent how to invoke CodexTask; it is not a skill injected into the underlying Codex worker.

## Resolve the CLI

The skill and executable are separate. Installing this skill does not install the npm package.

1. Prefer `codex-task` when `command -v codex-task` succeeds.
2. Otherwise, when npm and network access are available, replace it with `npx --yes codex-task@latest`.
3. If neither works, tell the user to install the unscoped package with `npm install -g codex-task`.

Do not silently perform a global npm installation. The package is `codex-task`, not `@wang121ye/codex-task`.

For a persistent self-hosted service, use the repository's platform installer and a global package. Do not use `npx` in an auto-start configuration: it can require registry access during boot and can change the version unexpectedly.

## Choose by the desired result

- Need text: use `codex-task text`. This covers text-to-text, image-to-text, and text-plus-image-to-text.
- Need images: use `codex-task image`. This covers text-to-image, image-to-image, and text-plus-image-to-image.
- Need shell commands, file changes, repository context, project rules, or local tools: use `codex-task task`.
- Have a prior `needs_input`: relay its questions, preserve `taskId`, then use `codex-task resume`.

`text` and `image` default to Direct. Pass `--backend sdk` only when the result needs normal Codex project context or skills. `task` and `resume` are SDK-only; do not add `--backend sdk` to their normal invocation.

Direct cannot inspect a repository, execute commands, call local MCP, modify files, or use local Codex skills.

## Compose the input

All result commands accept these together:

- positional text;
- repeatable `-f/--prompt-file` for long prompt files;
- non-empty stdin;
- repeatable `-i/--image`, up to five local images.

Use prompt files instead of shell substitution for long content. Preserve file and image order when order affects meaning.

```bash
printf '%s' "$EXTRA_REQUIREMENT" | codex-task text "Analyze the meal" -f ./nutrition-rules.md -f ./allergies.md -i ./meal-front.png -i ./meal-side.png
```

## Invoke each result

Generate a durable image in the current directory:

```bash
codex-task image "A clean high-protein fitness meal, top-down view"
```

Analyze that image as JSON text:

```bash
codex-task text "Identify foods and estimate calories; return JSON only" -i ./image-a1b2c3d4.png
```

Delegate project work with all relevant context:

```bash
codex-task task "Build the meal detail page and run focused tests" -f ./requirements.md -f ./api-contract.md -i ./meal.png --cwd /absolute/path/to/repo
```

`--cwd` is the Codex worker's current project. It determines which code, project instructions, and repo-scoped skills the worker sees, where relative paths resolve, and where commands run.

If the task asks a question, resume it:

```bash
codex-task resume "$TASK_ID" "Use one serving" -f ./copy-guidelines.md -i ./expected-layout.png
```

The SDK task default is `danger-full-access`, network enabled, and approval `never`. Invoke it only when the user's request authorizes that access. Use `--sandbox workspace-write` or `--no-network` when the intended scope is narrower. Use `--no-followup` only when the caller accepts reasonable assumptions and requires completion or failure in one caller turn.

## Manage image output

Without `--output`, `image` writes a unique durable PNG to the current directory. Do not add `--output .` unless explicitness helps readability.

- Use `-o ./artifacts` or `-o ./meal.png` for an explicit durable destination.
- Use `--temp` only when the artifact is disposable after the current workflow. It writes under the managed OS temporary directory and can be removed by `codex-task gc`.
- Never combine `--temp` and `--output`.
- Add `--overwrite` only when replacing existing user data is authorized.

## Handle the result

Parse stdout as JSON:

- `completed`: return `text`, surface `artifacts`, and summarize `changes`/`commands` when present.
- `needs_input`: ask every returned question, preserve `taskId`, then resume after receiving the answer.
- `failed`: report `error.code` and `error.message`; retry only when `error.retryable` is true.
- `cancelled`: report cancellation or timeout and do not claim completion.

Use `--stream` only when JSONL progress events are useful. It is an item/task event stream, not guaranteed token streaming.

## Diagnose and clean

Run `codex-task doctor` when Direct authentication, native transport, model resolution, or SDK availability is uncertain. It is read-only and sends no model request.

Run `codex-task gc` only for CodexTask-managed temporary artifacts and expired pending-task metadata. It never deletes default current-directory images or files under an explicit output path.

## Use a remote service only when configured

Prefer the local CLI. Use the HTTP service only when the user or environment explicitly supplies both a trusted service URL and Service Token. Never discover arbitrary LAN services, print the token, place it in a prompt, or send it to any host other than the configured service.

A Service Token may be scoped to `text`, `image`, or both. Scoped Tokens are Direct-only. Use only an endpoint allowed by the supplied Token. A `403 FORBIDDEN` response means the Token is valid but lacks that task or backend permission; do not retry it or fall back to another endpoint. Only a full-access master Token may use SDK or call remote `task` or `resume`.

Remote submission is asynchronous:

1. POST JSON to `/v1/text`, `/v1/image`, `/v1/task`, or `/v1/tasks/:taskId/resume` with `Authorization: Bearer <token>`.
2. Poll the returned `statusUrl` until `completed`, `needs_input`, `failed`, or `cancelled`.
3. Download `result.artifacts[].downloadUrl` using the same token.
4. For `needs_input`, relay every question and resume with `result.taskId`.

The service does not provide TLS. Treat remote `task` as equivalent to local SDK execution with the requested sandbox and network permissions; the default remains `danger-full-access`, network enabled, and approval `never`. Do not expose the service directly to the public internet.
