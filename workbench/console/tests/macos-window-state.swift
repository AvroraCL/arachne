import AppKit

@main struct WindowStateVerification {
    static func main() throws {
        let primary = NSRect(x: 0, y: 32, width: 1440, height: 860)
        let second = NSRect(x: -1120, y: 0, width: 1120, height: 680)
        let saved = NSRect(x: -1090, y: 12, width: 960, height: 620)
        let visible = NativeWorkbench.visibleWindowFrame(saved, displays: [primary, second], primary: primary)
        precondition(visible == saved, "Keep a saved window on its original display")
        let restored = NativeWorkbench.visibleWindowFrame(saved, displays: [primary], primary: primary)
        precondition(primary.contains(restored) && restored.size == saved.size, "Move a disconnected-display window to the primary screen")
        let small = NSRect(x: 0, y: 0, width: 780, height: 530)
        let compact = NativeWorkbench.visibleWindowFrame(saved, displays: [small], primary: small)
        precondition(compact == small, "Fit a saved window on a display smaller than the default minimum")
        print("PASS macOS window restoration on existing, disconnected and smaller displays")
        let files = FileManager.default
        let directory = files.temporaryDirectory.appendingPathComponent("阿拉克涅 导出验收 " + UUID().uuidString)
        try files.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? files.removeItem(at: directory) }
        let destination = directory.appendingPathComponent("贴图 副本.zip")
        let first = try NativeDownloadTarget(destination: destination)
        try Data("first".utf8).write(to: first.temporary)
        try first.finish()
        let replacement = try NativeDownloadTarget(destination: destination)
        try Data("second".utf8).write(to: replacement.temporary)
        try replacement.finish()
        let replaced = try String(contentsOf: destination, encoding: .utf8)
        precondition(replaced == "second")
        let conflicting = try NativeDownloadTarget(destination: destination)
        try Data("pending".utf8).write(to: conflicting.temporary)
        try Data("external edit".utf8).write(to: destination)
        do {
            try conflicting.finish()
            preconditionFailure("Download must preserve an externally modified destination")
        } catch NativeDownloadTarget.TargetError.changed {}
        let preserved = try String(contentsOf: destination, encoding: .utf8)
        let pending = try String(contentsOf: conflicting.temporary, encoding: .utf8)
        precondition(preserved == "external edit" && pending == "pending")
        print("PASS macOS download paths with Unicode and spaces, replacement and recovery after an external edit")
    }
}
