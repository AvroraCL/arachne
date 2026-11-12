import AppKit

@main struct WindowStateVerification {
    static func main() {
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
    }
}
