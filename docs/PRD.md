# CodexErrand 产品需求文档

## 1. 产品概述

CodexErrand 是一个轻量、local-first、Codex-first 的跨 Agent 多模态任务运行器。调用方 Agent 通过 CLI 或 TypeScript SDK，把一个边界明确的任务交给独立 Codex worker，并取得结构化文本、图片或工作区变更结果。

产品提供两个显式后端：

- **Direct**：复用本机 Codex OAuth，通过 ChatGPT 私有 Codex Responses 接口执行纯文本、文生图和图生图；默认后端，非官方、实验性。
- **SDK**：通过官方 `@openai/codex-sdk` 启动 Codex CLI，执行需要 shell、文件系统、项目 rules 或本地工具的工作区任务。

CodexErrand 是独立的非官方开源项目，与 OpenAI 不存在隶属、认可或赞助关系。

## 2. 目标用户与核心场景

### 2.1 目标用户

- 已安装并登录 Codex 的开发者。
- 需要让 Claude Code、Codex、Gemini CLI 等 Agent 调用另一个 Codex worker 的用户。
- 需要统一文本生成、图片生成和轻量工作区任务接口的 TypeScript/CLI 使用者。

### 2.2 核心场景

1. 调用方 Agent 请求一个独立文本结果。
2. 调用方 Agent生成图片，或基于 1–5 张本地参考图编辑图片。
3. 调用方 Agent 把代码/文件任务交给 Codex SDK worker。
4. SDK worker 需要澄清时暂停，调用方取得答案后恢复同一 Codex thread。
5. companion skill 被 skillmanager 安装给其他 Agent，教它们正确选择 CLI 命令和后端。

## 3. 产品原则

- **轻量**：无 daemon、无内部队列、无工作流 DAG。
- **显式**：不提供 auto backend，不静默切换后端或模型重放请求。
- **Agent-first**：stdout 是稳定 JSON，流式模式是 JSONL。
- **Local-first**：复用本机 Codex 登录、配置、skills 和 session。
- **边界清楚**：Direct 不执行本地工具；workspace task 必须显式选择 SDK。
- **可清理**：临时图片和可恢复状态有 TTL 与容量上限。

## 4. 功能需求

### 4.1 CLI

```text
codexerrand text <prompt> [--backend direct|sdk]
codexerrand image <prompt> [--backend direct|sdk] [-i <path>...]
codexerrand task <prompt> --backend sdk [--cwd <path>]
codexerrand resume <task-id> <answer>
codexerrand doctor
codexerrand gc
codexerrand skill path
```

Prompt 支持位置参数、`--prompt-file` 或 stdin，三者互斥。Direct 是默认后端；`task` 在未显式传 `--backend sdk` 时返回参数错误。

### 4.2 Public SDK

导出：

- `generateText()`
- `generateImage()`
- `runTask()`
- `resumeTask()`
- `streamTaskEvents()`
- 配置、事件、结果和错误类型

### 4.3 Direct 后端

- 读取 `$CODEX_HOME/auth.json`，过期时加锁刷新并原子合并写回。
- 使用 native libcurl impersonation、HTTP/2、Codex headers、installation identity 和 SSE。
- 支持 classic Responses 与 Responses Lite 两套 encoder。
- 模型解析优先级：显式参数 → 用户配置 → Codex model cache 首选 → `gpt-5.6-sol` → `gpt-5.5`。文本可使用 Responses Lite；私有 Lite 路由不支持托管 `image_generation`，图片在请求前选择 compatible classic model。
- 默认 reasoning 为 `medium`；支持显式 `high` 等模型目录允许的档位。
- 请求发出前可以选择兼容 encoder/fallback；请求发出后不得静默换模型重放。
- 文本 worker 默认低冗余、single-turn、直接交付结果。

### 4.4 SDK 后端

- 默认 `danger-full-access`、`approval: never`、`network: true`。
- 默认运行一个 Codex turn，不做 planning 前置阶段。
- 使用 tagged-union output schema 返回 `completed | needs_input | failed`。
- `needs_input` 保存 task/thread metadata，允许同机同用户跨进程恢复。
- `--no-followup` 禁止 `needs_input`，要求采用合理假设完成或失败。
- 收集文件变更、命令摘要、产物和 usage；不默认输出 reasoning 或完整命令日志。

