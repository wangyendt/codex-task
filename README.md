# CodexErrand

> Give another AI agent a focused errand—and get back text, images, or finished work. Powered by your existing Codex setup.

[中文文档](./README.zh-CN.md) · [PRD](./docs/PRD.md) · [Companion skill](./skills/codexerrand/SKILL.md)

CodexErrand turns Codex into a small, composable worker for other agents. It ships one CLI, one TypeScript API, and one installable skill for three jobs:

- focused text-to-text tasks;
- text-to-image and image-to-image generation;
- bounded workspace tasks through the official Codex SDK.

No daemon. No hosted service. No extra API key. Results are stable JSON that another agent can consume.

> [!IMPORTANT]
> CodexErrand is an independent, unofficial open-source project. It is not affiliated with, endorsed by, or sponsored by OpenAI. Codex and OpenAI are trademarks of OpenAI.

## Quick start

Requirements: Node.js 20+ and an existing Codex login (`codex login`).

```bash
npm install -g codexerrand
codexerrand doctor
```

Delegate a text result:

```bash
codexerrand text "Turn these notes into a crisp release announcement" \
  --backend direct
```

Generate an image that will not be removed by temporary-file cleanup:

```bash
codexerrand image "A precise exploded-view diagram of a compact robot joint" \
  --backend direct \
  --size 1536x1024 \
  --quality high \
  --output ./artifacts
```

Edit an image:

```bash
codexerrand image "Keep the object; replace the background with a clean workshop" \
  --backend direct \
  --image ./reference.png \
  --output ./artifacts
```

Delegate repository work:

```bash
codexerrand task "Implement the requested feature and run focused tests" \
  --backend sdk \
  --cwd /absolute/path/to/repo
```

Every command writes a machine-readable result:

```json
{
  "status": "completed",
  "taskId": "e6fe7ed7-72de-4b27-8b6e-08152192d6cb",
  "backend": "direct",
  "text": "...",
  "effectiveModel": "gpt-5.6-sol",
  "reasoningEffort": "medium",
  "artifacts": []
}
```

## Pick the backend

CodexErrand never guesses. Direct is the CLI default, but workspace tasks require an explicit SDK backend.

| Capability | `direct` | `sdk` |
| --- | --- | --- |
| Focused text result | Yes | Yes |
| Text-to-image / image-to-image | Yes, native result extraction | Yes, via the installed `$imagegen` skill |
| Shell and file edits | No | Yes |
| Project rules and local tools | No | Yes |
| Local Codex skills | No | Normal Codex discovery |
| Transport | Unofficial ChatGPT Codex Responses | Official `@openai/codex-sdk` |
| Stability | Experimental | Supported SDK surface |

Direct reuses `$CODEX_HOME/auth.json`, Codex installation metadata, TLS impersonation, and the private ChatGPT Codex Responses endpoint. Inputs are still sent to ChatGPT. The interface may change without notice.

The SDK backend defaults to:

```text
sandbox: danger-full-access
approval: never
network: true
```

That combination is intentionally powerful: it can read and write outside the workspace, execute commands, and use the network without asking for approval. Only delegate trusted prompts and repositories.

## Agent follow-ups

SDK tasks are single-turn first. If the worker needs clarification, the result is not an error:

```json
{
  "status": "needs_input",
  "taskId": "...",
  "threadId": "...",
  "questions": ["Should the API preserve the legacy response shape?"],
  "artifacts": []
}
```

Ask the user, then resume the same Codex thread:

```bash
printf '%s' "Yes, preserve it." | codexerrand resume <task-id>
```

Pass `--no-followup` to require reasonable assumptions and a completed/failed result in one caller turn. It does not guarantee the model succeeds.

## Use from another agent

This repository ships `skills/codexerrand/SKILL.md`. It teaches a calling agent when to choose text, image, task, or resume. It is a companion skill, not a skill injected into the Codex worker.

