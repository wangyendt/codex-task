# CodexTask

> 把文本、图片和项目任务交给另一个 Codex worker，拿回结构化文本、生成图片或已经完成的工作区变更。

[English](./README_EN.md) · [产品需求文档](./docs/PRD.md) · [常用命令](./docs/常用命令.txt) · [Companion Skill](./skills/codex-task/SKILL.md)

CodexTask 是一个轻量、可组合的跨 Agent 多模态任务运行器。它提供一个 CLI、一个 TypeScript API 和一个可安装给其他 Agent 的 Skill；没有 daemon，没有托管服务，也不需要额外 API key。

你只需要按“想拿回什么”选择命令：

| 期望结果 | 命令 | 可组合输入 | 典型任务 |
| --- | --- | --- | --- |
| 文本 | `codex-task text` | 文本、多个 prompt 文件、最多 5 张图片、stdin | 文生文、图生文、图文生文 |
| 图片 | `codex-task image` | 文本、多个 prompt 文件、最多 5 张参考图、stdin | 文生图、图生图、图文生图 |
| 工作区变更 | `codex-task task` | 文本、多个 prompt 文件、最多 5 张图片、当前项目 | 写代码、改文件、运行命令 |
| 恢复任务 | `codex-task resume` | task ID、补充文本/文件/图片 | 回答追问后继续同一个 Codex task |

> [!IMPORTANT]
> CodexTask 是独立的非官方开源项目，与 OpenAI 不存在隶属、认可或赞助关系。Codex 与 OpenAI 为 OpenAI 的商标。

## 30 秒上手

需要 Node.js 20+，并已执行过 `codex login`。

```bash
npm install -g codex-task
codex-task doctor
```

下面用一次“健身营养餐”任务串起四种输出。

### 1. 生成图片：一份健身营养餐

```bash
codex-task image "生成一份写实、干净的健身营养餐：香煎鸡胸肉、糙米、西兰花、牛油果，俯拍，食材边界清晰"
```

不传 `--output` 时，最终图片默认保存在当前目录，而不是临时目录：

```json
{
  "status": "completed",
  "taskId": "a1b2c3d4-...",
  "backend": "direct",
  "text": "Generated 1 image(s).",
  "effectiveModel": "gpt-5.5",
  "artifacts": [
    { "path": "/your/project/image-a1b2c3d4.png", "kind": "image", "mimeType": "image/png" }
  ]
}
```

### 2. 图片 + prompt → JSON 营养分析

```bash
codex-task text "识别图中的食物，估算每项热量和总热量，只返回 JSON" -i ./image-a1b2c3d4.png
```

`text` 不只是文生文，也支持图生文和图文生文：

```json
{
  "status": "completed",
  "taskId": "b2c3d4e5-...",
  "backend": "direct",
  "text": "{\"foods\":[{\"name\":\"鸡胸肉\",\"calories\":248},{\"name\":\"糙米\",\"calories\":216},{\"name\":\"西兰花\",\"calories\":55},{\"name\":\"牛油果\",\"calories\":160}],\"totalCalories\":679}",
  "artifacts": []
}
```

需要严格 JSON Schema 时可传 `--schema ./nutrition.schema.json`。

### 3. 多份要求 + 参考图 → 完成项目

```bash
codex-task task "实现一个健身营养餐详情页，并运行相关测试" -f ./requirements.md -f ./api-contract.md -i ./image-a1b2c3d4.png --cwd ./meal-app
```

`task` 固定使用官方 Codex SDK，不需要再写 `--backend sdk`。`--cwd ./meal-app` 表示：把该目录作为 worker 的当前项目；Codex 会从这里读取代码、项目规则与 skills，并在授权范围内修改文件、执行命令。

```json
{
  "status": "completed",
  "taskId": "7dd7a7d7-...",
  "backend": "sdk",
  "threadId": "019...",
  "text": "已实现营养餐详情页并通过相关测试。",
  "changes": ["src/pages/MealDetail.tsx", "test/MealDetail.test.tsx"],
  "commands": [{ "command": "npm test -- MealDetail", "exitCode": 0 }],
  "artifacts": []
}
```

### 4. 回答追问并继续

如果任务存在关键歧义，`task` 可能返回：

```json
{
  "status": "needs_input",
  "taskId": "7dd7a7d7-...",
  "questions": ["页面按单人份还是双人份展示热量？"],
  "artifacts": []
}
```

取得答案后，用同一个 task ID 恢复；补充回答也可以同时带多个文件和图片：

```bash
codex-task resume 7dd7a7d7-... "按单人份展示" -f ./copy-guidelines.md -i ./expected-layout.png
```

```json
{
  "status": "completed",
  "taskId": "7dd7a7d7-...",
  "backend": "sdk",
  "text": "已按单人份完成页面和测试。",
  "changes": ["src/pages/MealDetail.tsx"],
  "artifacts": []
}
```

## 组合输入，而不是四选一

位置 prompt、重复的 `-f/--prompt-file`、非空 stdin 和重复的 `-i/--image` 可以同时出现：

```bash
printf '%s' "总热量控制在 700 kcal 内" | codex-task text "制定调整建议" -f ./training-goal.md -f ./allergies.md -i ./meal-front.png -i ./meal-side.png
```

CodexTask 按固定顺序组合输入：位置 prompt → prompt 文件（按命令行顺序）→ stdin；图片保持 `-i` 的顺序。文件内容会带绝对路径边界标记，避免多份长 prompt 混在一起。每张图片不超过 20 MiB，总和不超过 50 MiB。

## 两种后端

`text` 和 `image` 默认使用 Direct，可手动传 `--backend sdk`。`task` 和 `resume` 固定使用 SDK，不做自动猜测。

