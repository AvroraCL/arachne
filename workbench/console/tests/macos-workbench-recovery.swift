import AppKit
import Darwin
import WebKit

@main struct WorkbenchRecoveryVerification {
    @MainActor static func waitFor(_ description: String, timeout: TimeInterval = 25,
                                   condition: () async -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await condition() { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw NSError(domain: "Mac workbench verification", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: description])
    }

    static func button(in view: NSView?, titled title: String) -> NSButton? {
        guard let view else { return nil }
        if let candidate = view as? NSButton, candidate.title == title { return candidate }
        return view.subviews.lazy.compactMap { button(in: $0, titled: title) }.first
    }

    static func webContentPID(_ view: WKWebView) -> pid_t? {
        // This selector is used only by the test executable to identify and
        // stop its own content process. The shipping app uses WKNavigationDelegate.
        let selector = NSSelectorFromString("_webProcessIdentifier")
        guard view.responds(to: selector), let implementation = view.method(for: selector) else { return nil }
        let call = unsafeBitCast(implementation, to: (@convention(c) (AnyObject, Selector) -> pid_t).self)
        let pid = call(view, selector)
        return pid > 1 ? pid : nil
    }

    @MainActor static func verify(url: URL, project: String, revision: Int) async throws {
        let workbench = NativeWorkbench(url: url, autosaveName: nil, dataStore: .nonPersistent())
        guard let webView = workbench.window.contentView as? WKWebView else { throw CocoaError(.featureUnsupported) }
        workbench.show()
        func currentRevision() async -> Int? {
            let value = try? await webView.callAsyncJavaScript("""
                if (!window.arachneNativeHost || new URL(location.href).searchParams.get('project') !== id) return null;
                const response = await fetch('/api/projects/' + id);
                return (await response.json()).revision;
                """, arguments: ["id": project], in: nil, contentWorld: .page)
            return value as? Int
        }
        try await waitFor("Open the saved project in WebKit", timeout: 40) { await currentRevision() == revision }
        guard let pid = webContentPID(webView), kill(pid, SIGKILL) == 0 else { throw CocoaError(.featureUnsupported) }
        try await waitFor("Show the native renderer recovery sheet") {
            button(in: workbench.window.attachedSheet?.contentView, titled: "重新载入") != nil
        }
        let state = await withCheckedContinuation { continuation in
            workbench.prepareToQuit { continuation.resume(returning: $0) }
        }
        precondition(state == "unavailable", "Quit must handle a stopped renderer without hanging")
        button(in: workbench.window.attachedSheet?.contentView, titled: "重新载入")?.performClick(nil)
        try await waitFor("Recover the saved project in the same native window", timeout: 45) {
            guard let fresh = webContentPID(webView), fresh != pid, workbench.window.attachedSheet == nil else { return false }
            return await currentRevision() == revision
        }
        precondition(workbench.window.contentView === webView)
        print("PASS macOS real WebKit renderer crash, native recovery sheet, quit response and saved project reload")
        workbench.window.orderOut(nil)
    }

    @MainActor static func main() {
        let args = CommandLine.arguments
        guard args.count == 4, let url = URL(string: args[1]), url.host == "127.0.0.1", let revision = Int(args[3]) else {
            fputs("Usage: macos-workbench-recovery URL PROJECT REVISION\n", stderr)
            exit(2)
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        Task { @MainActor in
            do { try await verify(url: url, project: args[2], revision: revision); exit(0) }
            catch { fputs("\(error.localizedDescription)\n", stderr); exit(1) }
        }
        app.run()
    }
}
