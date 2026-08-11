import Foundation

func runMealWorkflow(
    client: CodexTaskClient,
    serverProjectPath: String
) async throws -> [String: Any] {
    let imageReceipt = try await client.submitImage(
        prompt: "生成一张俯拍的健身营养餐：煎鸡胸肉、糙米、西兰花、牛油果，写实摄影，干净背景",
        promptFiles: [PromptDocument(name: "style.md", content: "自然光，食物边界清楚，不要文字和水印")]
    )
    let imageResult = try await client.awaitJob(imageReceipt)
    guard imageResult["status"] as? String == "completed",
          let generated = imageResult["result"] as? [String: Any],
          let artifacts = generated["artifacts"] as? [[String: Any]],
          let downloadPath = artifacts.first?["downloadUrl"] as? String else {
        return imageResult
    }
    let mealPNG = try await client.downloadArtifact(path: downloadPath)
    let meal = RemoteImage(name: "meal.png", mimeType: "image/png", data: mealPNG)
    let schema: [String: Any] = [
        "type": "object",
        "properties": [
            "foods": ["type": "array"],
            "totalCalories": ["type": "number"],
        ],
        "required": ["foods", "totalCalories"],
        "additionalProperties": false,
    ]

    let textReceipt = try await client.submitText(
        prompt: "识别食物并估算总热量，只返回 JSON",
        images: [meal],
        schema: schema
    )
    let nutrition = try await client.awaitJob(textReceipt)
    guard nutrition["status"] as? String == "completed" else { return nutrition }

    let result = nutrition["result"] as? [String: Any]
    let nutritionText = result?["text"] as? String ?? "{}"
    let taskReceipt = try await client.submitTask(
        prompt: "根据营养分析实现餐食详情页并运行测试",
        workingDirectory: serverProjectPath,
        promptFiles: [PromptDocument(name: "nutrition.json", content: nutritionText)],
        images: [meal]
    )
    let task = try await client.awaitJob(taskReceipt)
    guard task["status"] as? String == "needs_input",
          let taskResult = task["result"] as? [String: Any],
          let taskId = taskResult["taskId"] as? String else {
        return task
    }
    return try await client.awaitJob(
        try await client.resume(taskId: taskId, answer: "按单人份展示热量", images: [meal])
    )
}
