# CodexTask 产品需求文档

## 1. 产品概述

CodexTask 是轻量、local-first、Codex-first 的跨 Agent 多模态任务运行器。调用方通过 CLI、TypeScript API 或可选的自托管 HTTP 服务，把文本、图片和工作区任务交给独立 Codex worker，并取得结构化文本、图片或工作区变更。

产品按期望结果提供四个命令：

- `text`：生成文本；覆盖文生文、图生文和图文生文。
- `image`：生成图片；覆盖文生图、图生图和图文生图。
- `task`：通过 Codex SDK 完成工作区任务。
- `resume`：补充信息并恢复一个 `needs_input` 任务。

CodexTask 是独立的非官方开源项目，与 OpenAI 不存在隶属、认可或赞助关系。

## 2. 目标用户与场景

- 已安装并登录 Codex 的开发者。
- 需要让 Claude Code、Codex、Gemini CLI 等 Agent 调用另一个 Codex worker 的用户。
- 希望用一个接口统一文本生成、图片生成和边界明确的项目任务的 TypeScript/CLI 用户。

典型流程：生成健身营养餐图片；把该图与营养规则交给 `text` 取得 JSON；再把需求文件、参考图和项目目录交给 `task` 实现页面；如果 worker 追问，用 `resume` 继续同一任务。

## 3. 领域术语与产品原则

领域术语以根目录 [`CONTEXT.md`](../CONTEXT.md) 为准。产品界面使用“期望结果”命名，不以 `t2t`、`i2t`、`t2i`、`i2i` 作为命令名，因为同一请求可以同时包含文本、文件和图片。

- **轻量**：CLI/API 不要求 daemon；可选 HTTP 服务只有内存 job 队列，不引入数据库或工作流 DAG。
- **可组合**：位置文本、多个 prompt 文件、stdin 和多张图片可以共同组成一次请求。
- **显式**：不提供 auto backend，不在请求发出后静默切换模型重放。
- **Agent-first**：stdout 是稳定 JSON，流式模式是 JSONL。
- **Local-first**：复用本机 Codex 登录、配置、skills 和 sessions。
- **边界清楚**：Direct 不执行本地工具；工作区任务固定使用 SDK。
- **持久优先**：用户请求的最终图片默认写到当前目录；只有显式 `--temp` 才是受管临时产物。

## 4. 输入模型

四种任务共享一套 Input Part：

```text
[位置 prompt] + [-f prompt-file ...] + [非空 stdin] + [-i image ...]
```

- 文本组合顺序固定为：位置 prompt → prompt 文件命令行顺序 → stdin。
- 多个 prompt 文件分别带绝对路径边界标记，防止长内容相互混淆。
- prompt、prompt 文件和 stdin 不互斥。
- 图片保持 `-i` 顺序；最多 5 张。
- 至少需要一个非空文本来源；图片用于补充视觉上下文。
- CLI 与 TypeScript API 使用相同的解析、验证和后端映射。

## 5. 功能需求

### 5.1 CLI

```text
codex-task text [prompt] [-f <path>...] [-i <path>...] [--backend direct|sdk]
codex-task image [prompt] [-f <path>...] [-i <path>...] [--backend direct|sdk] [-o <path>|--temp]
codex-task task [prompt] [-f <path>...] [-i <path>...] [--cwd <path>]
codex-task resume <task-id> [answer] [-f <path>...] [-i <path>...]
codex-task doctor
codex-task gc
codex-task serve [--host <host>] [--port <port>] [--token-file <path>]
codex-task skill path
```

- `text` 与 `image` 默认 Direct，也允许手动指定 SDK。
- `task` 与 `resume` 固定使用 SDK，不在主帮助中展示 backend 选项。
- 为兼容旧自动化，`task --backend sdk` 可继续解析；文档不再推荐。
- 所有命令默认输出一个 JSON；`--stream` 输出 JSONL 事件。

### 5.2 TypeScript API

导出 `generateText()`、`generateImage()`、`runTask()`、`resumeTask()`、`streamTaskEvents()` 及相关配置、事件、结果和错误类型。

