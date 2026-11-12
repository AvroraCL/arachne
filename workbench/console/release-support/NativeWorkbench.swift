import AppKit
import Darwin
import Foundation
import WebKit

struct NativeDownloadTarget {
    private struct Revision: Equatable {
        let device: dev_t
        let inode: ino_t
        let size: off_t
        let modifiedSeconds: Int
        let modifiedNanoseconds: Int
        let changedSeconds: Int
        let changedNanoseconds: Int
    }

    enum TargetError: LocalizedError {
        case notRegular, changed
        var errorDescription: String? {
            switch self {
            case .notRegular: return "请选择普通文件作为下载目标。"
            case .changed: return "目标文件在下载期间发生变化。"
            }
        }
    }

    let temporary: URL
    let destination: URL
    private let original: Revision?

    init(destination: URL) throws {
        self.destination = destination
        original = try Self.revision(destination)
        temporary = destination.deletingLastPathComponent()
            .appendingPathComponent(".arachne-\(UUID().uuidString).download")
    }

    private static func revision(_ file: URL) throws -> Revision? {
        var info = stat()
        let result = file.withUnsafeFileSystemRepresentation { name in
            name.map { lstat($0, &info) } ?? -1
        }
        if result != 0 {
            let code = errno
            if code == ENOENT { return nil }
            throw POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO)
        }
        guard info.st_mode & S_IFMT == S_IFREG else { throw TargetError.notRegular }
        return Revision(device: info.st_dev, inode: info.st_ino, size: info.st_size,
                        modifiedSeconds: info.st_mtimespec.tv_sec, modifiedNanoseconds: info.st_mtimespec.tv_nsec,
                        changedSeconds: info.st_ctimespec.tv_sec, changedNanoseconds: info.st_ctimespec.tv_nsec)
    }

    func finish() throws {
        guard try Self.revision(destination) == original else { throw TargetError.changed }
        if original != nil {
            _ = try FileManager.default.replaceItemAt(destination, withItemAt: temporary)
        } else {
            try FileManager.default.moveItem(at: temporary, to: destination)
        }
    }
}

// The workbench continues to use the local project service. WebKit never gets
// a general-purpose native file or shell bridge.
final class NativeWorkbench: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply {
    let window: NSWindow
    private let webView: WKWebView
    private let origin: URL
    private var recoveryURL: URL
    private var rendererStopped = false
    private var recoveryPromptOpen = false
    private var childWindows: [NSWindow] = []
    private var downloads: Set<ObjectIdentifier> = []
    private var downloadTargets: [ObjectIdentifier: NativeDownloadTarget] = [:]
    var onProject: ((String, String) -> Void)?