| 能力 | `direct` | `sdk` |
| --- | --- | --- |
| 文本结果 | 支持文本与图片输入 | 支持文本与图片输入 |
| 图片结果 | 原生提取生成图片 | 让 Codex 调用已安装的 `$imagegen` skill |
| shell、文件修改、项目规则 | 不支持 | 支持 |
| 本地 Codex skills | 不支持 | 按 Codex 正常发现 |
| 底层 | 非官方 ChatGPT Codex Responses | 官方 `@openai/codex-sdk` |

Direct 复用 `$CODEX_HOME/auth.json`、Codex installation metadata、TLS impersonation 和 ChatGPT 私有 Codex Responses 接口。输入仍会发往 ChatGPT，接口可能随时变化。Direct 只返回生成结果，不能读项目、运行 shell、调用本地 MCP 或使用 worker skills。

SDK task 默认权限为：

```text
sandbox: danger-full-access
approval: never
network: true
```

这意味着 worker 可以访问工作区外路径、执行命令并联网，而且不会等待权限确认。只委派可信 prompt 和可信项目；需要收窄时显式传 `--sandbox workspace-write` 或 `--no-network`。

## 图片输出与临时文件

- 默认：在当前目录生成唯一文件名，例如 `./image-a1b2c3d4.png`；这是持久用户文件，`gc` 不会删除。
- 指定位置：传 `-o ./artifacts` 或 `-o ./meal.png`。
- 临时产物：显式传 `--temp`，写入 `os.tmpdir()/codex-task/<task-id>`，24 小时后可被清理。
- `--temp` 与 `--output` 互斥；已有目标默认拒绝覆盖，只有 `--overwrite` 才允许替换。

```bash
codex-task image "生成三个便当配色方案" -n 3 -o ./artifacts
codex-task image "仅供本轮分析的草图" --temp
codex-task gc
```

图片参数：`size=auto|WIDTHxHEIGHT`（最长边 ≤ 3840）、`quality=auto|low|medium|high`、`background=auto|opaque|transparent`、`count=1–10`、`concurrency=1–3`。

## 安装给其他 Agent

仓库内置 [`skills/codex-task/SKILL.md`](./skills/codex-task/SKILL.md)。它教调用方 Agent 何时运行 `text`、`image`、`task` 或 `resume`；它不是注入底层 Codex worker 的 skill。

Skill 和 CLI 是两件事：SkillTruck 负责安装 Skill，npm 负责安装可执行命令。安装 Skill 不会自动全局安装 npm 包。

```bash
npm install -g skilltruck codex-task
skilltruck install https://github.com/wangyendt/codex-task --global
```

如果不想全局安装 CLI，Agent 可回退到 `npx --yes codex-task@latest`。也可以运行 `codex-task skill path` 查看 npm 包内 Skill 的位置。

## TypeScript API

```ts
import { generateImage, generateText, runTask } from "codex-task";

const meal = await generateImage({
  prompt: "生成一份高蛋白健身营养餐",
  output: ".",
});

const analysis = await generateText({
  prompt: "识别食物并估算热量，只返回 JSON",
  promptFiles: ["./nutrition-rules.md", "./allergies.md"],
  imagePaths: [meal.artifacts[0]!.path],
});

const work = await runTask({
  prompt: "根据要求实现营养餐详情页并测试",
  promptFiles: ["./requirements.md", "./api-contract.md"],
  imagePaths: [meal.artifacts[0]!.path],
  workingDirectory: "./meal-app",
});
```

`streamTaskEvents()` 可输出 JSONL 级别的 item/task 进度，但不保证逐 token 流式输出。

## 输出、状态与退出码

stdout 默认只有一个 JSON 结果；`--stream` 时为 JSONL。诊断写 stderr。

| 状态/退出码 | 含义 |
| --- | --- |
| `completed` / `0` | 完成 |
| `needs_input` / `0` | 等待调用方补充输入，可 `resume` |
| `failed` / `1` | 执行失败 |
| 参数错误 / `2` | 输入或配置无效 |
| `cancelled` / `130` | 取消或超时 |

`--no-followup` 会要求 SDK worker 采用合理假设并在当前 caller turn 内完成或失败，但不能保证模型一定成功。

## 模型与配置

SDK 默认不覆写 model/reasoning，继续读取正常的 Codex 用户与项目配置。

Direct 按显式参数 → Codex `config.toml` → `models_cache.json` 首选模型 → 兼容 fallback 的顺序选择模型。当前文本可使用 `gpt-5.6-sol + medium/high`；私有 Responses Lite 路由不暴露托管 `image_generation`，所以 Direct 图片会在请求前选择兼容的 classic `gpt-5.5`。这不代表 `gpt-5.6-sol` 没有视觉能力，只是这条非官方 Direct 生图协议不兼容。最终 JSON 始终返回真实的 `effectiveModel` 和 `reasoningEffort`。

运行 `codex-task doctor` 可查看本机 Direct transport、OAuth、模型解析、Codex CLI/SDK 与真实数据路径，不会发送模型请求。

## 开发与发布

```bash
npm install
npm run verify
```

`verify` 会执行 lint、workflow 检查、类型检查、单元测试、构建、npm 包内容检查和干净安装/import smoke test。真实 Direct endpoint 测试只允许手动执行：

```bash
RUN_DIRECT_E2E=1 npm run test:e2e
```

每次 push 到 `main` 都会自动发布 patch 版本，详见[发布配置](./docs/RELEASING.md)。

## 致谢与许可

Direct 后端部分技术与 MIT 代码源自 [`lawrencewzen/imgen`](https://github.com/lawrencewzen/imgen)，详见[第三方声明](./THIRD_PARTY_NOTICES.md)。

MIT © 2026 ye.wang
