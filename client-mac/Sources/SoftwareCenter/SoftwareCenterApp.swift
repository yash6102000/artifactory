import SwiftUI
import AppKit

/// `swift run` launches this as a bare process with no app bundle/Info.plist,
/// so macOS never gives it a Dock icon and never treats it as the frontmost
/// app the way a double-clicked .app would be. Without this, the window can
/// end up behind whatever else is on screen the moment focus shifts away —
/// the process is still running the whole time, it just looks like the app
/// silently closed, with no Dock icon to click to bring it back.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        for window in NSApp.windows {
            window.makeKeyAndOrderFront(nil)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

@main
struct SoftwareCenterApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
