# CodexTask 手机端示例

这里的 Android Kotlin 和 iOS Swift 客户端调用已经运行的 `codex-task serve`。推荐连接可信局域网、Tailscale/WireGuard，或带 HTTPS 的反向代理。

不要把生产 Service Token 提交到 Git，也不要硬编码到公开 App。示例构造器接收 token，私有 App 可以从 Android Keystore、iOS Keychain、受管配置或用户输入中读取。

安装脚本打印的是全权限主 Token。只需要文本和图片的 App 应使用独立设备 Token：

```bash
codex-task token create --name meal-app --allow text,image
```

命令只在创建时显示一次完整 Token，请把它存入 Android Keystore 或 iOS Keychain。`codex-task token list` 不显示秘密；不再信任设备时执行 `codex-task token revoke meal-app`，无需重启服务即可生效。设备 Token 只支持所列的 Direct `text`/`image` 接口；下面包含 `task` 和 `resume` 的完整 `MealWorkflow` 需要主 Token。

## 完整示例流程

两个 `MealWorkflow` 都会实际串起四类任务：

1. `POST /v1/image`：根据文字和 `style.md` 生成健身营养餐。
2. 轮询 job，读取 `result.artifacts[0].downloadUrl`，携带同一 token 下载图片。
3. `POST /v1/text`：把图片和 JSON Schema 一起上传，做图生文营养分析。
4. `POST /v1/task`：把营养 JSON、参考图片和服务器上的项目目录交给 Codex SDK 修改。
5. 如果返回 `needs_input`，使用 `result.taskId` 调用 `POST /v1/tasks/:taskId/resume`。

所有提交先返回 `202`、`jobId` 和 `statusUrl`。客户端轮询 `GET statusUrl`，直到 `completed`、`needs_input`、`failed` 或 `cancelled`。这种设计不会让手机保持一个可能持续数十分钟的 HTTP 请求。

命名 prompt 文档格式为 `{name, content}`；图片格式为 `{name, mimeType, dataBase64}`。text、image、task 和 resume 都能组合文本、多份文档与多张图片。

## Android

文件：

- [`android/CodexTaskClient.kt`](./android/CodexTaskClient.kt)：OkHttp + coroutines 客户端，包含四类提交、轮询与 artifact 下载。
- [`android/MealWorkflow.kt`](./android/MealWorkflow.kt)：完整营养餐流程。

Gradle 依赖：

```kotlin
implementation("com.squareup.okhttp3:okhttp:4.12.0")
implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
```

从 ViewModel 或协程中调用：

```kotlin
val client = CodexTaskClient("http://192.168.1.50:7777", tokenFromKeystore)
val result = runMealWorkflow(client, "/absolute/server/path/to/meal-app")
```

Android 默认阻止明文 HTTP。生产环境应使用 HTTPS 或 VPN；仅在可信局域网开发时，才通过范围收窄的 Network Security Config 放行指定主机，不要全局允许明文流量。

## iOS

文件：

- [`ios/CodexTaskClient.swift`](./ios/CodexTaskClient.swift)：Foundation `URLSession` async/await 客户端。
- [`ios/MealWorkflow.swift`](./ios/MealWorkflow.swift)：与 Android 相同的完整流程。

调用示例：

```swift
let client = CodexTaskClient(baseURL: URL(string: "http://192.168.1.50:7777")!, token: tokenFromKeychain)
let result = try await runMealWorkflow(client: client, serverProjectPath: "/absolute/server/path/to/meal-app")
```

iOS App Transport Security 默认阻止明文 HTTP。生产环境应使用 HTTPS 或 VPN；局域网调试时只为目标域名配置 ATS 开发例外。

## 服务地址

`0.0.0.0` 是电脑的监听地址，不是手机可以访问的目标地址。App 应配置电脑可达的地址，例如：

```text
http://192.168.1.50:7777
https://codex-task.example.internal
```

Token 通过 `Authorization: Bearer <token>` 发送。受限设备 Token 只能调用创建时允许的 `text`/`image`；主 Token 可以触发服务器上该用户权限范围内的全部 CodexTask，尤其要谨慎开放 `/v1/task`。
