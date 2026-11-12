import AppKit
import Foundation
import WebKit

// The workbench continues to use the local project service. WebKit never gets
// a general-purpose native file or shell bridge.
final class NativeWorkbench: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    private struct DownloadTarget {
        let temporary: URL
        let destination: URL
        let existed: Bool
    }
    let window: NSWindow
    private let webView: WKWebView
    private let origin: URL
    private var childWindows: [NSWindow] = []
    private var downloads: Set<ObjectIdentifier> = []
    private var downloadTargets: [ObjectIdentifier: DownloadTarget] = [:]
    var onProject: ((String, String) -> Void)?

    init(url: URL) {
        origin = url
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        super.init()
        configuration.userContentController.add(self, name: "arachne")
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
        window.minSize = NSSize(width: 900, height: 600)
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = webView
        window.isReleasedWhenClosed = false
        if !window.setFrameUsingName("ArachneWorkbench") { window.center() }
        window.setFrameAutosaveName("ArachneWorkbench")
        webView.load(URLRequest(url: url))
    }

    func show() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
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
        guard body["type"] as? String == "project",
              let id = body["id"] as? String, id.range(of: "^[A-Za-z0-9_-]{1,100}$", options: .regularExpression) != nil,
              let name = body["name"] as? String, name.count <= 200 else { return }
        window.title = name.isEmpty ? "阿拉克涅" : "\(name) — 阿拉克涅"
        onProject?(id, name)
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
        let allowed = ["newProject", "openProject", "saveProjectCopy", "projectDetails", "importArchive", "migrateModel", "searchCommands", "workspaceLayouts", "createBackup", "downloadBackup", "export", "history", "renderSettings", "renderTasks", "settings", "save", "undo", "redo"]
        guard allowed.contains(command), sameOrigin(webView.url) else { NSSound.beep(); return }
        webView.evaluateJavaScript("window.arachneNativeHost?.command('\(command)') ?? false") { value, error in
            if error != nil || (value as? Bool) != true { NSSound.beep() }
        }
    }

    func prepareToQuit(_ completion: @escaping (String) -> Void) {
        if !downloads.isEmpty { completion("downloads"); return }
        guard sameOrigin(webView.url) else { completion("unavailable"); return }
        Task { @MainActor in
            do {
                let value = try await webView.callAsyncJavaScript(
                    "const host=window.arachneNativeHost; return host?.prepareToCloseAsync ? await host.prepareToCloseAsync() : host?.prepareToClose() ?? null",
                    arguments: [:], in: nil, contentWorld: .page)
                guard let status = value as? [String: Any], let state = status["state"] as? String,
                      ["ready", "saving", "editing", "error", "jobs"].contains(state) else {
                    completion("unavailable"); return
                }
                completion(state)
            } catch { completion("unavailable") }
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
            let temporary = destination.deletingLastPathComponent().appendingPathComponent(".arachne-\(UUID().uuidString).download")
            self.downloadTargets[key] = DownloadTarget(temporary: temporary, destination: destination,
                                                       existed: FileManager.default.fileExists(atPath: destination.path))
            completionHandler(temporary)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        let key = ObjectIdentifier(download); downloads.remove(key)
        guard let target = downloadTargets.removeValue(forKey: key) else { return }
        do {
            let files = FileManager.default
            if target.existed {
                guard files.fileExists(atPath: target.destination.path) else { throw CocoaError(.fileNoSuchFile) }
                _ = try files.replaceItemAt(target.destination, withItemAt: target.temporary)
            } else {
                // moveItem refuses to overwrite a file that appeared while downloading.
                try files.moveItem(at: target.temporary, to: target.destination)
            }
        } catch {
            alert("无法保存导出文件", "原文件未被主动删除。下载内容保留在：\n\(target.temporary.path)\n\n\(error.localizedDescription)")
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let key = ObjectIdentifier(download); downloads.remove(key)
        let target = downloadTargets.removeValue(forKey: key)
        let location = target.map { "\n未完成的文件：\($0.temporary.path)" } ?? ""
        alert("下载未完成", error.localizedDescription + location)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        alert("工作台内容进程已停止", "请重新打开阿拉克涅。已完成的工程修改保存在本机。")
    }

    private func alert(_ title: String, _ detail: String) {
        let dialog = NSAlert(); dialog.messageText = title; dialog.informativeText = detail
        dialog.beginSheetModal(for: window)
    }
}
