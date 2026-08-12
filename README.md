# CodexTask

> 给 Agent 和自动化脚本用的 Codex 任务运行器：输入文本、图片或项目目录，拿回文本、生成图片或工作区改动。

[English](./README_EN.md) · [产品需求文档](./docs/PRD.md) · [远程部署与手机调用](./docs/knowhow/20260811_远程服务部署与移动端调用.md) · [常用命令](./docs/常用命令.txt) · [Companion Skill](./skills/codex-task/SKILL.md)

CodexTask 让 Codex、Claude Code、Gemini CLI 或你自己的程序把任务交给独立的 Codex worker。它提供 CLI、TypeScript API、Companion Skill 和可选的自托管 HTTP 服务，复用现有 Codex 登录，不需要另配 API key。

先按期望结果选命令：

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

下面用一份“健身营养餐”演示文生图、图生文、图生图、工作区任务和恢复。图片与 JSON 都来自真实模型请求；生成模型有随机性，重新执行会得到同类但不同的结果。

### 1. 生成图片：一份健身营养餐

```bash
codex-task image "生成一份写实、干净的健身营养餐：香煎鸡胸肉、糙米、西兰花、牛油果；四种食物分区摆放，俯拍，完整餐盘，食材边界清晰；浅灰桌面，柔和自然光；不要文字、水印、餐具和其他食物。" -o ./docs/assets/fitness-meal.png --size 1024x1024 --quality high
```

这里用 `--output` 把图片保存到 README 资产目录。省略该参数时，图片默认保存在当前目录：

```json
{
  "status": "completed",
  "taskId": "78cda394-e16f-4cac-9d0f-9b8a010e3879",
  "backend": "direct",
  "text": "Generated 1 image(s).",
  "effectiveModel": "gpt-5.5",
  "artifacts": [
    { "path": "/your/project/docs/assets/fitness-meal.png", "kind": "image", "mimeType": "image/png" }
  ]
}
```

真实生成结果：

![CodexTask 文生图生成的健身营养餐](./docs/assets/fitness-meal.png)

### 2. 图片 + prompt → JSON 营养分析

```bash
codex-task text "识别图片中的全部食物，估算每项可食部分重量和热量。重量和热量必须是数字；热量为基于视觉份量的近似值；note 用中文说明估算存在误差。" -i ./docs/assets/fitness-meal.png --schema ./docs/examples/nutrition.schema.json --model gpt-5.6-sol --reasoning medium
```

图生文输入就是上一步的真实图片：

<img src="./docs/assets/fitness-meal.png" alt="CodexTask 图生文输入图片" width="520">

`text` 支持文生文、图生文和图文生文。下面是该命令返回的结构化内容，原始文件见 [`fitness-meal-analysis.json`](./docs/examples/fitness-meal-analysis.json)：

```json
{
  "foods": [
    { "name": "煎烤鸡胸肉", "estimatedGrams": 220, "calories": 380 },
    { "name": "熟糙米饭", "estimatedGrams": 250, "calories": 280 },
    { "name": "西兰花", "estimatedGrams": 170, "calories": 60 },
    { "name": "牛油果", "estimatedGrams": 100, "calories": 160 }
  ],
  "totalCalories": 880,
  "note": "以上重量和热量根据图片中的视觉份量估算，实际数值会因食材品种、烹饪用油及熟制程度而存在误差。"
}
```

这只是视觉估算，不应替代称重或专业营养建议。

### 3. 图片 + prompt → 高蛋白版本图片

```bash
codex-task image "把这份餐食调整成高蛋白低碳版本：增加约 50% 的鸡胸肉，糙米减少约一半；只改变鸡胸肉和糙米的份量，保持餐盘、俯拍机位、光线、牛油果、西兰花和写实摄影风格不变；不要增加其他食物、文字或水印。" -i ./docs/assets/fitness-meal.png -o ./docs/assets/fitness-meal-high-protein.png --size 1024x1024 --quality high
```

| 图生图输入 | 真实图生图输出 |
| --- | --- |
| <img src="./docs/assets/fitness-meal.png" alt="原始健身营养餐" width="420"> | <img src="./docs/assets/fitness-meal-high-protein.png" alt="高蛋白低碳版本健身营养餐" width="420"> |
| 原始份量 | 增加鸡胸肉、减少糙米 |

### 4. 多份要求 + 参考图 → 完成项目