    init(url: URL, autosaveName: String? = "ArachneWorkbench", dataStore: WKWebsiteDataStore = .default()) {
        origin = url
        recoveryURL = url
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = dataStore
        webView = WKWebView(frame: .zero, configuration: configuration)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        super.init()
        configuration.userContentController.add(self, name: "arachne")
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "arachneNodeClipboard")
        #if ARACHNE_DEV
        let diagnostic="""
        window.addEventListener('error', e => window.webkit.messageHandlers.arachne.postMessage({type:'diagnostic',message:String(e.message||'script error').slice(0,500)}));
        window.addEventListener('unhandledrejection', e => window.webkit.messageHandlers.arachne.postMessage({type:'diagnostic',message:String(e.reason?.message||e.reason||'promise rejected').slice(0,500)}));
        """
        configuration.userContentController.addUserScript(WKUserScript(source:diagnostic,injectionTime:.atDocumentStart,forMainFrameOnly:true))
        #endif
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window.delegate = self
        window.title = "阿拉克涅"
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = webView
        window.isReleasedWhenClosed = false
        if autosaveName.map({ window.setFrameUsingName($0) }) != true { window.center() }
        fitWindowToScreen()
        if let autosaveName = autosaveName { window.setFrameAutosaveName(autosaveName) }
        webView.load(URLRequest(url: url))
    }

    func show() {
        fitWindowToScreen()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        offerRendererRecovery()
    }

    static func visibleWindowFrame(_ saved: NSRect, displays: [NSRect], primary: NSRect) -> NSRect {
        func overlap(_ display: NSRect) -> CGFloat {
            let intersection = saved.intersection(display)
            return intersection.isNull ? 0 : intersection.width * intersection.height
        }
        let matching = displays.max { overlap($0) < overlap($1) }
        let hasDisplay = matching.map { overlap($0) > 0 } ?? false
        let display = hasDisplay ? (matching ?? primary) : primary
        let width = min(max(900, saved.width), display.width)
        let height = min(max(600, saved.height), display.height)
        let x = hasDisplay ? max(display.minX, min(saved.minX, display.maxX - width)) : display.midX - width / 2
        let y = hasDisplay ? max(display.minY, min(saved.minY, display.maxY - height)) : display.midY - height / 2
        return NSRect(x: x, y: y, width: width, height: height)
    }

    func fitWindowToScreen() {
        guard !window.styleMask.contains(.fullScreen),
              let primary = NSScreen.screens.first?.visibleFrame else { return }
        let frame = Self.visibleWindowFrame(window.frame, displays: NSScreen.screens.map(\.visibleFrame), primary: primary)
        window.minSize = NSSize(width: min(900, frame.width), height: min(600, frame.height))
        if frame != window.frame { window.setFrame(frame, display: window.isVisible) }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard webView === self.webView else { return }
        rendererStopped = true
        offerRendererRecovery()
    }

    private func offerRendererRecovery() {
        guard rendererStopped, window.isVisible, !recoveryPromptOpen else { return }
        recoveryPromptOpen = true
        let alert = NSAlert()
        alert.messageText = "工作台显示进程已停止"
        alert.informativeText = "重新载入后会打开最新保存的工程，并检查此窗口可恢复的笔触。"
        alert.addButton(withTitle: "重新载入")
        alert.addButton(withTitle: "暂时隐藏")
        alert.beginSheetModal(for: window) { [weak self] result in
            guard let self else { return }
            recoveryPromptOpen = false
            if result == .alertFirstButtonReturn {
                rendererStopped = false
                webView.load(URLRequest(url: recoveryURL))
            } else { window.orderOut(nil) }
        }
    }

    // Closing a window hides it, as on macOS; it does not discard an edit or
    // terminate the service. Cmd-Q is checked separately before shutdown.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if sender === window { sender.orderOut(nil); return false }
        return true
    }

    func windowWillClose(_ notification: Notification) {
        if let closing = notification.object as? NSWindow { childWindows.removeAll { $0 === closing } }
    }

    private func sameOrigin(_ url: URL?) -> Bool {
        guard let url = url else { return false }
        return url.scheme == "http" && url.host == "127.0.0.1" && url.port == origin.port
    }

    private func trusted(_ frame: WKFrameInfo) -> Bool {
        let value = frame.securityOrigin
        return frame.isMainFrame && value.protocol == "http" && value.host == "127.0.0.1" && Int(value.port) == origin.port
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "arachne", trusted(message.frameInfo), let body = message.body as? [String: Any] else { return }
        #if ARACHNE_DEV
        if body["type"] as? String == "diagnostic", let value=body["message"] as? String { fputs("WebKit: \(value)\n",stderr);return }
        #endif
        if body["type"] as? String == "imageClipboard" {
            guard let encoded = body["png"] as? String, encoded.utf8.count <= 32*1024*1024,
                  let png = Data(base64Encoded: encoded), png.count >= 24, png.count <= 24*1024*1024,
                  Array(png.prefix(8)) == [137,80,78,71,13,10,26,10] else { return }
            let width = png[16..<20].reduce(0) { ($0 << 8) | Int($1) }
            let height = png[20..<24].reduce(0) { ($0 << 8) | Int($1) }
            guard (1...4096).contains(width), (1...4096).contains(height) else { return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setData(png, forType: .png)
            return
        }
        guard body["type"] as? String == "project",
              let id = body["id"] as? String, id.range(of: "^[A-Za-z0-9_-]{1,100}$", options: .regularExpression) != nil,
              let name = body["name"] as? String, name.count <= 200 else { return }
        window.title = name.isEmpty ? "阿拉克涅" : "\(name) — 阿拉克涅"
        if var components = URLComponents(url: webView.url ?? origin, resolvingAgainstBaseURL: false) {
            var items = (components.queryItems ?? []).filter { $0.name != "project" }
            items.append(URLQueryItem(name: "project", value: id))
            components.queryItems = items
            if let url = components.url, sameOrigin(url) { recoveryURL = url }
        }
        onProject?(id, name)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.name == "arachneNodeClipboard", trusted(message.frameInfo), window.isKeyWindow,
              let body = message.body as? [String: Any], let action = body["action"] as? String else {
            replyHandler(nil, "剪贴板需要工作台处于前台"); return
        }
        func isNodeText(_ text: String) -> Bool {
            text.hasPrefix("arachne-material-nodes/v1\n") && text.utf16.count <= 128*1024
        }
        let pasteboard = NSPasteboard.general
        if action == "read" {
            let value = pasteboard.string(forType: .string).flatMap { isNodeText($0) ? $0 : nil }
            replyHandler(value as Any? ?? NSNull(), nil)
        } else if action == "write", let text = body["text"] as? String, isNodeText(text) {
            pasteboard.clearContents()
            replyHandler(pasteboard.setString(text, forType: .string), nil)
        } else { replyHandler(false, nil) }
    }

    #if ARACHNE_DEV
    func webView(_ webView:WKWebView, didFinish navigation:WKNavigation!) {
        guard webView === self.webView else { return }
        webView.evaluateJavaScript("JSON.stringify({secure:window.isSecureContext,uuid:typeof window.crypto?.randomUUID})") { value,_ in
            if let value=value as? String { fputs("WebKit capabilities: \(value)\n",stderr) }
        }
    }
    #endif

    func perform(_ command: String) {
        // The enum is fixed here, so no user string is interpolated into JS.
        let allowed = ["newProject", "openProject", "saveProjectCopy", "projectDetails", "importArchive", "migrateModel", "searchCommands", "workspaceLayouts", "createBackup", "downloadBackup", "export", "history", "renderSettings", "renderTasks", "settings", "save", "undo", "redo", "cut", "copy", "paste", "selectAll", "copyMerged", "pasteInPlace"]
        guard allowed.contains(command), sameOrigin(webView.url) else { NSSound.beep(); return }
        webView.evaluateJavaScript("window.arachneNativeHost?.command('\(command)', {nativeEdit:true}) ?? false") { value, error in
            if value as? String == "native-text",
               let action = ["cut":"cut:", "copy":"copy:", "paste":"paste:", "selectAll":"selectAll:"][command],
               NSApp.sendAction(Selector(action), to: nil, from: nil) { return }
            if error != nil || (value as? Bool) != true { NSSound.beep() }
        }
    }

    func prepareToQuit(_ completion: @escaping (String) -> Void) {
        guard !rendererStopped, sameOrigin(webView.url) else {
            completion(downloads.isEmpty ? "unavailable" : "downloads"); return
        }
        var completed = false
        func finish(_ state: String) {
            guard !completed else { return }
            completed = true
            completion(!downloads.isEmpty && !["saving", "editing", "unsaved"].contains(state) ? "downloads" : state)
        }
        let timeout = DispatchWorkItem { finish("unavailable") }
        DispatchQueue.main.asyncAfter(deadline: .now() + 12, execute: timeout)
        Task { @MainActor in
            defer { timeout.cancel() }
            do {
                let value = try await webView.callAsyncJavaScript(
                    "const host=window.arachneNativeHost; return host?.prepareToCloseAsync ? await host.prepareToCloseAsync() : host?.prepareToClose() ?? null",
                    arguments: [:], in: nil, contentWorld: .page)
                guard let status = value as? [String: Any], let state = status["state"] as? String,
                      ["ready", "saving", "editing", "error", "unsaved", "jobs"].contains(state) else {
                    finish("unavailable"); return
                }
                finish(state)
            } catch { finish("unavailable") }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let target = action.request.url else { decisionHandler(.cancel); return }
        let local = sameOrigin(target)
        if action.shouldPerformDownload && (local || (target.scheme == "blob" && trusted(action.sourceFrame))) {
            decisionHandler(.download); return
        }
        if local || target.absoluteString == "about:blank" { decisionHandler(.allow); return }
        if action.navigationType == .linkActivated, ["https", "http"].contains(target.scheme?.lowercased() ?? ""), trusted(action.sourceFrame) {
            NSWorkspace.shared.open(target)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if !response.canShowMIMEType, sameOrigin(response.response.url) { decisionHandler(.download); return }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        downloads.insert(ObjectIdentifier(download)); download.delegate = self
    }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        downloads.insert(ObjectIdentifier(download)); download.delegate = self
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard trusted(frame) else { completionHandler(nil); return }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: webView.window ?? window) { response in completionHandler(response == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard action.targetFrame == nil, let target = action.request.url, trusted(action.sourceFrame) else { return nil }
        guard sameOrigin(target) else {
            if action.navigationType == .linkActivated, ["http", "https"].contains(target.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(target) }
            return nil
        }
        let child = WKWebView(frame: .zero, configuration: configuration)
        child.navigationDelegate = self; child.uiDelegate = self
        let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 700),
                             styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        panel.title = "阿拉克涅 · 查看"; panel.contentView = child; panel.delegate = self
        panel.isReleasedWhenClosed = false; panel.center(); childWindows.append(panel); panel.makeKeyAndOrderFront(nil)
        return child
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        let name = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        panel.nameFieldStringValue = name.isEmpty || name == "." ? "阿拉克涅导出" : name
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { [weak self] result in
            guard let self = self else { completionHandler(nil); return }
            let key = ObjectIdentifier(download)
            guard result == .OK, let destination = panel.url else {
                self.downloads.remove(key); completionHandler(nil); return
            }
            do {
                let target = try NativeDownloadTarget(destination: destination)
                self.downloadTargets[key] = target
                completionHandler(target.temporary)
            } catch {
                self.downloads.remove(key)
                completionHandler(nil)
                self.alert("无法准备下载", error.localizedDescription)
            }
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        let key = ObjectIdentifier(download); downloads.remove(key)
        guard let target = downloadTargets.removeValue(forKey: key) else { return }
        do {
            try target.finish()
        } catch {
            alert("无法保存导出文件", "\(error.localizedDescription)\n\n下载内容保留在：\n\(target.temporary.path)")
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let key = ObjectIdentifier(download); downloads.remove(key)
        let target = downloadTargets.removeValue(forKey: key)
        let location = target.map { "\n未完成的文件：\($0.temporary.path)" } ?? ""
        alert("下载未完成", error.localizedDescription + location)
    }

    private func alert(_ title: String, _ detail: String) {
        let dialog = NSAlert(); dialog.messageText = title; dialog.informativeText = detail
        dialog.beginSheetModal(for: window)
    }
}
