import AppKit
import WebKit

final class Probe: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    let url: URL
    let timeout: Double
    let screenshot: String?
    var panel: NSPanel?
    var started = false

    init(url: URL, timeout: Double, screenshot: String?) {
        self.url = url
        self.timeout = timeout
        self.screenshot = screenshot
    }

    func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data((message + "\n").utf8))
        exit(1)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let screen = NSScreen.main else { fail("No display for the WKWebView panel") }
        let rect = NSRect(x: screen.visibleFrame.minX + 10, y: screen.visibleFrame.minY + 10, width: 1280, height: 800)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        if #available(macOS 14.0, *) {
            config.preferences.inactiveSchedulingPolicy = .none
        }
        let view = WKWebView(frame: NSRect(origin: .zero, size: rect.size), configuration: config)
        view.navigationDelegate = self
        let panel = NSPanel(contentRect: rect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false, screen: screen)
        panel.contentView = view
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.ignoresMouseEvents = true
        self.panel = panel
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(activated(_:)),
            name: NSWorkspace.didActivateApplicationNotification, object: nil)
        panel.orderBack(nil)
        Timer.scheduledTimer(withTimeInterval: timeout, repeats: false) { _ in
            self.fail("WKWebView probe timed out")
        }
        view.load(URLRequest(url: url))
    }

    @objc func activated(_ notification: Notification) {
        let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
        if app?.processIdentifier == ProcessInfo.processInfo.processIdentifier {
            fail("WKWebView probe activated")
        }
    }

    func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
        guard !started else { return }
        started = true
        view.callAsyncJavaScript("""
            if (!window.perfBenchResult) throw new Error('Performance fixture did not initialize');
            return JSON.stringify(await window.perfBenchResult);
            """, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .failure(let error):
                self.fail(String(describing: error))
            case .success(let value):
                guard let json = value as? String else { self.fail("Expected a JSON sample from WKWebView") }
                if let screenshot = self.screenshot {
                    view.takeSnapshot(with: nil) { image, error in
                        guard let data = image?.tiffRepresentation,
                              let png = NSBitmapImageRep(data: data)?.representation(using: .png, properties: [:]) else {
                            self.fail("WKWebView screenshot failed: \(String(describing: error))")
                        }
                        do { try png.write(to: URL(fileURLWithPath: screenshot)) }
                        catch { self.fail("Cannot save WKWebView screenshot: \(error)") }
                        self.finish(json)
                    }
                } else {
                    self.finish(json)
                }
            }
        }
    }

    func finish(_ json: String) {
        if NSApp.isActive { fail("WKWebView probe activated") }
        print(json)
        fflush(stdout)
        exit(0)
    }

    func webView(_ view: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail("WKWebView navigation failed: \(error)")
    }

    func webViewWebContentProcessDidTerminate(_ view: WKWebView) {
        fail("WKWebView WebContent process terminated")
    }
}

let args = CommandLine.arguments
guard args.count == 4, let url = URL(string: args[1]), url.scheme == "http", url.host == "127.0.0.1",
      let timeout = Double(args[2]) else {
    fputs("Usage: WKProbe URL TIMEOUT_SECONDS SCREENSHOT_OR_EMPTY\n", stderr)
    exit(64)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let probe = Probe(url: url, timeout: timeout, screenshot: args[3].isEmpty ? nil : args[3])
app.delegate = probe
app.run()
