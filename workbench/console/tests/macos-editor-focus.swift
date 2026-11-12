import AppKit
import Darwin
import WebKit

@main struct EditorFocusVerification {
    @MainActor static func waitFor(_ description: String, seconds: Double = 30,
                                   _ ready: () async throws -> Bool) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if try await ready() { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw NSError(domain: "Mac editor focus verification", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: description])
    }

    @MainActor static func run(url: URL) async throws {
        let workbench = NativeWorkbench(url: url, autosaveName: nil, dataStore: .nonPersistent())
        guard let view = workbench.window.contentView as? WKWebView else { throw CocoaError(.featureUnsupported) }
        workbench.show()
        defer { workbench.window.orderOut(nil) }
        func js(_ code: String) async throws -> Any? {
            try await view.callAsyncJavaScript(code, arguments: [:], in: nil, contentWorld: .page)
        }
        func project() async throws -> [String: Any]? {
            try await js("""
                const id = new URL(location.href).searchParams.get('project');
                const response = await fetch('/api/projects/' + id);
                return response.ok ? await response.json() : null;
                """) as? [String: Any]
        }
        func nodes() async throws -> Int {
            let paint = try await project()?["paint"] as? [String: Any]
            let graph = paint?["materialGraph"] as? [String: Any]
            return (graph?["nodes"] as? [[String: Any]])?.count ?? 0
        }
        try await waitFor("Activate the native WebKit workbench", seconds: 60) {
            guard workbench.window.isKeyWindow else { return false }
            return (try? await js("return !!window.arachneNativeHost && !!document.querySelector('.editor-viewport[data-state=ready]')")) as? Bool == true
        }
        _ = try await js("""
            document.querySelector('[data-area-mode=modeling]').click();
            """)
        try await waitFor("Enable the material node editor") {
            try await js("""
                const button = Array.from(document.querySelectorAll('[data-editor=shader] button')).find(button => button.textContent.trim()==='启用节点材质');
                if (!button) return !!document.querySelector('.shader-node');
                button.click(); return true;
                """) as? Bool == true
        }
        try await waitFor("Persist default material nodes") { try await nodes() > 1 }
        let baseline = try await nodes()
        try await waitFor("Focus the loaded node canvas") {
            try await js("""
                const stage=document.querySelector('[data-editor=shader] .shader-stage');
                if (!stage || stage.hidden || !stage.querySelector('.shader-node')) return false;
                stage.focus();
                return document.activeElement === stage;
                """) as? Bool == true
        }
        workbench.perform("selectAll")
        try await waitFor("Select all nodes through native command") {
            try await js("return document.querySelectorAll('.shader-node.selected').length") as? Int == baseline
        }
        let pasteboard = NSPasteboard.general
        let initialChangeCount = pasteboard.changeCount
        let previous = (pasteboard.pasteboardItems ?? []).map { item in
            item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }
        }
        let tag = "arachne-material-nodes/v1\n"
        let text = "阿拉克涅中文系统菜单验收"
        var copiedNodes: String?
        var testPNG: Data?
        // Don't overwrite unrelated clipboard activity while this window is open.
        defer {
            let current = pasteboard.string(forType: .string)
            if current == text || (copiedNodes != nil && current == copiedNodes)
                || (testPNG != nil && pasteboard.data(forType: .png) == testPNG) {
                pasteboard.clearContents()
                let items = previous.compactMap { entries -> NSPasteboardItem? in
                    guard !entries.isEmpty else { return nil }
                    let item = NSPasteboardItem()
                    for (type, value) in entries { item.setData(value, forType: type) }
                    return item
                }
                if !items.isEmpty { pasteboard.writeObjects(items) }
            }
        }
        workbench.perform("copy")
        try await waitFor("Copy nodes to the system clipboard") {
            pasteboard.changeCount != initialChangeCount && pasteboard.string(forType: .string)?.hasPrefix(tag) == true
        }
        copiedNodes = pasteboard.string(forType: .string)
        workbench.perform("paste")
        try await waitFor("Paste nodes only into the active editor") { try await nodes() == 2 * baseline - 1 }
        workbench.perform("undo")
        try await waitFor("Undo the complete node paste in one step") { try await nodes() == baseline }
        _ = try await js("""
            const input = document.createElement('input'); input.id='native-focus-probe';
            input.style.cssText = 'position:fixed;z-index:2147483647;left:20px;top:75px;width:240px';
            input.value='阿拉克涅中文系统菜单验收';
            document.body.append(input); input.focus(); input.select();
            """)
        workbench.perform("cut")
        try await waitFor("Cut the focused Chinese text using AppKit") {
            guard pasteboard.string(forType: .string) == text else { return false }
            return try await js("return document.getElementById('native-focus-probe').value") as? String == ""
        }
        workbench.perform("paste")
        try await waitFor("Paste back to the same text input without changing the project") {
            guard try await nodes() == baseline else { return false }
            return try await js("return document.getElementById('native-focus-probe').value") as? String == text
        }
        _ = try await js("document.getElementById('native-focus-probe').remove()")
        print("PASS native WebKit node select/copy/paste/undo and focused Chinese text cut/paste")
        _ = try await js("document.querySelector('[data-area-mode=drawing]').click()")
        try await waitFor("Create a drawing from the Mac workbench") {
            try await js("""
                const button=Array.from(document.querySelectorAll('[data-editor=image] button')).find(button=>button.textContent.trim()==='新建贴图');
                if (!button || button.disabled) return false;
                button.click(); return true;
                """) as? Bool == true
        }
        try await waitFor("Focus the drawing canvas") {
            try await js("""
                const canvas=document.querySelector('[data-editor=image] canvas[aria-label="图像文档画布"]');
                if (!canvas || canvas.hidden) return false;
                canvas.focus(); return document.activeElement===canvas;
                """) as? Bool == true
        }
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 16, pixelsHigh: 12,
                                            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else {
            throw CocoaError(.featureUnsupported)
        }
        guard let pixels = bitmap.bitmapData else { throw CocoaError(.featureUnsupported) }
        for y in 0..<12 { for x in 0..<16 {
            let start = y * bitmap.bytesPerRow + x * 4
            pixels[start] = 64; pixels[start+1] = 128; pixels[start+2] = 192; pixels[start+3] = 255
        }}
        guard let png = bitmap.representation(using: .png, properties: [:]) else { throw CocoaError(.fileWriteUnknown) }
        testPNG = png
        pasteboard.clearContents(); pasteboard.setData(png, forType: .png)
        workbench.perform("paste")
        try await waitFor("Paste pixels into the active canvas, preserving their original size") {
            try await js("""
                const id = new URL(location.href).searchParams.get('project');
                const response = await fetch('/api/projects/' + id);
                if (!response.ok) return false;
                const paint=(await response.json()).paint;
                const layer=Object.values(paint.imageDocuments||{}).flatMap(doc=>doc.layers).find(layer=>layer.kind==='image');
                const asset=layer&&paint.assets[layer.asset];
                return asset?.width===16 && asset?.height===12;
                """) as? Bool == true
        }
        try await waitFor("Finish updating the drawing clipboard controls") {
            try await js("""
                const editor=document.querySelector('[data-editor=image]');
                const copy=editor.querySelector('button[aria-label="复制图像选区"]');
                const canvas=editor.querySelector('canvas[aria-label="图像文档画布"]');
                if (document.getElementById('project-save-state').textContent!=='已保存' || !copy || copy.disabled) return false;
                canvas.focus(); return document.activeElement===canvas;
                """) as? Bool == true
        }
        let beforeCopy = pasteboard.changeCount
        workbench.perform("copy")
        do {
            try await waitFor("Copy the drawing through the native image clipboard") {
                guard pasteboard.changeCount != beforeCopy, let data = pasteboard.data(forType: .png),
                      let bitmap = NSBitmapImageRep(data: data), bitmap.pixelsWide == 4096, bitmap.pixelsHigh == 4096 else { return false }
                testPNG = data; return true
            }
        } catch {
            let diagnosis = try? await js("""
                return JSON.stringify({active:document.activeElement?.ariaLabel,
                  status:document.querySelector('[data-editor=image] .editor-message')?.textContent,
                  notice:document.getElementById('status')?.textContent,
                  copy:document.querySelector('[aria-label="复制图像选区"]')?.disabled});
                """)
            fputs("Image copy diagnosis: \(diagnosis ?? "unavailable"), clipboard changed: \(pasteboard.changeCount != beforeCopy)\n", stderr)
            throw error
        }
        let closing = await withCheckedContinuation { continuation in
            workbench.prepareToQuit { continuation.resume(returning: $0) }
        }
        precondition(closing == "ready", "Saved changes should leave the native window ready to quit")
        print("PASS native WebKit image paste/copy, saved document and quit check")
    }

    @MainActor static func main() {
        let args = CommandLine.arguments
        guard args.count == 2, let url = URL(string: args[1]), url.host == "127.0.0.1" else {
            fputs("Usage: macos-editor-focus URL\n", stderr); exit(2)
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        Task { @MainActor in
            do { try await run(url: url); exit(0) }
            catch { fputs("\(error.localizedDescription)\n", stderr); exit(1) }
        }
        app.run()
    }
}
