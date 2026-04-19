import Foundation

class SSEClient {
    private var task: URLSessionDataTask?
    private let url: URL
    var onEvent: ((SSEEvent) -> Void)?

    init(jobId: String) {
        self.url = URL(string: "https://usepromptly.app/api/video-jobs/\(jobId)/stream")!
    }

    func connect() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 300
        config.timeoutIntervalForResource = 600
        let session = URLSession(configuration: config, delegate: SSEDelegate(onData: handleData), delegateQueue: nil)

        var request = URLRequest(url: url)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        if let token = AuthService.shared.accessToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        task = session.dataTask(with: request)
        task?.resume()
    }

    func disconnect() {
        task?.cancel()
        task = nil
    }

    private func handleData(_ data: Data) {
        guard let text = String(data: data, encoding: .utf8) else { return }
        let lines = text.components(separatedBy: "\n")
        for line in lines {
            if line.hasPrefix("data: ") {
                let jsonStr = String(line.dropFirst(6))
                if let jsonData = jsonStr.data(using: .utf8),
                   let event = try? JSONDecoder().decode(SSEEvent.self, from: jsonData) {
                    DispatchQueue.main.async { [weak self] in
                        self?.onEvent?(event)
                    }
                }
            }
        }
    }
}

struct SSEEvent: Codable {
    let status: String?
    let progress: Int?
    let step: String?
    let message: String?
    let videoUrl: String?
    let thumbnailUrl: String?
    let error: String?
    let final: Bool? // swiftlint:disable:this identifier_name
}

private class SSEDelegate: NSObject, URLSessionDataDelegate {
    let onData: (Data) -> Void

    init(onData: @escaping (Data) -> Void) {
        self.onData = onData
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        onData(data)
    }
}
