import AppKit
import ImageIO
import UniformTypeIdentifiers
import WebKit

final class Probe: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
    let url: URL
    let timeout: Double
    let screenshot: String?
    var panel: NSPanel?
    var started = false
    let startedAt = ProcessInfo.processInfo.systemUptime
    var footprint: [[String: Any]] = []
    var maxFootprint: UInt64 = 0
    var samplingError: String?
    let captureDirectory: URL?
    let trace: Bool
    let renderMode: String
    var captureTimer: Timer?
    var capturePending = false
    var captureSamples: [[String: Any]] = []
    var captureRegions: [String: Any]?
    var captureError: String?
    var rendererSamples: [[String: Any]] = []
    var rendererSamplePending = false

    var elapsedMs: Double { (ProcessInfo.processInfo.systemUptime - startedAt) * 1000 }

    // Bench-only SPI. Some WebKit versions do not expose the main process PID.
    func webContentPID(_ view: WKWebView) -> pid_t? {
        let selector = NSSelectorFromString("_webProcessIdentifier")
        guard view.responds(to: selector), let method = view.method(for: selector) else { return nil }
        typealias GetPID = @convention(c) (AnyObject, Selector) -> pid_t
        return unsafeBitCast(method, to: GetPID.self)(view, selector)
    }

    func sampleFootprint(_ view: WKWebView) {
        guard let pid = webContentPID(view) else {
            samplingError = "WKWebView does not expose its WebContent PID"
            return
        }
        guard pid > 0 else { return }
        var info = rusage_info_v4()
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            proc_pid_rusage(pid, RUSAGE_INFO_V4, UnsafeMutableRawPointer(pointer)
                .assumingMemoryBound(to: rusage_info_t?.self))
        }
        guard result == 0 else {
            samplingError = "proc_pid_rusage failed: errno \(errno)"
            return
        }
        samplingError = nil
        maxFootprint = max(maxFootprint, info.ri_phys_footprint, info.ri_lifetime_max_phys_footprint)
        footprint.append([
            "atMs": elapsedMs, "pid": pid, "bytes": info.ri_phys_footprint,
            "lifetimePeakBytes": info.ri_lifetime_max_phys_footprint
        ])
    }

    init(url: URL, timeout: Double, screenshot: String?, captureDirectory: URL?, trace: Bool, renderMode: String) {
        self.url = url
        self.timeout = timeout
        self.screenshot = screenshot
        self.captureDirectory = captureDirectory
        self.trace = trace
        self.renderMode = renderMode
    }


    func sampleRenderer(_ view: WKWebView) {
        guard started, !rendererSamplePending else { return }
        rendererSamplePending = true
        let atMs = elapsedMs
        var layers = view.layer.map { [$0] } ?? []
        var layerCount = 0
        var maxLayerWidth: CGFloat = 0
        var maxLayerHeight: CGFloat = 0
        while let layer = layers.popLast() {
            layerCount += 1
            maxLayerWidth = max(maxLayerWidth, layer.bounds.width)
            maxLayerHeight = max(maxLayerHeight, layer.bounds.height)
            layers.append(contentsOf: layer.sublayers ?? [])
        }
        view.evaluateJavaScript("""
            (() => {
                const bench = window.perfBench;
                if (!bench) return null;
                const world = document.querySelector('.world');
                const frames = [...document.querySelectorAll('iframe[data-doop-frame]')];
                return {
                    phase: window.perfBenchPhase ?? null,
                    camera: bench.getCamera(),
                    live: bench.liveDocuments(),
                    layoutZoom: Number(world?.style.zoom || 1),
                    iframeCssPixels: frames.reduce((sum, frame) =>
                        sum + (parseFloat(frame.style.width) || 0) * (parseFloat(frame.style.height) || 0), 0),
                    readySnapshots: document.querySelectorAll('[data-frame-snapshot-ready]').length,
                    overview: !!document.querySelector('[data-frame-overview]'),
                    captures: window.perfBenchCaptures ?? null,
                    internalsLayerTreeAvailable: typeof window.internals?.layerTreeAsText === 'function'
                };
            })()
            """) { value, _ in
            self.rendererSamplePending = false
            guard var point = value as? [String: Any] else { return }
            point["hostLayers"] = ["count": layerCount, "maxWidth": maxLayerWidth, "maxHeight": maxLayerHeight]
            point["atMs"] = atMs
            point["receivedAtMs"] = self.elapsedMs
            self.rendererSamples.append(point)
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, let view = message.webView, captureDirectory != nil,
              let request = message.body as? [String: Any] else {
            replyHandler(nil, "Invalid frame capture request")
            return
        }
        if request["stop"] as? Bool == true {
            captureTimer?.invalidate()
            replyHandler(true, nil)
            return
        }
        guard captureRegions == nil, let regions = request["regions"] as? [String: Any] else {
            replyHandler(nil, "Expected one capture start with region bounds")
            return
        }
        captureRegions = regions
        capture(view) { success in
            guard success else {
                replyHandler(nil, self.captureError ?? "Baseline capture failed")
                return
            }
            self.captureTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
                self.capture(view) { _ in }
            }
            replyHandler(true, nil)
        }
    }

    func capture(_ view: WKWebView, completion: @escaping (Bool) -> Void) {
        guard !capturePending, let captureDirectory else { return }
        capturePending = true
        let index = captureSamples.count
        let file = String(format: "%04d.png", index)
        let target = captureDirectory.appendingPathComponent(file)
        let atMs = elapsedMs
        let configuration = WKSnapshotConfiguration()
        configuration.afterScreenUpdates = false
        view.takeSnapshot(with: configuration) { image, error in
            // Detach the image from WebKit before encoding it off the main thread.
            guard let cgImage = image?.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
                self.capturePending = false
                self.captureError = error?.localizedDescription ?? "Empty WKWebView snapshot"
                completion(false)
                return
            }
            let receivedAtMs = self.elapsedMs
            DispatchQueue.global(qos: .utility).async {
                let saved: Bool
                if let writer = CGImageDestinationCreateWithURL(target as CFURL, UTType.png.identifier as CFString, 1, nil) {
                    CGImageDestinationAddImage(writer, cgImage, nil)
                    saved = CGImageDestinationFinalize(writer)
                } else {
                    saved = false
                }
                DispatchQueue.main.async {
                    self.capturePending = false
                    if saved {
                        self.captureSamples.append(["file": file, "atMs": atMs, "receivedAtMs": receivedAtMs])
                    } else {
                        self.captureError = "Could not write snapshot \(file)"
                    }
                    completion(saved)
                }
            }
        }
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
        config.userContentController.addUserScript(WKUserScript(source: """
            window.perfBenchLoadErrors = [];
            addEventListener('error', event => {
                window.perfBenchLoadErrors.push(event.message || event.target?.src || 'Resource failed to load');
            }, true);
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        if captureDirectory != nil {
            config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "perfCapture")
        }
        let noAnimations = renderMode == "no-animations" || renderMode == "no-effects"
        let pauseAnimations = renderMode == "paused-animations"
        let noFilters = renderMode == "no-filters" || renderMode == "no-effects"
        if noAnimations || pauseAnimations || noFilters {
            let animations = noAnimations ? "animation: none !important;"
                : pauseAnimations ? "animation-play-state: paused !important;" : ""
            let filters = noFilters ? "filter: none !important; backdrop-filter: none !important;" : ""
            config.userContentController.addUserScript(WKUserScript(source: """
                if (self !== top) {
                    const style = document.createElement('style');
                    style.textContent = '*,*::before,*::after { \(animations) \(filters) }';
                    const install = () => {
                        if (!document.documentElement) return false;
                        const root = document.documentElement;
                        root.append(style);
                        new MutationObserver(() => {
                            if (!style.isConnected) root.append(style);
                        }).observe(root, { childList: true });
                        return true;
                    };
                    if (!install()) {
                        const observer = new MutationObserver(() => { if (install()) observer.disconnect(); });
                        observer.observe(document, { childList: true, subtree: true });
                    }
                }
                """, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        }
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
            guard URLComponents(url: self.url, resolvingAgainstBaseURL: false)?.queryItems?
                .contains(where: { $0.name == "scene" && $0.value == "real" }) == true else {
                self.finish(["benchError": "WKWebView probe timed out"])
            }
            view.evaluateJavaScript("""
                JSON.stringify({
                    phase: window.perfBenchPhase ?? document.readyState,
                    shells: document.querySelectorAll('[data-doop-frame-shell]').length,
                    live: window.perfBench?.liveDocuments(),
                    camera: window.perfBench?.getCamera()
                })
                """) { value, error in
                self.finish(["benchError": "WKWebView real scene timed out: \(value ?? error?.localizedDescription ?? "no renderer state")"])
            }
            Timer.scheduledTimer(withTimeInterval: 1, repeats: false) { _ in
                self.finish(["benchError": "WKWebView real scene timed out; renderer did not return state"])
            }
        }
        Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in
            self.sampleFootprint(view)
            if self.trace { self.sampleRenderer(view) }
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
            const deadline = performance.now() + 5_000;
            while (!window.perfBenchResult && performance.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            if (!window.perfBenchResult) {
                const errors = window.perfBenchLoadErrors?.join('; ');
                throw new Error('Performance fixture did not initialize at ' + location.href +
                    ' (' + document.readyState + '): ' + (errors || document.title || document.body?.textContent?.slice(0, 500)));
            }
            if (new URLSearchParams(location.search).get('scene') === 'real') {
                try {
                    return JSON.stringify(await window.perfBenchResult);
                } catch (error) {
                    return JSON.stringify({
                        benchError: (window.perfBenchPhase || 'starting fixture') + ': ' + String(error)
                    });
                }
            }
            return JSON.stringify(await window.perfBenchResult);
            """, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .failure(let error):
                // The pending JavaScript call can be rejected before the navigation delegate runs.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    self.finish(["benchError": String(describing: error)])
                }
            case .success(let value):
                guard let json = value as? String else { self.fail("Expected a JSON sample from WKWebView") }
                guard var sample = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] else {
                    self.fail("Expected a JSON object from WKWebView")
                }
                if sample["scenario"] as? String == "fly-over" {
                    sample["webContentRssKiB"] = self.webContentRssKiB(view)
                }
                if let screenshot = self.screenshot, sample["benchError"] == nil {
                    view.takeSnapshot(with: nil) { image, error in
                        guard let data = image?.tiffRepresentation,
                              let png = NSBitmapImageRep(data: data)?.representation(using: .png, properties: [:]) else {
                            self.fail("WKWebView screenshot failed: \(String(describing: error))")
                        }
                        do { try png.write(to: URL(fileURLWithPath: screenshot)) }
                        catch { self.fail("Cannot save WKWebView screenshot: \(error)") }
                        self.finish(sample)
                    }
                } else {
                    self.finish(sample)
                }
            }
        }
    }

    func webContentRssKiB(_ view: WKWebView) -> Int? {
        guard let pid = webContentPID(view), pid > 0 else { return nil }
        let ps = Process()
        let pipe = Pipe()
        ps.executableURL = URL(fileURLWithPath: "/bin/ps")
        ps.arguments = ["-o", "rss=", "-p", String(pid)]
        ps.standardOutput = pipe
        do {
            try ps.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            ps.waitUntilExit()
            guard ps.terminationStatus == 0 else { return nil }
            return Int(String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
        } catch {
            return nil
        }
    }

    func finish(_ result: [String: Any]) -> Never {
        if NSApp.isActive { fail("WKWebView probe activated") }
        captureTimer?.invalidate()
        var payload = result
        if let captureDirectory {
            var capture: [String: Any] = ["directory": captureDirectory.path, "points": captureSamples]
            if let captureRegions { capture["regions"] = captureRegions }
            if let captureError { capture["error"] = captureError }
            payload["capture"] = capture
        }
        var memory: [String: Any] = [
            "points": footprint,
            "maxFootprintBytes": footprint.isEmpty ? NSNull() as Any : maxFootprint
        ]
        if let samplingError { memory["samplingError"] = samplingError }
        if trace { memory["rendererPoints"] = rendererSamples }
        payload["webContent"] = memory
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else {
            fail("Cannot serialize WKWebView diagnostics")
        }
        print(String(decoding: data, as: UTF8.self))
        fflush(stdout)
        exit(0)
    }

    func webView(_ view: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            self.finish(["benchError": "WKWebView navigation failed: \(error)"])
        }
    }

    func webViewWebContentProcessDidTerminate(_ view: WKWebView) {
        finish(["webContentTermination": "Unknown"])
    }

    // Implement the private reason-bearing delegate selector in this diagnostic
    // tool only. WebKit prefers it over the public callback when available.
    @objc(_webView:webContentProcessDidTerminateWithReason:)
    func webContentTerminated(_ view: WKWebView, reason: Int) {
        let reasons = ["ExceededMemoryLimit", "ExceededCPULimit", "RequestedByClient", "Crash",
                       "ExceededSharedProcessCrashLimit"]
        finish(["webContentTermination": reasons.indices.contains(reason) ? reasons[reason] : "Unknown (\(reason))"])
    }
}

let args = CommandLine.arguments
guard args.count == 7, let url = URL(string: args[1]), url.scheme == "http", url.host == "127.0.0.1",
      let timeout = Double(args[2]) else {
    fputs("Usage: WKProbe URL TIMEOUT_SECONDS SCREENSHOT_OR_EMPTY CAPTURE_DIRECTORY_OR_EMPTY TRACE RENDER_MODE\n", stderr)
    exit(64)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let captureDirectory = args[4].isEmpty ? nil : URL(fileURLWithPath: args[4], isDirectory: true)
let probe = Probe(url: url, timeout: timeout, screenshot: args[3].isEmpty ? nil : args[3],
                  captureDirectory: captureDirectory, trace: args[5] == "1", renderMode: args[6])
app.delegate = probe
app.run()