### 4.5 图片

- 输入格式：PNG、JPEG、WebP、GIF。
- 参考图：0–5 张；单图不超过 20 MiB，总输入不超过 50 MiB。
- 数量：1–10，默认 1；并发 1–3，默认 1。
- 尺寸：`auto` 或 `WIDTHxHEIGHT`，最长边不超过 3840。
- quality：`auto|low|medium|high`。
- background：`auto|opaque|transparent`。
- 默认不覆盖文件；`--overwrite` 显式允许。
- 每张图片生成后立即原子落盘，批次后续失败不丢失已完成图片。

### 4.6 输出与事件

- 最终状态：`completed | needs_input | failed | cancelled`。
- 结果至少包含 `taskId`、`backend`、`text`、`artifacts`、`effectiveModel`、`usage`；SDK 可包含 `threadId`、`changes`、`commands`、`questions`。
- 默认 stdout 只写最终 JSON；诊断写 stderr。
- `--stream` stdout 写 JSONL 事件：`started`、`progress`、`retrying`、`artifact`、`needs_input`、`completed`、`failed`。
- exit code：完成/追问 0、运行失败 1、参数错误 2、取消/超时 130。

### 4.7 状态、缓存和诊断

- 默认图片写入 `os.tmpdir()/codexerrand/<task-id>`，24 小时过期。
- `needs_input` metadata 写入平台 state 目录，7 天过期。
- 临时产物总上限 1 GiB，超过后优先删除最旧终态目录。
- 指定 `--output` 的文件视为用户数据，不自动删除。
- 每次启动执行轻量 GC，并提供显式 `gc`。
- `doctor` 只读检查 native transport、OAuth、模型/encoder、SDK/CLI 版本和路径，不泄露 token。

### 4.8 Companion skill

- 标准路径：`skills/codexerrand/SKILL.md`。
- plugin manifest：`.codex-plugin/plugin.json`。
- 该 skill 只教其他 Agent 调用 CodexErrand CLI，不是 worker skill。
- npm postinstall 不静默安装；通过 skillmanager 分发，`codexerrand skill path` 返回包内路径。

## 5. 非功能需求

- Node.js 20+、TypeScript、ESM-only，发布类型声明。
- Direct native transport 是 optional dependency；不可用时 SDK 仍可安装和运行。
- Direct text 总超时默认 10 分钟，image 每张 15 分钟，SDK task 30 分钟。
- Direct 默认最多重试 3 次，只重试 429、5xx、连接中断和空响应。
- 认证文件刷新必须跨进程加锁、read–merge–atomic rename。
- 中英文 README；Direct 非官方性质和 SDK 高权限默认值必须醒目说明。

## 6. 发布需求

- 初始版本 `0.1.0`，无 scope npm 包 `codexerrand`。
- main 任意 push 自动 patch 版本并提交 package/lockfile。
- lint、typecheck、unit test、build、pack check、安装/import smoke test 全部通过后才发布。
- npm Trusted Publishing/OIDC；成功后创建 `vX.Y.Z` tag。
- 线上 Direct E2E 永不在 CI 自动执行。

## 7. 明确不做

- 常驻服务、远程执行、内部队列、DAG。
- Direct 本地工具执行循环。
- 非 Codex provider。
- GUI/TUI。
- 跨机器恢复。
- 自动安装、选择或管理 Codex worker 使用的 skills。

## 8. 首版验收标准

1. CLI 和 SDK 的 Direct 文本、Direct 图片、SDK task 均有离线测试。
2. SDK `needs_input` 可保存并恢复；`--no-followup` 不返回追问。
3. CLI 输出符合 JSON/JSONL 契约，exit code 稳定。
4. 图片参数、大小、数量和覆盖保护均在请求前验证。
5. `doctor`、`gc`、`skill path` 可用。
6. npm tarball 只包含运行产物、skill 和必要文档，安装后可 import 并执行 `--help`。
7. 获得授权后，手动执行一次 Direct `gpt-5.6-sol` 文本和图片 smoke test；失败时诚实记录实验性限制，不伪造通过。