公共 Options 支持 `prompt?: string`、`promptFiles?: string[]` 和 `imagePaths?: string[]`；`ImageOptions` 额外支持 `temporary?: boolean`。

### 5.3 Direct 后端

- 读取 `$CODEX_HOME/auth.json`，过期时加锁刷新并原子合并写回。
- 使用 native libcurl impersonation、HTTP/2、Codex headers、installation identity 和 SSE。
- 文本请求可同时发送 `input_text` 和 `input_image`。
- 支持 classic Responses 与 Responses Lite encoder。
- 模型顺序：显式参数 → Codex config → Codex model cache → compatibility fallback。
- 文本可使用 `gpt-5.6-sol` 与 medium/high reasoning。
- 私有 Responses Lite 路由不暴露 hosted `image_generation`，Direct 图片在请求前选择 compatible classic `gpt-5.5`。
- 请求发出后不得静默换模型重放，避免重复计费或副作用。
- Direct 不读取工作区、不执行 shell、不调用本地 MCP 或 worker skills。

### 5.4 SDK 后端与工作区

- `task` 默认 `danger-full-access`、`approval: never`、`network: true`。
- `--cwd` 是 worker 的 current project：Codex 从该目录读取代码、项目 rules 与 skills，并以它作为命令和相对路径的基准。
- `task` 支持多个 prompt 文件和多张本地图片；映射为 SDK `text` 与 `local_image` 输入。
- 默认运行一个 Codex turn，不增加 plan-before-write 阶段。
- 使用 tagged-union output schema 返回 `completed | needs_input | failed`。
- `needs_input` 保存 task/thread metadata，允许同机同用户跨进程恢复。
- `resume` 的补充输入同样支持文本、多个文件和多张图片。
- `--no-followup` 禁止 `needs_input`，要求采用合理假设完成或失败；不承诺一定成功。
- 收集文件变更、命令摘要、产物和 usage；不默认暴露 reasoning 或完整命令日志。

### 5.5 图片

- 输入格式：PNG、JPEG、WebP、GIF。
- 参考图：0–5 张；单图 ≤ 20 MiB，总输入 ≤ 50 MiB。
- 数量：1–10，默认 1；并发：1–3，默认 1。
- 尺寸：`auto` 或 `WIDTHxHEIGHT`，最长边 ≤ 3840。
- quality：`auto|low|medium|high`。
- background：`auto|opaque|transparent`。
- 默认在当前目录写入唯一文件名 `image-<task-id前8位>.png`。
- `--output` 指定持久文件或目录；`--temp` 显式选择受管临时目录，两者互斥。
- 默认拒绝覆盖；`--overwrite` 显式允许。
- 每张完成后立即原子落盘，批次后续失败不丢失已完成图片。

### 5.6 输出、事件与退出码

- 状态：`completed | needs_input | failed | cancelled`。
- 结果至少包含 `taskId`、`backend` 与 `artifacts`；按能力包含 `text`、`effectiveModel`、`usage`、`threadId`、`changes`、`commands`、`questions`。
- JSONL 事件：`started`、`progress`、`retrying`、`artifact`、`needs_input`、`completed`、`failed`。
- exit code：完成/追问 0、运行失败 1、参数错误 2、取消/超时 130。

### 5.7 状态、缓存和诊断

- 仅 `--temp` 图片写入 `os.tmpdir()/codex-task/<task-id>`，24 小时后可清理。
- 默认/显式持久图片属于用户数据，`gc` 不删除。
- `needs_input` metadata 写入平台 state 目录，7 天过期。
- 受管临时产物总上限 1 GiB，超过后优先删除最旧终态目录。
- 每次启动执行轻量 GC，并提供显式 `gc`。
- 官方 SDK sessions 由 Codex 保存在 `$CODEX_HOME`，CodexTask 不删除。
- `doctor` 只读检查 transport、OAuth、模型/encoder、SDK/CLI 版本和路径，不泄露 token、不发送模型请求。

### 5.8 Companion Skill

