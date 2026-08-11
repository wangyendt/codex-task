package xin.wangye.codextask

import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

data class PromptDocument(val name: String, val content: String)
data class RemoteImage(val name: String, val mimeType: String, val bytes: ByteArray)
data class JobReceipt(val jobId: String, val statusUrl: String)

class CodexTaskClient(
    baseUrl: String,
    private val token: String,
    private val http: OkHttpClient = OkHttpClient(),
) {
    private val baseUrl = baseUrl.trimEnd('/')
    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()
    private val terminal = setOf("completed", "needs_input", "failed", "cancelled")

    suspend fun submitText(
        prompt: String,
        promptFiles: List<PromptDocument> = emptyList(),
        images: List<RemoteImage> = emptyList(),
        schema: JSONObject? = null,
    ): JobReceipt = submit("/v1/text", payload(prompt, promptFiles, images).apply {
        put("backend", "direct")
        put("reasoning", "medium")
        if (schema != null) put("schema", schema)
    })

    suspend fun submitImage(
        prompt: String,
        promptFiles: List<PromptDocument> = emptyList(),
        images: List<RemoteImage> = emptyList(),
        quality: String = "high",
    ): JobReceipt = submit("/v1/image", payload(prompt, promptFiles, images).apply {
        put("backend", "direct")
        put("quality", quality)
        put("count", 1)
    })

    suspend fun submitTask(
        prompt: String,
        workingDirectory: String,
        promptFiles: List<PromptDocument> = emptyList(),
        images: List<RemoteImage> = emptyList(),
    ): JobReceipt = submit("/v1/task", payload(prompt, promptFiles, images).apply {
        put("workingDirectory", workingDirectory)
        put("sandboxMode", "danger-full-access")
        put("networkAccess", true)
    })

    suspend fun resume(
        taskId: String,
        answer: String,
        promptFiles: List<PromptDocument> = emptyList(),
        images: List<RemoteImage> = emptyList(),
    ): JobReceipt = submit("/v1/tasks/$taskId/resume", payload(answer, promptFiles, images))

    suspend fun awaitJob(receipt: JobReceipt, pollEveryMillis: Long = 1_000): JSONObject {
        while (true) {
            val snapshot = getJson(receipt.statusUrl)
            if (snapshot.getString("status") in terminal) return snapshot
            delay(pollEveryMillis)
        }
    }

    suspend fun downloadArtifact(downloadUrl: String): ByteArray = withContext(Dispatchers.IO) {
        val request = authorized(Request.Builder().url(resolve(downloadUrl))).get().build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) error("Artifact download failed: HTTP ${response.code}")
            response.body?.bytes() ?: error("Artifact response is empty")
        }
    }

    private suspend fun submit(path: String, body: JSONObject): JobReceipt {
        val json = postJson(path, body)
        return JobReceipt(json.getString("jobId"), json.getString("statusUrl"))
    }

    private suspend fun postJson(path: String, body: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        val request = authorized(Request.Builder().url(resolve(path)))
            .post(body.toString().toRequestBody(jsonMediaType))
            .build()
        executeJson(request)
    }

    private suspend fun getJson(path: String): JSONObject = withContext(Dispatchers.IO) {
        executeJson(authorized(Request.Builder().url(resolve(path))).get().build())
    }

    private fun executeJson(request: Request): JSONObject {
        http.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) error("CodexTask HTTP ${response.code}: $text")
            return JSONObject(text)
        }
    }

    private fun payload(
        prompt: String,
        promptFiles: List<PromptDocument>,
        images: List<RemoteImage>,
    ): JSONObject = JSONObject().apply {
        put("prompt", prompt)
        put("promptFiles", JSONArray(promptFiles.map { JSONObject().put("name", it.name).put("content", it.content) }))
        put("images", JSONArray(images.map {
            JSONObject()
                .put("name", it.name)
                .put("mimeType", it.mimeType)
                .put("dataBase64", Base64.encodeToString(it.bytes, Base64.NO_WRAP))
        }))
    }

    private fun authorized(builder: Request.Builder): Request.Builder =
        builder.header("Authorization", "Bearer $token")

    private fun resolve(path: String): String = if (path.startsWith("http")) path else "$baseUrl$path"
}
