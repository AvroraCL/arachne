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

    @MainActor static func verify(url: URL, project: String, revision: Int, pendingDraft: Bool) async throws {
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
        var expected = revision
        var draftLayer: String?
        if pendingDraft {
            // Simulate a response lost just before the renderer crashes: one
            // stroke has reached disk, another remains in the window journal.
            let state = try await webView.callAsyncJavaScript("""
                const route='/api/projects/'+id+'/paint/commands';
                const send=async(revision,operations,strokeRequestId)=>{
                  const response=await fetch(route,{method:'POST',headers:{'Content-Type':'application/json'},
                    body:JSON.stringify({revision,operations,strokeRequestId})});
                  if(!response.ok)throw Error((await response.json()).error);
                  return response.json();
                };
                const start=await send(revision,[{op:'add',kind:'fill',patch:{name:'进程恢复验收',maskEnabled:true,maskBase:1}}]);
                const layer=start.paint.layers.find(layer=>layer.name==='进程恢复验收').id;
                const entries=[[.2,.2,.3,.3],[.6,.6,.7,.7]].map((rect,i)=>({
                  requestId:crypto.randomUUID(),attempted:i===0,
                  operation:{op:'stroke',id:layer,target:'mask',stroke:{uv:true,rect,value:0,opacity:1}}
                }));
                sessionStorage.setItem('arachne-material-stroke-draft:'+id,JSON.stringify({
                  target:[id,'surface',layer,'mask'],expected:start.revision,pending:entries
                }));
                const stored=await send(start.revision,[entries[0].operation],entries[0].requestId);
                return {revision:stored.revision,layer};
                """, arguments: ["id": project, "revision": revision], in: nil, contentWorld: .page) as? [String: Any]
            guard let stored = state?["revision"] as? Int, let layer = state?["layer"] as? String else {
                throw CocoaError(.featureUnsupported)
            }
            expected = stored; draftLayer = layer
        }
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
            return await currentRevision() == expected
        }
        precondition(workbench.window.contentView === webView)
        print("PASS macOS real WebKit renderer crash, native recovery sheet, quit response and saved project reload")
        if let draftLayer = draftLayer {
            try await waitFor("Recover the unsaved material stroke journal after the renderer restarts") {
                (try? await webView.callAsyncJavaScript(
                    "return !!document.querySelector('.material-stroke-recovery:not([hidden])')",
                    arguments: [:], in: nil, contentWorld: .page)) as? Bool == true
            }
            let guarded = await withCheckedContinuation { continuation in
                workbench.prepareToQuit { continuation.resume(returning: $0) }
            }
            precondition(guarded == "unsaved")
            _ = try await webView.callAsyncJavaScript("""
                document.querySelector('.material-stroke-recovery button').click();
                """, arguments: [:], in: nil, contentWorld: .page)
            try await waitFor("Write only the uncommitted stroke after restarting") {
                guard await currentRevision() == expected + 1 else { return false }
                let count = try? await webView.callAsyncJavaScript("""
                    const response=await fetch('/api/projects/'+id);
                    const layer=(await response.json()).paint.layers.find(layer=>layer.id===layerId);
                    return layer.maskStrokes.length;
                    """, arguments: ["id": project, "layerId": draftLayer], in: nil, contentWorld: .page)
                return count as? Int == 2
            }
            print("PASS macOS restores the pending material stroke after WebKit crashes and avoids a duplicate saved stroke")
        }
        workbench.window.orderOut(nil)
    }

    @MainActor static func main() {
        let args = CommandLine.arguments
        guard (4...5).contains(args.count), let url = URL(string: args[1]), url.host == "127.0.0.1", let revision = Int(args[3]) else {
            fputs("Usage: macos-workbench-recovery URL PROJECT REVISION [--draft]\n", stderr)
            exit(2)
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        Task { @MainActor in
            do { try await verify(url: url, project: args[2], revision: revision, pendingDraft: args.last == "--draft"); exit(0) }
            catch { fputs("\(error.localizedDescription)\n", stderr); exit(1) }
        }
        app.run()
    }
}
