# CodexTask

> 把一个明确的小任务交给另一个 AI Agent，拿回文本、图片或已经完成的工作。直接复用你现有的 Codex 环境。

[English](./README.md) · [产品需求文档](./docs/PRD.md) · [常用命令](./docs/常用命令.txt) · [Companion skill](./skills/codex-task/SKILL.md)

CodexTask 把 Codex 封装成可供其他 Agent 调用的轻量 worker，统一提供三类能力：

- 文生文；
- 文生图和图生图；
- 通过官方 Codex SDK 执行边界明确的工作区任务。

没有 daemon，没有托管服务，也不需要额外 API key。所有结果都使用适合 Agent 解析的稳定 JSON。

> [!IMPORTANT]
> CodexTask 是独立的非官方开源项目，与 OpenAI 不存在隶属、认可或赞助关系。Codex 与 OpenAI 为 OpenAI 的商标。

## 30 秒上手

需要 Node.js 20+，并已执行过 `codex login`。

```bash
npm install -g codex-task
codex-task doctor
```

生成文本：

```bash
codex-task text "把这些笔记整理成简洁的发布公告" --backend direct
```

生成持久图片：

```bash
codex-task image "精确、克制的机器人关节爆炸图" \
  --backend direct \
  --size 1536x1024 \
  --quality high \
  --output ./artifacts
```

基于参考图编辑：

```bash
codex-task image "保留主体，把背景换成整洁的工作室" \
  --backend direct \
  --image ./reference.png \
  --output ./artifacts
```

委派仓库任务：

```bash
codex-task task "实现这个功能并运行聚焦测试" \
  --backend sdk \
  --cwd /absolute/path/to/repo
```

## 两种后端

CodexTask 不猜测后端。CLI 默认是 Direct，但工作区任务必须显式写出 SDK。

| 能力 | `direct` | `sdk` |
| --- | --- | --- |
| 独立文本结果 | 支持 | 支持 |
| 文生图 / 图生图 | 原生提取图片 | 通过已安装的 `$imagegen` skill |
| shell 和文件修改 | 不支持 | 支持 |
| 项目 rules 和本地工具 | 不支持 | 支持 |
| 本地 Codex skills | 不支持 | 按 Codex 正常发现 |
| 底层 | 非官方 ChatGPT Codex Responses | 官方 `@openai/codex-sdk` |

Direct 会复用 `$CODEX_HOME/auth.json`、Codex installation metadata、TLS impersonation 和 ChatGPT 私有 Codex Responses 接口。输入仍会发往 ChatGPT，接口也可能随时变化。

SDK task 默认权限为：

```text
sandbox: danger-full-access
approval: never
network: true
```

这意味着它可以访问工作区外路径、执行命令并联网，而且不会询问权限。只把可信 prompt 和可信仓库交给它。

## 追问与恢复

SDK 默认先执行一个 turn。确实需要澄清时返回：

```json
{
  "status": "needs_input",
  "taskId": "...",
  "threadId": "...",
  "questions": ["是否必须保持旧响应格式？"],
  "artifacts": []
}
```

向用户确认后恢复同一个 Codex thread：

```bash
printf '%s' "是，必须保持。" | codex-task resume <task-id>
```

`--no-followup` 会要求 Codex 使用合理假设，只能完成或失败；它不保证模型一定成功。

## 安装给其他 Agent

仓库内置 `skills/codex-task/SKILL.md`。它教调用方 Agent 选择 `text`、`image`、`task` 或 `resume`，并不是注入底层 Codex worker 的 skill。

使用 [SkillTruck](https://github.com/wangyendt/skilltruck) 安装：

```bash
npm install -g skilltruck
skilltruck install https://github.com/wangyendt/codex-task --global
```

也可以查看 npm 包内 skill 的位置：

```bash
codex-task skill path
```

## TypeScript API

```ts
import { generateImage, generateText, runTask } from "codex-task";

const text = await generateText({
  prompt: "写一个标题和三个卖点。",
  backend: "direct",
});

const image = await generateImage({
  prompt: "Agent 之间传递任务的克制等距插画。",
  backend: "direct",
  output: "./artifacts",
});

const work = await runTask({
  prompt: "实现功能并运行聚焦测试。",
  backend: "sdk",
  workingDirectory: "/absolute/path/to/repo",
});
```

## 图片参数

```text
参考图       0–5 张本地 PNG/JPEG/WebP/GIF
size         auto 或 WIDTHxHEIGHT，最长边 ≤3840
quality      auto | low | medium | high
background   auto | opaque | transparent
count        1–10
concurrency  1–3，默认 1
```

单张参考图不超过 20 MiB，总和不超过 50 MiB。默认拒绝覆盖已有文件，只有显式传 `--overwrite` 才会替换。每张图片完成后立即原子落盘，后续图片失败不会丢失已经生成的产物。

## Agent 友好的输出

- 默认 stdout 是一个最终 JSON。
- `--stream` 将 stdout 改为 JSONL 进度事件，不保证逐 token 输出。
- 诊断信息写 stderr。
- exit code：完成/追问为 `0`，运行失败为 `1`，参数错误为 `2`，取消或超时为 `130`。

长 prompt 推荐使用文件或 stdin：

```bash
codex-task text --prompt-file task.md --backend direct
printf '%s' "$PROMPT" | codex-task task --backend sdk --cwd .
```

## 模型和配置

SDK 默认不覆写模型和 reasoning，继续按 Codex 正常配置读取。

Direct 按以下顺序选择模型：显式参数 → Codex `config.toml` → `models_cache.json` 首选模型 → 兼容 fallback。它同时实现 classic Responses 和 Responses Lite encoder；当前模型目录下文本默认是 `gpt-5.6-sol + medium`。私有 Responses Lite 路由会拒绝托管 `image_generation`，因此 Direct 图片会在发出请求前选择兼容的 classic `gpt-5.5`。最终 JSON 会返回真实的 `effectiveModel` 和 `reasoningEffort`。

配置优先级为 API/CLI → `CODEX_TASK_*` 环境变量 → 用户配置 → Codex 配置 → fallback。运行 `codex-task doctor` 可以查看真实路径和解析结果。迁移期间，仅当新的变量或路径不存在时才兼容读取旧的 `CODEXERRAND_*` 环境变量以及 CodexErrand 配置/待恢复任务；新状态始终写入 CodexTask 路径。

## 临时文件

- 不传 `--output` 的图片放系统临时目录，默认 24 小时过期。
- `needs_input` 的小型状态放平台 state 目录，默认保存 7 天。
- 临时产物总上限 1 GiB。
- 显式 `--output` 下的文件属于用户数据，`codex-task gc` 永远不会删除。
- 官方 SDK 的 session 仍由 Codex 自己保存在 `$CODEX_HOME`，CodexTask 不删除。

## 开发和发布

```bash
npm install
npm run verify
```

`verify` 会执行 lint、类型检查、单元测试、构建、npm 包内容检查和干净安装/import smoke test。真实 Direct endpoint 测试必须显式开启，CI 永远不会运行：

```bash
RUN_DIRECT_E2E=1 npm run test:e2e
```

每次 push 到 `main` 自动发布 patch 版本。详细设置见 [发布说明](./docs/RELEASING.md)。

## 致谢与许可

Direct 后端部分技术和 MIT 代码源自 [`lawrencewzen/imgen`](https://github.com/lawrencewzen/imgen)，详见 [第三方声明](./THIRD_PARTY_NOTICES.md)。

MIT © 2026 ye.wang