```bash
codex-task task "实现一个健身营养餐详情页，并运行相关测试" -f ./requirements.md -f ./api-contract.md -i ./docs/assets/fitness-meal.png --cwd ./meal-app
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

### 5. 回答追问并继续

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

## 组合输入

位置 prompt、重复的 `-f/--prompt-file`、非空 stdin 和重复的 `-i/--image` 可以同时出现：

```bash
printf '%s' "总热量控制在 700 kcal 内" | codex-task text "制定调整建议" -f ./training-goal.md -f ./allergies.md -i ./meal-front.png -i ./meal-side.png
```

输入顺序固定为：位置 prompt → prompt 文件（按命令行顺序）→ stdin；图片保持 `-i` 的顺序。每份文件都带绝对路径边界标记，避免多份长 prompt 混在一起。每张图片不超过 20 MiB，总和不超过 50 MiB。

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

默认配置下，worker 可以访问工作区外路径、执行命令并联网，而且不会等待权限确认。只委派可信 prompt 和可信项目；需要限制范围时传 `--sandbox workspace-write` 或 `--no-network`。

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

图片参数：`size=auto|WIDTHxHEIGHT`（宽高为正整数，不设本地上限）、`quality=auto|low|medium|high`、`background=auto|opaque|transparent`、`count=1–10`、`concurrency=1–3`。自定义尺寸会原样交给后端；模型不支持时返回后端错误。

## 安装给其他 Agent

仓库内置 [`skills/codex-task/SKILL.md`](./skills/codex-task/SKILL.md)。这个 Skill 供调用方 Agent 使用，教它何时运行 `text`、`image`、`task` 或 `resume`。底层 Codex worker 不会加载它。

SkillTruck 负责安装 Skill，npm 负责安装可执行命令。安装 Skill 不会自动全局安装 npm 包。

```bash
npm install -g skilltruck codex-task
skilltruck install https://github.com/wangyendt/codex-task --global
```

如果不想全局安装 CLI，Agent 可回退到 `npx --yes codex-task@latest`。也可以运行 `codex-task skill path` 查看 npm 包内 Skill 的位置。

## 手机远程调用与开机自启

`codex-task serve` 把四类任务开放为带 Bearer Token 的异步 HTTP API。服务收到任务后立即返回 `jobId`，手机再轮询状态，不需要维持一个可能持续数分钟的请求。

| 目标 | 接口 |
| --- | --- |
| 文本结果 | `POST /v1/text` |
| 图片结果 | `POST /v1/image` |
| 工作区变更 | `POST /v1/task` |
| 回答追问 | `POST /v1/tasks/:taskId/resume` |
| 查询进度 | `GET /v1/jobs/:jobId` |
| 下载产物 | `GET /v1/jobs/:jobId/artifacts/:index` |

开机服务使用 `npm install -g codex-task@latest`。这样启动时不依赖 npm 网络，执行文件路径也不会变化。三平台脚本会安装或升级全局包、生成随机 token、创建用户级自启动项并立即启动服务。

```bash
# Ubuntu/Linux 或 macOS：自动识别 systemd user / LaunchAgent
bash ./scripts/service/install.sh

# 后台 Direct 请求需要代理时
CODEX_TASK_PROXY=socks5h://127.0.0.1:7890 bash ./scripts/service/install.sh

# Windows PowerShell：Scheduled Task
powershell -ExecutionPolicy Bypass -File .\scripts\service\Install-Windows.ps1
```

安装器按 `CODEX_TASK_PROXY`、`CODEXERRAND_PROXY`、`ALL_PROXY`、`HTTPS_PROXY` 的顺序捕获当前代理。macOS LaunchAgent、Linux systemd user service 和 Windows Scheduled Task 通常不会完整继承交互式终端环境，因此代理应在安装时显式提供；修改代理后重新运行安装脚本即可。代理地址只写入权限受限的 service runner，安装输出不会打印其内容。

安装脚本生成的是全权限主 Token。给手机或其他设备使用时，可以独立创建只允许 `text`、只允许 `image`，或同时允许两者的设备 Token；创建后立即生效，不需要重启服务：

```bash
codex-task token create --name iphone-text --allow text
codex-task token create --name ipad-media --allow text,image
codex-task token list
codex-task token revoke iphone-text
```

`create` 只在创建时返回一次完整 Token；`list` 只显示名称、权限和创建时间。设备 Token 只能使用 Direct，不能调用 SDK、`task` 或 `resume`；主 Token 仍可调用全部接口。这些命令和 `install.sh` 相互独立，可以在安装服务前后执行。

卸载自启动服务但保留全局 npm 包、Codex 登录和任务数据：

```bash
# Ubuntu/Linux 或 macOS
bash ./scripts/service/uninstall.sh

# Windows PowerShell
powershell -ExecutionPolicy Bypass -File .\scripts\service\Uninstall-Windows.ps1
```

默认监听 `0.0.0.0:7777` 以便手机访问，安装完成会打印 token。手机地址应填写电脑的局域网/VPN 地址，例如 `http://192.168.1.50:7777`，不能填写 `0.0.0.0`。

```bash
curl -sS http://127.0.0.1:7777/healthz
curl -sS -X POST http://127.0.0.1:7777/v1/text -H "Authorization: Bearer $CODEX_TASK_TOKEN" -H 'Content-Type: application/json' -d '{"prompt":"把这段需求整理成三条要点"}'
curl -sS http://127.0.0.1:7777/v1/jobs/替换为jobId -H "Authorization: Bearer $CODEX_TASK_TOKEN"
```

> [!CAUTION]
> 服务不内置 TLS，不能直接暴露到公网。建议只在可信局域网、Tailscale/WireGuard 或 HTTPS 反向代理后使用。主 Token 持有者拥有该电脑上 CodexTask 的完整执行权；远程 `task` 默认仍是 `danger-full-access`、可联网、`approval: never`。只需要文本或图片的设备应使用受限 Token。服务重启会丢失内存中的远程 job 查询记录，终态 job 和下载链接默认保留 24 小时；已返回的 SDK `taskId` 仍可按 CodexTask 自身状态恢复。

Android Kotlin 与 iOS Swift 示例见 [`examples/mobile`](./examples/mobile/README.md)：先调用 `image` 生成营养餐，下载图片后调用 `text` 做图生文，再用 `task` 修改服务器上的项目；如果 worker 追问，就用 `resume` 回答。部署、升级、卸载、JSON 字段和安全说明见[远程服务部署与移动端调用](./docs/knowhow/20260811_远程服务部署与移动端调用.md)。

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

Direct 按显式参数 → Codex `config.toml` → `models_cache.json` 首选模型 → 兼容 fallback 的顺序选择模型。当前文本可使用 `gpt-5.6-sol + medium/high`；私有 Responses Lite 路由不暴露托管 `image_generation`，所以 Direct 图片会在请求前选择兼容的 classic `gpt-5.5`。`gpt-5.6-sol` 仍有视觉能力，限制来自这条非官方 Direct 生图协议。JSON 会写入实际使用的 `effectiveModel` 和 `reasoningEffort`。

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
