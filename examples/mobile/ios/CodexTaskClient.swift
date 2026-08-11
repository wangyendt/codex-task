import Foundation

struct PromptDocument {
    let name: String
    let content: String
}

struct RemoteImage {
    let name: String
    let mimeType: String
    let data: Data
}

struct JobReceipt {
    let jobId: String
    let statusURL: String
}

enum CodexTaskClientError: Error {
    case invalidResponse
    case http(Int, String)
    case server(String)
}

final class CodexTaskClient {
    private let baseURL: URL
    private let token: String
    private let session: URLSession
    private let terminalStatuses = Set(["completed", "needs_input", "failed", "cancelled"])

    init(baseURL: URL, token: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    func submitText(
        prompt: String,
        promptFiles: [PromptDocument] = [],
        images: [RemoteImage] = [],
        schema: [String: Any]? = nil
    ) async throws -> JobReceipt {
        var body = payload(prompt: prompt, promptFiles: promptFiles, images: images)
        body["backend"] = "direct"
        body["reasoning"] = "medium"
        if let schema { body["schema"] = schema }
        return try await submit(path: "/v1/text", body: body)
    }

    func submitImage(
        prompt: String,
        promptFiles: [PromptDocument] = [],
        images: [RemoteImage] = []
    ) async throws -> JobReceipt {
        var body = payload(prompt: prompt, promptFiles: promptFiles, images: images)
        body["backend"] = "direct"
        body["quality"] = "high"
        body["count"] = 1
        return try await submit(path: "/v1/image", body: body)
    }

    func submitTask(
        prompt: String,
        workingDirectory: String,
        promptFiles: [PromptDocument] = [],
        images: [RemoteImage] = []
    ) async throws -> JobReceipt {
        var body = payload(prompt: prompt, promptFiles: promptFiles, images: images)
        body["workingDirectory"] = workingDirectory
        body["sandboxMode"] = "danger-full-access"
        body["networkAccess"] = true
        return try await submit(path: "/v1/task", body: body)
    }

    func resume(
        taskId: String,
        answer: String,
        promptFiles: [PromptDocument] = [],
        images: [RemoteImage] = []
    ) async throws -> JobReceipt {
        try await submit(
            path: "/v1/tasks/\(taskId)/resume",
            body: payload(prompt: answer, promptFiles: promptFiles, images: images)
        )
    }

    func awaitJob(_ receipt: JobReceipt, pollEveryNanoseconds: UInt64 = 1_000_000_000) async throws -> [String: Any] {
        while true {
            let snapshot = try await getJSON(path: receipt.statusURL)
            if let status = snapshot["status"] as? String, terminalStatuses.contains(status) { return snapshot }
            try await Task.sleep(nanoseconds: pollEveryNanoseconds)
        }
    }

    func downloadArtifact(path: String) async throws -> Data {
        var request = URLRequest(url: try resolve(path))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return data
    }

    private func submit(path: String, body: [String: Any]) async throws -> JobReceipt {
        let json = try await postJSON(path: path, body: body)
        guard let jobId = json["jobId"] as? String, let statusURL = json["statusUrl"] as? String else {
            throw CodexTaskClientError.invalidResponse
        }
        return JobReceipt(jobId: jobId, statusURL: statusURL)
    }

    private func postJSON(path: String, body: [String: Any]) async throws -> [String: Any] {
        var request = URLRequest(url: try resolve(path))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await executeJSON(request)
    }

    private func getJSON(path: String) async throws -> [String: Any] {
        var request = URLRequest(url: try resolve(path))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return try await executeJSON(request)
    }

    private func executeJSON(_ request: URLRequest) async throws -> [String: Any] {
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw CodexTaskClientError.invalidResponse
        }
        return json
    }

    private func validate(response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw CodexTaskClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw CodexTaskClientError.http(http.statusCode, String(data: data, encoding: .utf8) ?? "")
        }
    }

    private func payload(
        prompt: String,
        promptFiles: [PromptDocument],
        images: [RemoteImage]
    ) -> [String: Any] {
        [
            "prompt": prompt,
            "promptFiles": promptFiles.map { ["name": $0.name, "content": $0.content] },
            "images": images.map {
                ["name": $0.name, "mimeType": $0.mimeType, "dataBase64": $0.data.base64EncodedString()]
            },
        ]
    }

    private func resolve(_ path: String) throws -> URL {
        if let absolute = URL(string: path), absolute.scheme != nil { return absolute }
        guard let resolved = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw CodexTaskClientError.server("Invalid URL: \(path)")
        }
        return resolved
    }
}