Install it with [skillmanager](https://github.com/wangyendt/skillmanager):

```bash
npm install -g @wang121ye/skillmanager
skillmanager install https://github.com/wangyendt/codexerrand --global
```

Or locate the copy included in the npm package:

```bash
codexerrand skill path
```

The repository also includes `.codex-plugin/plugin.json` for plugin-compatible distribution.

## TypeScript API

```ts
import { generateImage, generateText, runTask } from "codexerrand";

const copy = await generateText({
  prompt: "Write a launch headline and three supporting bullets.",
  backend: "direct",
});

const image = await generateImage({
  prompt: "A restrained isometric illustration of agent-to-agent delegation.",
  backend: "direct",
  output: "./artifacts",
  quality: "high",
});

const work = await runTask({
  prompt: "Add the feature and run focused tests.",
  backend: "sdk",
  workingDirectory: "/absolute/path/to/repo",
});
```

For progress events:

```ts
import { streamTaskEvents } from "codexerrand";

for await (const event of streamTaskEvents({
  kind: "text",
  options: { prompt: "Summarize this decision", backend: "direct" },
})) {
  console.log(event);
}
```

The event stream reports item and task progress; it is not guaranteed token streaming.

## Image controls

```text
references   0–5 local PNG/JPEG/WebP/GIF files
size         auto or WIDTHxHEIGHT; longest edge ≤ 3840
quality      auto | low | medium | high
background   auto | opaque | transparent
count        1–10
concurrency  1–3, default 1
```

Each reference may be at most 20 MiB, with a 50 MiB combined limit. Existing outputs are rejected unless `--overwrite` is supplied. Completed images are atomically saved immediately, so a later batch failure does not discard earlier artifacts.

## Inputs and output

Long prompts can come from a file or stdin:

```bash
codexerrand text --prompt-file task.md --backend direct
printf '%s' "$PROMPT" | codexerrand task --backend sdk --cwd .
```

The positional prompt, `--prompt-file`, and stdin are mutually exclusive.

Default stdout is one JSON result. `--stream` switches stdout to JSONL events. Diagnostics go to stderr. Exit codes are:

| Code | Meaning |
| --- | --- |
| `0` | `completed` or `needs_input` |
| `1` | execution failure |
| `2` | invalid arguments or configuration |
| `130` | cancellation or timeout |

## Models and configuration

The SDK backend leaves model and reasoning unset unless you override them, allowing normal Codex configuration discovery.

Direct resolves its model in this order:

1. `--model` / API option;
2. Codex `config.toml`;
3. the preferred visible model in `models_cache.json`;
4. compatibility fallback.

It supports classic Responses and Responses Lite encoders. With a current Codex model catalog, text defaults to `gpt-5.6-sol` with `medium` reasoning. The private Responses Lite route rejects hosted `image_generation`, so Direct image requests are preflighted to the compatible classic `gpt-5.5` model before any request is sent. The final JSON always reports `effectiveModel` and `reasoningEffort`.

Configuration precedence is API/CLI → `CODEXERRAND_*` environment variables → user config → Codex config → fallback. The user config is `config.json` under the standard platform config directory; run `codexerrand doctor` to see the exact path.

Useful variables include:

```text
CODEXERRAND_MODEL
CODEXERRAND_REASONING
CODEXERRAND_PROXY
CODEXERRAND_CODEX_HOME
CODEXERRAND_TEXT_TIMEOUT_MS
CODEXERRAND_IMAGE_TIMEOUT_MS
CODEXERRAND_SDK_TIMEOUT_MS
CODEXERRAND_RETRIES
```

## Temporary data

- Images without `--output` live under the platform temporary directory and expire after 24 hours.
- Pending `needs_input` metadata lives under the platform state directory and expires after 7 days.
- Managed temporary artifacts are capped at 1 GiB.
- Explicit output paths are user data and are never removed by `codexerrand gc`.
- Official SDK sessions remain managed by Codex under `$CODEX_HOME`; CodexErrand does not delete them.

## Development and releases

```bash
npm install
npm run verify
```

`npm run verify` runs lint, type checking, unit tests, build, package inspection, and a clean install/import smoke test. Live Direct endpoint tests are opt-in and never run in CI:

```bash
RUN_DIRECT_E2E=1 npm run test:e2e
```

Every push to `main` triggers an automatic patch bump. A second workflow verifies the package, publishes through npm Trusted Publishing, and creates a `vX.Y.Z` tag. Repository setup is documented in [Release setup](./docs/RELEASING.md).

## Acknowledgements

The Direct backend is derived in part from the MIT-licensed [`lawrencewzen/imgen`](https://github.com/lawrencewzen/imgen). See [third-party notices](./THIRD_PARTY_NOTICES.md).

## License

MIT © 2026 ye.wang
