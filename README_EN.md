# CodexTask

> Delegate text, images, and project work to another Codex worker; get back structured text, generated images, or completed workspace changes.

[中文](./README.md) · [Product requirements](./docs/PRD.md) · [Common commands](./docs/常用命令.txt) · [Companion skill](./skills/codex-task/SKILL.md)

CodexTask is a lightweight, composable multimodal task runner for agent-to-agent delegation. It ships one CLI, one TypeScript API, and one installable companion skill—without a daemon, hosted service, or extra API key.

Choose a command by the result you want:

| Result | Command | Composable inputs |
| --- | --- | --- |
| Text | `codex-task text` | inline text, prompt files, images, stdin |
| Images | `codex-task image` | inline text, prompt files, reference images, stdin |
| Workspace changes | `codex-task task` | text, prompt files, images, a current project |
| Continued work | `codex-task resume` | task ID plus text, files, and images |

> [!IMPORTANT]
> CodexTask is an independent, unofficial open-source project. It is not affiliated with, endorsed by, or sponsored by OpenAI. Codex and OpenAI are trademarks of OpenAI.

## Quick start: one fitness-meal workflow

Requirements: Node.js 20+ and an existing Codex login (`codex login`).

```bash
npm install -g codex-task
codex-task doctor
```

Generate a fitness meal image. With no `--output`, the durable final image is written to the current directory:

```bash
codex-task image "A clean top-down fitness meal with grilled chicken, brown rice, broccoli, and avocado"
```

```json
{
  "status": "completed",
  "taskId": "a1b2c3d4-...",
  "backend": "direct",
  "effectiveModel": "gpt-5.5",
  "artifacts": [{ "path": "/your/project/image-a1b2c3d4.png", "kind": "image" }]
}
```

Turn that image plus a prompt into nutrition JSON:

```bash
codex-task text "Identify the foods, estimate each item's calories and the total, and return JSON only" -i ./image-a1b2c3d4.png
```

```json
{
  "status": "completed",
  "taskId": "b2c3d4e5-...",
  "backend": "direct",
  "text": "{\"foods\":[{\"name\":\"chicken breast\",\"calories\":248}],\"totalCalories\":679}",
  "artifacts": []
}
```

Delegate project work with multiple specifications and the generated image:

```bash
codex-task task "Build the fitness-meal detail page and run focused tests" -f ./requirements.md -f ./api-contract.md -i ./image-a1b2c3d4.png --cwd ./meal-app
```

`task` always uses the official Codex SDK; `--backend sdk` is unnecessary. `--cwd` is the worker's current project—the directory whose code, project instructions, and skills Codex reads and where it runs commands.

If the result is `needs_input`, answer and resume the same Codex task:

```bash
codex-task resume 7dd7a7d7-... "Use a single serving" -f ./copy-guidelines.md -i ./expected-layout.png
```

## Composable multimodal input

The positional prompt, repeated `-f/--prompt-file`, non-empty stdin, and repeated `-i/--image` may be combined:

```bash
printf '%s' "Keep the meal under 700 kcal" | codex-task text "Recommend adjustments" -f ./training-goal.md -f ./allergies.md -i ./meal-front.png -i ./meal-side.png
```

Text is composed in a stable order: positional prompt, prompt files in command-line order, then stdin. Prompt files are wrapped with absolute-path boundaries. Images preserve `-i` order. Up to five PNG/JPEG/WebP/GIF images are accepted; each may be 20 MiB and the combined limit is 50 MiB.

## Direct and SDK backends

`text` and `image` default to Direct and may explicitly select `--backend sdk`. `task` and `resume` are SDK-only. CodexTask never guesses the backend.

| Capability | `direct` | `sdk` |
| --- | --- | --- |
| Text from text/images | Yes | Yes |
| Images from text/images | Native result extraction | Through the installed `$imagegen` skill |
| Shell, file changes, project rules | No | Yes |
| Local Codex skills | No | Normal Codex discovery |
| Transport | Unofficial ChatGPT Codex Responses | Official `@openai/codex-sdk` |

Direct reuses `$CODEX_HOME/auth.json`, Codex installation metadata, TLS impersonation, and the private ChatGPT Codex Responses endpoint. Inputs are still sent to ChatGPT, and the interface may change without notice. Direct cannot read a repository, run local tools, call local MCP, or use worker skills.

SDK tasks default to `sandbox=danger-full-access`, `approval=never`, and `network=true`. This is intentionally powerful. Delegate only trusted prompts and projects; use `--sandbox workspace-write` or `--no-network` when needed.

## Image output

- Default: a unique durable file in the current directory, such as `./image-a1b2c3d4.png`.
- Explicit destination: `-o ./artifacts` or `-o ./meal.png`.
- Managed temporary output: `--temp`, under `os.tmpdir()/codex-task/<task-id>`, eligible for cleanup after 24 hours.
- `--temp` and `--output` are mutually exclusive. Existing files are protected unless `--overwrite` is present.

Image controls: `size=auto|WIDTHxHEIGHT` (longest edge ≤ 3840), `quality=auto|low|medium|high`, `background=auto|opaque|transparent`, `count=1–10`, and `concurrency=1–3`.

## Companion skill

[`skills/codex-task/SKILL.md`](./skills/codex-task/SKILL.md) teaches a calling agent how to use CodexTask. It is not injected into the underlying Codex worker. The skill and executable are separate: SkillTruck installs the skill; npm installs the CLI.

```bash
npm install -g skilltruck codex-task
skilltruck install https://github.com/wangyendt/codex-task --global
```

Agents may fall back to `npx --yes codex-task@latest`. `codex-task skill path` prints the packaged skill location.

## TypeScript API

```ts
import { generateImage, generateText, runTask } from "codex-task";

const meal = await generateImage({ prompt: "Generate a high-protein fitness meal", output: "." });
const analysis = await generateText({
  prompt: "Identify foods and return calorie estimates as JSON",
  promptFiles: ["./nutrition-rules.md", "./allergies.md"],
  imagePaths: [meal.artifacts[0]!.path],
});
const work = await runTask({
  prompt: "Build and test the meal detail page",
  promptFiles: ["./requirements.md", "./api-contract.md"],
  imagePaths: [meal.artifacts[0]!.path],
  workingDirectory: "./meal-app",
});
```

Default stdout is one JSON result; `--stream` produces JSONL item/task progress. Exit codes are 0 for `completed`/`needs_input`, 1 for execution failure, 2 for invalid input, and 130 for cancellation/timeout.

## Models

SDK mode inherits normal Codex model and reasoning configuration unless overridden. Direct resolves explicit options, Codex config, the model cache, then a compatibility fallback. Current Direct text can use `gpt-5.6-sol` with medium or high reasoning. The private Responses Lite route does not expose hosted `image_generation`, so Direct image requests preflight to the compatible classic `gpt-5.5`. This is a limitation of the unofficial Direct image protocol, not a claim that `gpt-5.6-sol` lacks vision capability.

## Development and releases

```bash
npm install
npm run verify
```

`verify` runs lint, workflow checks, type checking, tests, build, package inspection, and a clean install/import smoke test. Live Direct endpoint tests are manual-only: `RUN_DIRECT_E2E=1 npm run test:e2e`.

Every push to `main` publishes a patch release. See [release setup](./docs/RELEASING.md).

The Direct backend derives in part from MIT-licensed [`lawrencewzen/imgen`](https://github.com/lawrencewzen/imgen); see [third-party notices](./THIRD_PARTY_NOTICES.md).

MIT © 2026 ye.wang