- 标准路径：`skills/codex-task/SKILL.md`；plugin manifest：`.codex-plugin/plugin.json`。
- Skill 教其他 Agent 调用当前仓库提供的 CLI，不是 Codex worker 在任务中使用的 skill。
- SkillTruck 安装 Skill；npm 安装 CLI。Skill 不静默全局安装 npm 包。
- Skill 按期望结果选择命令，并明确 Direct、SDK、持久/临时输出边界。

### 5.9 自托管 HTTP 服务

- `codex-task serve` 默认监听 `127.0.0.1:7777`；监听非 loopback 地址必须提供 Service Token。
- 对外提供异步 `text`、`image`、`task`、`resume` 提交，job 轮询和鉴权 artifact 下载。
- 提交立即返回 `202 + jobId + statusUrl`，避免移动网络长连接承载完整模型调用。
- 远端请求支持 inline prompt、最多 20 份命名 prompt 文档，以及最多 5 张 base64 图片；不允许客户端提交服务器本地输入路径。
- 图片上传仅在任务运行期间物化到 `os.tmpdir()/codex-task/server/<job-id>`，终态后删除整个上传目录。
- 远程 image 产物使用受管临时输出；artifact URL 隐藏服务器绝对路径，默认随终态 job 保留 24 小时。
- job 队列只存在内存；服务重启后旧 job URL 不可查询。底层 SDK `needs_input` task metadata 仍按现有规则保存，调用方必须自行保留 task ID。
- 服务不内置 TLS/CORS/用户体系/公网穿透；推荐可信局域网、VPN 或 HTTPS 反向代理。
- Token 持有者拥有该用户的 CodexTask 权限；远程 `task` 默认权限与本地一致。
- 三平台安装脚本使用全局 `codex-task@latest`：Ubuntu systemd user、macOS LaunchAgent、Windows 用户登录 Scheduled Task。
- Android Kotlin 与 iOS Swift 示例必须覆盖 image、text、task、resume、轮询、上传和 artifact 下载。

## 6. 非功能与发布需求

- Node.js 20+、TypeScript、ESM-only，发布类型声明。
- Direct native transport 是 optional dependency；不可用时 SDK 仍可安装。
- Direct text 默认 10 分钟，image 每张 15 分钟，SDK task 30 分钟。
- Direct 最多重试 3 次，只重试 429、5xx、连接中断和空响应。
- main 任意 push 自动 patch；发布前必须通过 lint、workflow check、typecheck、test、build、pack check 和 clean install/import smoke test。
- npm Trusted Publishing/OIDC；发布成功后创建 `vX.Y.Z` tag。
- CI 永不自动执行真实 Direct E2E。
- 默认中文 README，独立英文 README。

## 7. 明确不做

- 中心化托管平台、跨用户租户系统、持久化远程 job 队列、DAG。
- Direct 本地工具循环。
- 非 Codex provider。
- GUI/TUI。
- 跨机器恢复。
- 自动安装、选择或管理 worker 使用的 skills。
- 以 `t2t/i2t/t2i/i2i` 作为公开命令。

## 8. 验收标准

1. 四个命令共享组合输入行为，CLI 与 TypeScript API 一致。
2. Direct 文本可接收图片；SDK text/image/task/resume 正确生成 `local_image` 输入。
3. SDK `needs_input` 可保存并恢复；`--no-followup` 不返回追问。
4. 图片默认落到当前目录；只有 `--temp` 是受管临时产物；二者的清理语义可验证。
5. 图片参数、输入大小、数量和覆盖保护均在请求前验证。
6. README、PRD、常用命令与 Skill 使用同一命令和术语。
7. 非 loopback 服务无 token 时拒绝启动；HTTP 集成测试覆盖鉴权、异步状态、四类任务和 artifact 下载。
8. npm tarball 包含运行产物、Skill、自启动脚本和移动端示例，安装后可 import 并执行 `--help`。
9. Ubuntu/macOS shell 脚本通过语法检查；Swift 示例通过类型检查；无法在当前 CI 编译的平台示例明确说明验证边界。
10. 获得授权后手动执行 Direct smoke test；失败时诚实记录实验性限制。
