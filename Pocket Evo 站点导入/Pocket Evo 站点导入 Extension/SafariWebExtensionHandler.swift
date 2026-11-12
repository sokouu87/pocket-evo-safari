//
//  SafariWebExtensionHandler.swift
//  Pocket Evo 站点导入 Extension
//
//  由 scripts/fix-xcode-native.mjs 在 safari-web-extension-converter 转换后注入。
//  转换器每次都会重新生成这个文件，自定义逻辑必须放在 scripts/safari-native/ 下。
//

import SafariServices
import os.log

private final class TorrentRedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        guard let original = task.originalRequest?.url, let target = request.url,
              original.scheme == target.scheme, original.host == target.host,
              original.port == target.port else {
            completionHandler(nil)
            return
        }
        completionHandler(request)
    }
}

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    private let maxBodyBytes = 1_000_000

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let profile: UUID?
        if #available(iOS 17.0, macOS 14.0, *) {
            profile = request?.userInfo?[SFExtensionProfileKey] as? UUID
        } else {
            profile = request?.userInfo?["profile"] as? UUID
        }

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        var payload: [String: Any] = [:]
        if let dict = message as? [String: Any], let action = dict["action"] as? String {
            switch action {
            case "fetch", "fetch-image", "fetch-torrent":
                payload = handleFetch(dict)
            case "echo":
                payload = ["echo": dict["payload"] ?? NSNull(), "action": "echo"]
            default:
                payload = ["echo": message ?? NSNull(), "unknownAction": action]
            }
        } else {
            payload = ["echo": message ?? NSNull()]
        }

        os_log(.default, "PocketEvo native message handled (profile: %@)", profile?.uuidString ?? "none")

        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: payload]
        } else {
            response.userInfo = ["message": payload]
        }

        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    /// 在 appex 内发起真实 HTTP 请求。原生代码不受浏览器 forbidden header 约束，
    /// 因此可以原样带上 Cookie / User-Agent 等请求头。
    private func handleFetch(_ dict: [String: Any]) -> [String: Any] {
        guard let urlString = dict["url"] as? String, let url = URL(string: urlString),
              ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
            return ["ok": false, "status": -1, "text": "", "error": "invalid url"]
        }

        var request = URLRequest(url: url)
        let isImage = dict["action"] as? String == "fetch-image"
        let isTorrent = dict["action"] as? String == "fetch-torrent"
        if isImage {
            let host = url.host?.lowercased() ?? ""
            let referer = host == "doubanio.com" || host.hasSuffix(".doubanio.com")
                ? "https://movie.douban.com/" : "\(url.scheme ?? "https")://\(host)/"
            request.setValue(referer, forHTTPHeaderField: "Referer")
            request.setValue("Mozilla/5.0", forHTTPHeaderField: "User-Agent")
        }
        request.httpMethod = (dict["method"] as? String) ?? "GET"
        if let headers = dict["headers"] as? [String: String] {
            for (key, value) in headers {
                request.setValue(value, forHTTPHeaderField: key)
            }
        }
        let timeout = (dict["timeout"] as? Double) ?? 20
        request.timeoutInterval = timeout
        // 站点域的做种统计等会 POST 一个 urlencoded body，原样带上
        if let body = dict["body"] as? String {
            request.httpBody = body.data(using: .utf8)
        }

        let semaphore = DispatchSemaphore(value: 0)
        var result: [String: Any] = ["ok": false, "status": -1, "text": "", "error": "no response"]
        let session = isTorrent
            ? URLSession(configuration: .ephemeral, delegate: TorrentRedirectPolicy(), delegateQueue: nil)
            : (isImage ? URLSession(configuration: .ephemeral) : URLSession.shared)
        defer { if isTorrent || isImage { session.invalidateAndCancel() } }
        let task = session.dataTask(with: request) { data, response, error in
            defer { semaphore.signal() }
            if let error = error {
                result = ["ok": false, "status": -1, "text": "", "error": error.localizedDescription]
                return
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            if isTorrent {
                if (300..<400).contains(status), let httpResponse = response as? HTTPURLResponse,
                   let location = httpResponse.value(forHTTPHeaderField: "Location"),
                   let redirect = URL(string: location, relativeTo: httpResponse.url)?.absoluteURL {
                    result = ["ok": false, "status": status, "redirectUrl": redirect.absoluteString]
                    return
                }
                guard (200..<300).contains(status), let torrentData = data,
                      !torrentData.isEmpty, torrentData.count <= 20_000_000 else {
                    result = ["ok": false, "status": status]
                    return
                }
                result = ["ok": true, "status": status, "base64": torrentData.base64EncodedString()]
                return
            }
            if isImage {
                let mime = response?.mimeType?.lowercased() ?? ""
                guard (200..<300).contains(status), mime.hasPrefix("image/"),
                      let imageData = data, !imageData.isEmpty, imageData.count <= 5_000_000 else {
                    result = ["ok": false, "status": status, "error": "invalid image response"]
                    return
                }
                result = ["ok": true, "status": status, "dataUrl": "data:\(mime);base64,\(imageData.base64EncodedString())"]
                return
            }
            let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            let truncated = body.utf8.count > self.maxBodyBytes
                ? String(body.utf8.prefix(self.maxBodyBytes)) ?? body
                : body
            result = ["ok": (200..<300).contains(status), "status": status, "text": truncated, "truncated": truncated]
        }
        task.resume()
        if semaphore.wait(timeout: .now() + timeout + 5) == .timedOut {
            task.cancel()
            return ["ok": false, "status": -1, "text": "", "error": "timeout"]
        }
        return result
    }

}
