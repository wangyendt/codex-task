# 模型与思考等级 API

## 手机如何读取

```http
GET /v1/models
Authorization: Bearer TOKEN
```

主 Token、text/image 设备 Token 均可读取。该接口只返回白名单元数据，不返回 OAuth、路径或完整 Codex 配置。反向代理前缀保留，例如 `/services/codex-task/v1/models`。

响应字段：

| 字段 | 含义 |
| --- | --- |
| `source` | `codex-app-server` 或降级的 `codex-model-cache` |
| `updatedAt` | 上次成功查询时间；磁盘降级时为原缓存时间，未知为 null |
| `stale` | true 表示刷新失败、正在展示历史或磁盘缓存 |
| `warning` | 降级提示（可选） |
| `models[].id` | 提交任务时的 `model` |
| `models[].displayName` | 展示名称 |
| `models[].reasoningLevels` | 该模型声明的思考等级；保留服务端顺序 |
| `models[].defaultReasoning` | 模型声明的默认等级；无等级时为 null，并非修改服务的默认配置 |
| `models[].inputModalities` | 声明的输入类型，例如 text/image；不是生图能力标记 |

客户端传 `model` 和 `reasoning` 到任务提交接口。模型列表不代表逐个推理实测或 Direct 生图兼容性；图片任务保留所选主模型和等级，不主动替换为兼容模型；`effectiveModel` 表示发给上游的主模型，不是底层绘图模型。SDK 后端当前仅接受 low/medium/high/xhigh，与本目录的 Direct 选项不同。

缓存未出现的模型仍可能可用，因此保留手动模型 ID 输入。未收录模型的 Direct 默认校验范围仍为 low/medium/high。空等级列表不要虚构档位，应省略 reasoning。

## 刷新、故障与并发

- 普通查询结果缓存 5 分钟；过期后调用本机 `codex app-server` 的 `model/list`。
- `GET /v1/models?refresh=true` 跳过 5 分钟缓存，但刷新最短间隔为 15 秒。
- 并发查询复用同一个 Promise；单次查询 20 秒超时，分页与输出大小有上限。
- 不创建 thread/turn，不执行模型推理。响应是 CLI 当前可见目录，可能来自 CLI 自身的服务端或内置缓存，刷新不承诺远端一定有新模型。
- CLI 缺失、登录/网络异常时优先保留上次成功列表，其次读取同一个 Codex Home 的 `models_cache.json`，标记 stale。
- 无可用列表返回 HTTP 503；鉴权失败返回 401。客户端保留已保存选择并显示失败提示，不静默改模型。

## hx470 运维

以运行服务的 wayne 用户执行，而不是用 root 创建另一份 Codex 登录：

```bash
npm install --global --prefix "$HOME/.local" @openai/codex@latest --registry=https://registry.npmjs.org/ --prefer-online
"$HOME/.local/bin/codex" --version
```

随后在手机点击“刷新模型列表”。正常情况下无需重启 CodexTask，新查询会使用更新后的 CLI；服务进程的 PATH 必须包含该目录，也可以通过服务环境 `CODEX_TASK_CODEX_BIN` 指定可执行文件绝对路径。

需要升级 API/Direct 协议时另行更新 CodexTask：

```bash
npm install --global --prefix "$HOME/.local" codex-task@latest --registry=https://registry.npmjs.org/ --prefer-online
systemctl --user restart codex-task.service
```

Codex Desktop App、独立 Codex CLI、CodexTask、CodexTask 内置的 `@openai/codex-sdk` 是不同的软件包。更新独立 CLI 负责此模型目录；不会自动更新 SDK 依赖或其自带二进制。

## Direct 生图透传

目录用于展示可选项，不是生图能力白名单。Direct 生图原样保留选择的模型和等级（包括 ultra），不会按目录缺失或旧缓存拒绝组合，也不会替换为 gpt-5.5。上游实际拒绝的模型/等级/工具组合在异步任务结果中返回 DIRECT_UNSUPPORTED_MODEL、DIRECT_UNSUPPORTED_REASONING、DIRECT_UNSUPPORTED_IMAGE_MODEL 或 DIRECT_UNSUPPORTED_IMAGE_COMBINATION；限流、鉴权、网络及其它参数错误独立分类。错误不会建立永久禁用名单，下次用户提交照常尝试。

GET /v1/models 不再返回旧的 imageRouting 预检矩阵；客户端不需要它。可选的 imageModel 仍独立透传给绘图工具，省略则由上游选择，具体实际绘图版本未知。
