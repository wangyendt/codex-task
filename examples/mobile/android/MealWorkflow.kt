package xin.wangye.codextask

import org.json.JSONObject

suspend fun runMealWorkflow(
    client: CodexTaskClient,
    serverProjectPath: String,
): JSONObject {
    val imageJob = client.submitImage(
        prompt = "生成一张俯拍的健身营养餐：煎鸡胸肉、糙米、西兰花、牛油果，写实摄影，干净背景",
        promptFiles = listOf(PromptDocument("style.md", "自然光，食物边界清楚，不要文字和水印")),
    )
    val imageResult = client.awaitJob(imageJob)
    check(imageResult.getString("status") == "completed")
    val imageDownloadUrl = imageResult
        .getJSONObject("result")
        .getJSONArray("artifacts")
        .getJSONObject(0)
        .getString("downloadUrl")
    val mealPng = client.downloadArtifact(imageDownloadUrl)
    val meal = RemoteImage("meal.png", "image/png", mealPng)
    val nutritionSchema = JSONObject(
        """{"type":"object","properties":{"foods":{"type":"array"},"totalCalories":{"type":"number"}},"required":["foods","totalCalories"],"additionalProperties":false}""",
    )

    val textJob = client.submitText(
        prompt = "识别食物并估算总热量，只返回 JSON",
        images = listOf(meal),
        schema = nutritionSchema,
    )
    val nutrition = client.awaitJob(textJob)
    check(nutrition.getString("status") == "completed")

    val taskJob = client.submitTask(
        prompt = "根据营养分析实现餐食详情页并运行测试",
        workingDirectory = serverProjectPath,
        promptFiles = listOf(PromptDocument("nutrition.json", nutrition.getJSONObject("result").getString("text"))),
        images = listOf(meal),
    )
    val task = client.awaitJob(taskJob)
    if (task.getString("status") != "needs_input") return task

    val taskId = task.getJSONObject("result").getString("taskId")
    return client.awaitJob(
        client.resume(
            taskId = taskId,
            answer = "按单人份展示热量",
            images = listOf(meal),
        ),
    )
}
