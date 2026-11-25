import AppKit
import ApplicationServices
import CoreGraphics
import CoreImage
import CoreMedia
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

// The cloud relay has no visitor login. Only this producer key stays on the Mac.
// Input is deliberately limited to desktop events; there is no command or file API.
struct Configuration: Decodable {
    let relayUrl: String
    let producerKey: String
    let transport: String?

    init(relayUrl: String, producerKey: String, transport: String? = nil) {
        self.relayUrl = relayUrl
        self.producerKey = producerKey
        self.transport = transport
    }

    var usesHTTP: Bool { transport == "http" }

    func baseURL() throws -> URL {
        guard var url = URLComponents(string: relayUrl),
              let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              ["https", "wss"].contains(url.scheme?.lowercased() ?? ""),
              !usesHTTP || url.scheme?.lowercased() == "https",
              transport == nil || ["http", "websocket"].contains(transport!),
              producerKey.count >= 32, producerKey.count <= 249,
              !producerKey.contains("\r"), !producerKey.contains("\n") else {
            throw PortalError.message("Configuration needs a secure relay URL and a valid producer key.")
        }
        url.scheme = "https"
        url.path = ""
        guard let result = url.url else { throw PortalError.message("Invalid relay URL.") }
        return result
    }

    func socketURL() throws -> URL {
        let base = try baseURL()
        guard var url = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            throw PortalError.message("Invalid relay URL.")
        }
        url.scheme = "wss"
        url.path = "/agent"
        guard let result = url.url else { throw PortalError.message("Invalid relay URL.") }
        return result
    }
}

final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

final class HTTPRelay {
    let configuration: Configuration
    private let base: URL
    private let session: URLSession
    private let redirects = NoRedirects()

    init(configuration: Configuration, testingSession: URLSessionConfiguration? = nil) throws {
        self.configuration = configuration
        base = try configuration.baseURL()
        let settings = testingSession ?? URLSessionConfiguration.ephemeral
        settings.httpShouldSetCookies = false
        settings.urlCache = nil
        settings.requestCachePolicy = .reloadIgnoringLocalCacheData
        settings.timeoutIntervalForRequest = 12
        settings.timeoutIntervalForResource = 20
        session = URLSession(configuration: settings, delegate: redirects, delegateQueue: nil)
    }

    func invalidate() { session.invalidateAndCancel() }

    func request(_ path: String, method: String = "GET", query: [String: String] = [:],
                 json: [String: Any]? = nil, body: Data? = nil,
                 contentType: String = "application/json") async throws -> [String: Any] {
        guard path.hasPrefix("/agent/") else { throw PortalError.message("Invalid agent route.") }
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        components.path = path
        if !query.isEmpty {
            components.queryItems = query.sorted(by: { $0.key < $1.key }).map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.setValue("Bearer " + configuration.producerKey, forHTTPHeaderField: "Authorization")
        request.setValue("SchafferDesktop/1.1", forHTTPHeaderField: "User-Agent")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let json {
            request.httpBody = try JSONSerialization.data(withJSONObject: json)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        } else if let body {
            request.httpBody = body
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        let (bytes, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, (200...299).contains(response.statusCode),
              bytes.count <= 65_536 else { throw PortalError.message("Desktop relay request failed.") }
        if bytes.isEmpty { return [:] }
        guard let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
            throw PortalError.message("Desktop relay response was invalid.")
        }
        return value
    }
}

enum PortalError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let value) = self { return value }; return nil }
}

func sessionLocked() -> Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return true }
    if session["CGSSessionScreenIsLocked"] as? Bool == true { return true }
    if let console = session[kCGSessionOnConsoleKey as String] as? Bool, !console { return true }
    return false
}

func permissionSnapshot() -> [String: Any] {
    ["screenRecording": CGPreflightScreenCaptureAccess(),
     "accessibility": AXIsProcessTrusted(), "locked": sessionLocked()]
}

let keyCodes: [String: CGKeyCode] = [
    "KeyA": 0, "KeyS": 1, "KeyD": 2, "KeyF": 3, "KeyH": 4, "KeyG": 5,
    "KeyZ": 6, "KeyX": 7, "KeyC": 8, "KeyV": 9, "IntlBackslash": 10, "KeyB": 11,
    "KeyQ": 12, "KeyW": 13, "KeyE": 14, "KeyR": 15, "KeyY": 16, "KeyT": 17,
    "Digit1": 18, "Digit2": 19, "Digit3": 20, "Digit4": 21, "Digit6": 22,
    "Digit5": 23, "Equal": 24, "Digit9": 25, "Digit7": 26, "Minus": 27,
    "Digit8": 28, "Digit0": 29, "BracketRight": 30, "KeyO": 31, "KeyU": 32,
    "BracketLeft": 33, "KeyI": 34, "KeyP": 35, "Enter": 36, "KeyL": 37,
    "KeyJ": 38, "Quote": 39, "KeyK": 40, "Semicolon": 41, "Backslash": 42,
    "Comma": 43, "Slash": 44, "KeyN": 45, "KeyM": 46, "Period": 47,
    "Tab": 48, "Space": 49, "Backquote": 50, "Backspace": 51, "Escape": 53,
    "MetaRight": 54, "MetaLeft": 55, "ShiftLeft": 56, "CapsLock": 57,
    "AltLeft": 58, "ControlLeft": 59, "ShiftRight": 60, "AltRight": 61,
    "ControlRight": 62, "NumpadDecimal": 65, "NumpadMultiply": 67,
    "NumpadAdd": 69, "NumLock": 71, "NumpadDivide": 75, "NumpadEnter": 76,
    "NumpadSubtract": 78, "NumpadEqual": 81, "Numpad0": 82, "Numpad1": 83,
    "Numpad2": 84, "Numpad3": 85, "Numpad4": 86, "Numpad5": 87,
    "Numpad6": 88, "Numpad7": 89, "Numpad8": 91, "Numpad9": 92,
    "F5": 96, "F6": 97, "F7": 98, "F3": 99, "F8": 100, "F9": 101,
    "F11": 103, "F13": 105, "F16": 106, "F14": 107, "F10": 109,
    "F12": 111, "F15": 113, "Insert": 114, "Home": 115, "PageUp": 116,
    "Delete": 117, "F4": 118, "End": 119, "F2": 120, "PageDown": 121,
    "F1": 122, "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126
]

let permittedModifiers: Set<String> = ["Shift", "Control", "Alt", "Meta"]

func finiteNumber(_ object: Any?) -> Double? {
    guard let number = object as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let value = number.doubleValue
    return value.isFinite ? value : nil
}

func validatedEvent(_ raw: [String: Any]) -> [String: Any]? {
    guard let type = raw["type"] as? String else { return nil }
    if let modifiers = raw["modifiers"] {
        guard let list = modifiers as? [String], list.count <= 4,
              Set(list).isSubset(of: permittedModifiers) else { return nil }
    }
    switch type {
    case "release": return raw
    case "pointer":
        guard let action = raw["action"] as? String, ["move", "down", "up"].contains(action),
              let x = finiteNumber(raw["x"]), let y = finiteNumber(raw["y"]),
              (0...1).contains(x), (0...1).contains(y) else { return nil }
        if let button = raw["button"] {
            guard let value = finiteNumber(button), value.rounded() == value, (0...2).contains(value) else { return nil }
        }
        return raw
    case "scroll":
        guard let x = finiteNumber(raw["deltaX"]), let y = finiteNumber(raw["deltaY"]),
              abs(x) <= 2000, abs(y) <= 2000 else { return nil }
        return raw
    case "key":
        guard let action = raw["action"] as? String, ["down", "up"].contains(action),
              let code = raw["code"] as? String, keyCodes[code] != nil else { return nil }
        return raw
    case "text":
        guard let text = raw["text"] as? String, !text.isEmpty,
              text.utf16.count <= 2000, !text.contains("\0") else { return nil }
        return raw
    default: return nil
    }
}

final class DesktopInput {
    private var keys = Set<CGKeyCode>()
    private var buttons = Set<Int>()
    private var lastPoint = CGPoint.zero
    private var clickCounts: [Int: Int64] = [:]
    private var lastClick: (time: TimeInterval, point: CGPoint, button: Int)?
    var displayBounds = CGDisplayBounds(CGMainDisplayID())

    private func flags(_ event: [String: Any]) -> CGEventFlags {
        var result = CGEventFlags()
        for name in event["modifiers"] as? [String] ?? [] {
            switch name {
            case "Shift": result.insert(.maskShift)
            case "Control": result.insert(.maskControl)
            case "Alt": result.insert(.maskAlternate)
            case "Meta": result.insert(.maskCommand)
            default: break
            }
        }
        // Pointer/scroll messages omit modifiers; retain remote Shift-click and
        // Control-click behavior using keys this app is currently holding.
        if !keys.isDisjoint(with: [56, 60]) { result.insert(.maskShift) }
        if !keys.isDisjoint(with: [59, 62]) { result.insert(.maskControl) }
        if !keys.isDisjoint(with: [58, 61]) { result.insert(.maskAlternate) }
        if !keys.isDisjoint(with: [54, 55]) { result.insert(.maskCommand) }
        return result
    }

    private func mouseButton(_ button: Int) -> CGMouseButton {
        button == 0 ? .left : button == 2 ? .right : .center
    }

    private func mouseType(_ button: Int, down: Bool) -> CGEventType {
        button == 0 ? (down ? .leftMouseDown : .leftMouseUp) :
        button == 2 ? (down ? .rightMouseDown : .rightMouseUp) :
        (down ? .otherMouseDown : .otherMouseUp)
    }

    func releaseAll() {
        // Release only events this app pressed; never synthesize local keystrokes.
        for code in keys {
            let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
            event?.flags = []
            event?.post(tap: .cghidEventTap)
        }
        keys.removeAll()
        for button in buttons {
            CGEvent(mouseEventSource: nil, mouseType: mouseType(button, down: false),
                    mouseCursorPosition: lastPoint, mouseButton: mouseButton(button))?.post(tap: .cghidEventTap)
        }
        buttons.removeAll()
    }

    func apply(_ event: [String: Any]) {
        guard let type = event["type"] as? String else { return }
        if type == "release" { releaseAll(); return }
        guard AXIsProcessTrusted(), !sessionLocked() else { releaseAll(); return }
        switch type {
        case "pointer":
            let x = finiteNumber(event["x"])!, y = finiteNumber(event["y"])!
            // CGEvent uses global display points; frame dimensions can be Retina pixels.
            lastPoint = CGPoint(x: displayBounds.minX + x * max(0, displayBounds.width - 1),
                                y: displayBounds.minY + y * max(0, displayBounds.height - 1))
            let action = event["action"] as! String
            var button = (event["button"] as? NSNumber)?.intValue ?? 0
            let eventType: CGEventType
            if action == "move" {
                if buttons.contains(0) { eventType = .leftMouseDragged; button = 0 }
                else if buttons.contains(2) { eventType = .rightMouseDragged; button = 2 }
                else if buttons.contains(1) { eventType = .otherMouseDragged; button = 1 }
                else { eventType = .mouseMoved }
            } else {
                let down = action == "down"
                eventType = mouseType(button, down: down)
                if down {
                    let now = Date.timeIntervalSinceReferenceDate
                    if let last = lastClick, last.button == button, now - last.time <= 0.45,
                       hypot(lastPoint.x - last.point.x, lastPoint.y - last.point.y) <= 5 {
                        clickCounts[button] = (clickCounts[button] ?? 1) == 1 ? 2 : 1
                    } else { clickCounts[button] = 1 }
                    lastClick = (now, lastPoint, button)
                    buttons.insert(button)
                } else { buttons.remove(button) }
            }
            let output = CGEvent(mouseEventSource: nil, mouseType: eventType,
                                 mouseCursorPosition: lastPoint, mouseButton: mouseButton(button))
            output?.flags = flags(event)
            if action != "move" { output?.setIntegerValueField(.mouseEventClickState, value: clickCounts[button] ?? 1) }
            output?.post(tap: .cghidEventTap)
        case "scroll":
            let x = max(-500, min(500, finiteNumber(event["deltaX"])!))
            let y = max(-500, min(500, finiteNumber(event["deltaY"])!))
            let output = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                                 wheel1: Int32(-y), wheel2: Int32(-x), wheel3: 0)
            output?.flags = flags(event)
            output?.post(tap: .cghidEventTap)
        case "key":
            let code = keyCodes[event["code"] as! String]!
            let down = event["action"] as? String == "down"
            let repeated = down && keys.contains(code)
            if down { keys.insert(code) } else { keys.remove(code) }
            let output = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
            output?.flags = flags(event)
            if repeated { output?.setIntegerValueField(.keyboardEventAutorepeat, value: 1) }
            output?.post(tap: .cghidEventTap)
        case "text":
            let units = Array((event["text"] as! String).utf16)
            // Small chunks avoid OS event payload limits and preserve surrogate pairs.
            var offset = 0
            while offset < units.count {
                var end = min(offset + 20, units.count)
                if end < units.count, (0xD800...0xDBFF).contains(units[end - 1]) { end -= 1 }
                let chunk = Array(units[offset..<end])
                for down in [true, false] {
                    let output = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
                    output?.flags = []
                    chunk.withUnsafeBufferPointer {
                        output?.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress!)
                    }
                    output?.post(tap: .cghidEventTap)
                }
                offset = end
            }
        default: break
        }
    }
}

// All access is serialized on ScreenCapture.queue. An unchanged display is
// healthy; blank/suspended/stopped output must never refresh a cached image.
struct FrameFreshnessPolicy {
    private(set) var running = false
    private(set) var status: SCFrameStatus?
    private(set) var generation = 0
    private(set) var lastOutput = -Double.infinity

    var liveStatus: Bool {
        guard let status else { return false }
        return status == .started || status == .complete || status == .idle
    }

    mutating func begin(now: Double) {
        running = true
        status = .started
        generation += 1
        lastOutput = now
    }

    @discardableResult mutating func observe(_ next: SCFrameStatus?) -> Bool {
        guard running else { return false }
        status = next
        if !liveStatus { generation += 1; return true }
        return false
    }

    mutating func stop() {
        running = false
        status = .stopped
        generation += 1
        lastOutput = -Double.infinity
    }

    mutating func recordOutput(now: Double) { lastOutput = now }
    func needsSnapshot(now: Double) -> Bool { running && liveStatus && now - lastOutput >= 0.75 }
    func acceptsSnapshot(generation expected: Int, permitted: Bool, unlocked: Bool) -> Bool {
        running && liveStatus && generation == expected && permitted && unlocked
    }
}

final class ScreenCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private let queue = DispatchQueue(label: "com.schafferai.desktop.frames", qos: .userInitiated)
    private let context = CIContext(options: [.cacheIntermediates: false])
    private var freshness = FrameFreshnessPolicy()
    private var snapshotTimer: DispatchSourceTimer?
    private var snapshotPending = false
    private var snapshotFilter: SCContentFilter?
    private var snapshotConfiguration: SCStreamConfiguration?
    private var lifecycleGeneration = 0
    var onFrame: ((Data) -> Void)?
    var onError: ((String) -> Void)?
    private(set) var bounds = CGRect.zero
    private(set) var width = 0
    private(set) var height = 0

    func start() async throws {
        let lifecycle = queue.sync { lifecycleGeneration += 1; return lifecycleGeneration }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let mainID = CGMainDisplayID()
        guard let display = content.displays.first(where: { $0.displayID == mainID }) ?? content.displays.first else {
            throw PortalError.message("No display is available for capture.")
        }
        bounds = CGDisplayBounds(display.displayID)
        let ratio = min(1, 1440.0 / Double(display.width))
        width = max(2, Int(Double(display.width) * ratio) / 2 * 2)
        height = max(2, Int(Double(display.height) * ratio) / 2 * 2)
        let configuration = SCStreamConfiguration()
        configuration.width = width
        configuration.height = height
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 8)
        configuration.queueDepth = 3
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.showsCursor = true
        configuration.capturesAudio = false
        configuration.excludesCurrentProcessAudio = true
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let newStream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try newStream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        stream = newStream
        do {
            try await newStream.startCapture()
            let accepted = queue.sync { () -> Bool in
                guard lifecycleGeneration == lifecycle else { return false }
                freshness.begin(now: ProcessInfo.processInfo.systemUptime)
                snapshotFilter = filter
                snapshotConfiguration = configuration
                let timer = DispatchSource.makeTimerSource(queue: queue)
                timer.schedule(deadline: .now() + .milliseconds(250), repeating: .milliseconds(250))
                timer.setEventHandler { [weak self] in self?.refreshUnchangedDisplay() }
                snapshotTimer = timer
                timer.resume()
                return true
            }
            if !accepted { try? await newStream.stopCapture(); throw CancellationError() }
        }
        catch { stream = nil; throw error }
    }

    func stop() async {
        queue.sync {
            lifecycleGeneration += 1
            freshness.stop()
            snapshotTimer?.cancel()
            snapshotTimer = nil
            snapshotFilter = nil
            snapshotConfiguration = nil
        }
        guard let old = stream else { return }
        stream = nil
        try? await old.stopCapture()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.async { [weak self] in
            guard let self, self.freshness.running else { return }
            self.freshness.stop()
            self.snapshotTimer?.cancel()
            self.snapshotTimer = nil
            self.onError?("Screen capture stopped. Check macOS Screen Recording permission.")
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, freshness.running else { return }
        // Idle buffers can lack imageBuffer. Read their status first.
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]]
        let raw = attachments?.first?[.status] as? Int
        let status = sampleBuffer.isValid ? raw.flatMap { SCFrameStatus(rawValue: $0) } : nil
        if freshness.observe(status) {
            snapshotTimer?.cancel()
            snapshotTimer = nil
            onError?("Screen updates are unavailable, blank, or suspended.")
            return
        }
        guard status == .complete || status == .started,
              let buffer = sampleBuffer.imageBuffer else { return }
        let now = ProcessInfo.processInfo.systemUptime
        guard now - freshness.lastOutput >= 0.12 else { return }
        autoreleasepool {
            let source = CIImage(cvPixelBuffer: buffer)
            guard let image = context.createCGImage(source, from: source.extent) else { return }
            emit(image, now: now)
        }
    }

    private func emit(_ image: CGImage, now: Double) {
        guard freshness.running, freshness.liveStatus, CGPreflightScreenCaptureAccess(),
              AXIsProcessTrusted(), !sessionLocked() else { return }
        autoreleasepool {
            let bytes = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(bytes, UTType.jpeg.identifier as CFString, 1, nil) else { return }
            CGImageDestinationAddImage(destination, image,
                                      [kCGImageDestinationLossyCompressionQuality: 0.58] as CFDictionary)
            guard CGImageDestinationFinalize(destination), bytes.length <= 1_500_000 else { return }
            freshness.recordOutput(now: now)
            onFrame?(bytes as Data)
        }
    }

    private func refreshUnchangedDisplay() {
        guard freshness.needsSnapshot(now: ProcessInfo.processInfo.systemUptime),
              !snapshotPending, let filter = snapshotFilter, let configuration = snapshotConfiguration,
              CGPreflightScreenCaptureAccess(), AXIsProcessTrusted(), !sessionLocked() else { return }
        snapshotPending = true
        let generation = freshness.generation
        // Capture new pixels through the OS, rather than assigning a fresh date
        // to an old JPEG when ScreenCaptureKit has no changed-frame image.
        SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { [weak self] image, error in
            guard let self else { return }
            self.queue.async {
                self.snapshotPending = false
                guard self.freshness.acceptsSnapshot(generation: generation,
                    permitted: CGPreflightScreenCaptureAccess() && AXIsProcessTrusted(),
                    unlocked: !sessionLocked()) else { return }
                guard error == nil, let image else {
                    self.freshness.stop()
                    self.snapshotTimer?.cancel()
                    self.snapshotTimer = nil
                    self.onError?("A fresh desktop image is unavailable. Check the display and Screen Recording permission.")
                    return
                }
                self.emit(image, now: ProcessInfo.processInfo.systemUptime)
            }
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var stateItem: NSMenuItem!
    private var pauseItem: NSMenuItem!
    private var connectItem: NSMenuItem!
    private var networkTask: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private var http: HTTPRelay?
    private var httpEpoch = ""
    private var httpCursor: Int64 = 0
    private var httpStatusTask: Task<Void, Never>?
    private var httpFrameTask: Task<Void, Never>?
    private var httpStatusFields: [String: Any] = [:]
    private var httpStatusVersion = 0
    private var httpReadyAcknowledged = false
    private var httpFrameDirty = false
    private var frameGeneration = 0
    private var socketGeneration = 0
    private var reconnectTimer: Timer?
    private var pollTimer: Timer?
    private var reconnectDelay: Double = 1
    private var connected = false
    private var wanted = true
    private var paused = false
    private var viewers = 0
    private var capture: ScreenCapture?
    private var captureStarting = false
    private var captureGeneration = 0
    private var sendingFrame = false
    private var captureRetryAt = Date.distantPast
    private var lastStatus = ""
    private var lastHeartbeat = Date.distantPast
    private var lastError: String?
    private var powerAssertion: Process?
    private let input = DesktopInput()

    private var configPath: String {
        let arguments = CommandLine.arguments
        if let flag = arguments.firstIndex(of: "--config"), flag + 1 < arguments.count { return arguments[flag + 1] }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/SchafferDesktop/config.json").path
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMenu()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.poll() }
        }
        connect()
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Normal Disconnect can await the cloud; termination sends best effort.
        disconnect()
    }

    private func setupMenu() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = NSImage(systemSymbolName: "desktopcomputer", accessibilityDescription: "Schaffer Desktop")
        let menu = NSMenu()
        stateItem = NSMenuItem(title: "Schaffer Desktop: Starting…", action: nil, keyEquivalent: "")
        menu.addItem(stateItem)
        menu.addItem(.separator())
        pauseItem = NSMenuItem(title: "Pause desktop sharing", action: #selector(togglePause), keyEquivalent: "")
        pauseItem.target = self
        menu.addItem(pauseItem)
        connectItem = NSMenuItem(title: "Disconnect", action: #selector(toggleConnection), keyEquivalent: "")
        connectItem.target = self
        menu.addItem(connectItem)
        menu.addItem(.separator())
        for (title, action) in [("Grant Screen Recording…", #selector(requestScreen)),
                                ("Grant Accessibility…", #selector(requestAccessibility)),
                                ("Open permission settings…", #selector(openPermissions))] {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self
            menu.addItem(item)
        }
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit Schaffer Desktop", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        statusItem.menu = menu
    }

    @objc private func requestScreen() {
        NSApp.activate(ignoringOtherApps: true)
        _ = CGRequestScreenCaptureAccess()
        poll()
    }

    @objc private func requestAccessibility() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        poll()
    }

    @objc private func openPermissions() {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy")!)
    }

    @objc private func togglePause() {
        paused.toggle()
        lastError = nil
        publishStatus(force: true)
        reconcileCapture()
    }

    @objc private func toggleConnection() {
        if wanted { disconnect() } else { wanted = true; lastError = nil; connect() }
        publishStatus(force: true)
    }

    @objc private func quitApp() { NSApp.terminate(nil) }

    private var canCapture: Bool {
        wanted && connected && !paused && viewers > 0 &&
        CGPreflightScreenCaptureAccess() && AXIsProcessTrusted() && !sessionLocked()
    }

    private var shouldCapture: Bool { canCapture && lastError == nil }

    private func connect() {
        guard wanted else { return }
        startPowerAssertion()
        reconnectTimer?.invalidate()
        socketGeneration += 1
        let generation = socketGeneration
        networkTask?.cancel()
        httpStatusTask?.cancel()
        httpStatusTask = nil
        httpFrameTask?.cancel()
        httpFrameTask = nil
        http?.invalidate()
        http = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        connected = false
        viewers = 0
        lastStatus = ""
        httpCursor = 0
        httpStatusFields = [:]
        httpStatusVersion = 0
        httpReadyAcknowledged = false
        httpFrameDirty = false
        do {
            let raw = try Data(contentsOf: URL(fileURLWithPath: configPath))
            let configuration = try JSONDecoder().decode(Configuration.self, from: raw)
            if configuration.usesHTTP {
                let client = try HTTPRelay(configuration: configuration)
                http = client
                httpEpoch = UUID().uuidString.lowercased()
                let epoch = httpEpoch
                networkTask = Task { [weak self] in
                    guard let self else { return }
                    do {
                        let reply = try await client.request("/agent/connect", method: "POST", json: ["epoch": epoch])
                        guard !Task.isCancelled, self.socketGeneration == generation, self.httpEpoch == epoch else { return }
                        guard reply["epoch"] as? String == epoch else { throw PortalError.message("Desktop relay session changed.") }
                        self.connected = true
                        self.lastError = nil
                        self.reconnectDelay = 1
                        self.updateViewers(reply["viewers"])
                        self.publishStatus(force: true)
                        while !Task.isCancelled {
                            let reply = try await client.request("/agent/poll", query: ["epoch": epoch, "after": String(self.httpCursor)])
                            guard !Task.isCancelled, self.socketGeneration == generation,
                                  self.httpEpoch == epoch else { return }
                            guard reply["epoch"] as? String == epoch,
                                  let events = reply["events"] as? [[String: Any]], events.count <= 256 else {
                                throw PortalError.message("Desktop relay session changed.")
                            }
                            self.updateViewers(reply["viewers"])
                            for envelope in events {
                                guard let number = finiteNumber(envelope["id"]), number.rounded() == number,
                                      number >= 1, number <= 9_007_199_254_740_991 else {
                                    throw PortalError.message("Desktop relay event identity was invalid.")
                                }
                                let identifier = Int64(number)
                                guard identifier > self.httpCursor else { continue }
                                let expiry = finiteNumber(envelope["expiresAt"])
                                if let raw = envelope["event"] as? [String: Any] {
                                    if raw["type"] as? String == "release" || expiry == nil || expiry! > Date().timeIntervalSince1970 * 1000 {
                                        self.applyInput(raw)
                                    } else { self.input.releaseAll() }
                                }
                                // Only acknowledge after applying or safely discarding the event.
                                self.httpCursor = identifier
                            }
                            try await Task.sleep(nanoseconds: self.viewers > 0 ? 200_000_000 : 1_000_000_000)
                        }
                    } catch {
                        guard !Task.isCancelled, self.socketGeneration == generation else { return }
                        self.lostConnection()
                    }
                }
                publishStatus(force: true)
                reconcileCapture()
                return
            }
            let address = try configuration.socketURL()
            var request = URLRequest(url: address, timeoutInterval: 20)
            request.setValue("Bearer " + configuration.producerKey, forHTTPHeaderField: "Authorization")
            request.setValue("SchafferDesktop/1.0", forHTTPHeaderField: "User-Agent")
            let session = URLSession(configuration: .ephemeral)
            let task = session.webSocketTask(with: request)
            task.maximumMessageSize = 65_536
            socket = task
            task.resume()
            networkTask = Task { [weak self] in
                guard let self else { return }
                do {
                    // First server message confirms the WebSocket upgrade and producer role.
                    let first = try await task.receive()
                    guard !Task.isCancelled, self.socketGeneration == generation else { return }
                    self.connected = true
                    self.lastError = nil
                    self.reconnectDelay = 1
                    self.handle(first)
                    self.publishStatus(force: true)
                    while !Task.isCancelled {
                        let message = try await task.receive()
                        guard self.socketGeneration == generation else { break }
                        self.handle(message)
                    }
                } catch {
                    guard !Task.isCancelled, self.socketGeneration == generation else { return }
                    self.lostConnection()
                }
            }
        } catch {
            // Do not print configuration contents or network errors containing headers.
            wanted = false
            stopPowerAssertion()
            lastError = "Configuration unavailable or invalid. Supply --config with relayUrl and producerKey."
        }
        publishStatus(force: true)
        reconcileCapture()
    }

    private func disconnect() {
        wanted = false
        stopPowerAssertion()
        reconnectTimer?.invalidate()
        bestEffortHTTPDisconnect()
        socketGeneration += 1
        networkTask?.cancel()
        httpStatusTask?.cancel()
        httpStatusTask = nil
        httpFrameTask?.cancel()
        httpFrameTask = nil
        http?.invalidate()
        http = nil
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        connected = false
        viewers = 0
        reconcileCapture()
    }

    private func lostConnection() {
        guard socket != nil || http != nil || connected else { return }
        bestEffortHTTPDisconnect()
        socketGeneration += 1
        networkTask?.cancel()
        httpStatusTask?.cancel()
        httpStatusTask = nil
        httpFrameTask?.cancel()
        httpFrameTask = nil
        http?.invalidate()
        http = nil
        connected = false
        viewers = 0
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        reconcileCapture()
        publishStatus(force: true)
        guard wanted else { return }
        reconnectTimer?.invalidate()
        reconnectTimer = Timer.scheduledTimer(withTimeInterval: reconnectDelay, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.connect() }
        }
        reconnectDelay = min(30, reconnectDelay * 2)
    }

    private func updateViewers(_ raw: Any?) {
        guard let value = finiteNumber(raw), value.rounded() == value,
              (0...32).contains(value), Int(value) != viewers else { return }
        viewers = Int(value)
        reconcileCapture()
        publishStatus(force: true)
    }

    private func bestEffortHTTPDisconnect() {
        guard let old = http, !httpEpoch.isEmpty,
              let cleanup = try? HTTPRelay(configuration: old.configuration) else { return }
        let epoch = httpEpoch
        Task {
            _ = try? await cleanup.request("/agent/disconnect", method: "POST", json: ["epoch": epoch])
            cleanup.invalidate()
        }
    }

    private func clearHTTPFrame() {
        frameGeneration += 1
        httpFrameTask?.cancel()
        httpFrameTask = nil
        sendingFrame = false
        guard httpFrameDirty, let old = http, !httpEpoch.isEmpty,
              let cleanup = try? HTTPRelay(configuration: old.configuration) else { return }
        httpFrameDirty = false
        let epoch = httpEpoch
        Task {
            _ = try? await cleanup.request("/agent/frame", method: "DELETE", query: ["epoch": epoch])
            cleanup.invalidate()
        }
    }

    private func startPowerAssertion() {
        guard powerAssertion == nil else { return }
        let assertion = Process()
        assertion.executableURL = URL(fileURLWithPath: "/usr/bin/caffeinate")
        // -s prevents system sleep only on AC; the display can still sleep normally.
        assertion.arguments = ["-s", "-w", String(ProcessInfo.processInfo.processIdentifier)]
        assertion.standardOutput = FileHandle.nullDevice
        assertion.standardError = FileHandle.nullDevice
        do { try assertion.run(); powerAssertion = assertion } catch { powerAssertion = nil }
    }

    private func stopPowerAssertion() {
        if let assertion = powerAssertion, assertion.isRunning { assertion.terminate() }
        powerAssertion = nil
    }

    private func sendJSON(_ value: [String: Any]) {
        guard connected else { return }
        if http != nil { sendHTTPStatus(value); return }
        guard let socket, let data = try? JSONSerialization.data(withJSONObject: value),
              let text = String(data: data, encoding: .utf8) else { return }
        let generation = socketGeneration
        socket.send(.string(text)) { [weak self] error in
            guard error != nil else { return }
            Task { @MainActor in
                guard let self, self.socketGeneration == generation else { return }
                self.lostConnection()
            }
        }
    }

    private func sendHTTPStatus(_ value: [String: Any]) {
        guard connected, let client = http else { return }
        if value["ready"] as? Bool == false { httpReadyAcknowledged = false }
        for (key, field) in value where key != "type" { httpStatusFields[key] = field }
        httpStatusFields["type"] = "status"
        httpStatusVersion += 1
        guard httpStatusTask == nil else { return }
        let generation = socketGeneration
        let epoch = httpEpoch
        httpStatusTask = Task { [weak self] in
            guard let self else { return }
            defer { if self.socketGeneration == generation { self.httpStatusTask = nil } }
            do {
                while !Task.isCancelled && self.connected && self.socketGeneration == generation {
                    let version = self.httpStatusVersion
                    let fields = self.httpStatusFields
                    let reply = try await client.request("/agent/status", method: "POST",
                                                         json: ["epoch": epoch, "status": fields])
                    guard !Task.isCancelled, self.socketGeneration == generation else { return }
                    guard reply["epoch"] as? String == epoch else { throw PortalError.message("Desktop relay session changed.") }
                    self.httpReadyAcknowledged = fields["ready"] as? Bool == true && self.httpStatusFields["ready"] as? Bool == true
                    self.updateViewers(reply["viewers"])
                    if self.httpStatusVersion == version { return }
                }
            } catch {
                guard !Task.isCancelled, self.socketGeneration == generation else { return }
                self.lostConnection()
            }
        }
    }

    private func sendFrame(_ data: Data) {
        guard connected, shouldCapture, !sendingFrame, data.count <= 2_097_152 else { return }
        if http != nil && !httpReadyAcknowledged { return }
        sendingFrame = true
        frameGeneration += 1
        let frame = frameGeneration
        let generation = socketGeneration
        if let client = http {
            let epoch = httpEpoch
            httpFrameDirty = true
            httpFrameTask = Task { [weak self] in
                guard let self else { return }
                do {
                    _ = try await client.request("/agent/frame", method: "PUT",
                                                  query: ["epoch": epoch, "id": UUID().uuidString.lowercased()],
                                                  body: data, contentType: "image/jpeg")
                    guard !Task.isCancelled, self.socketGeneration == generation,
                          self.frameGeneration == frame else { return }
                    self.sendingFrame = false
                    self.httpFrameTask = nil
                } catch {
                    guard !Task.isCancelled, self.socketGeneration == generation,
                          self.frameGeneration == frame else { return }
                    self.sendingFrame = false
                    self.httpFrameTask = nil
                    self.lostConnection()
                }
            }
        } else if let socket {
            socket.send(.data(data)) { [weak self] error in
                Task { @MainActor in
                    guard let self, self.socketGeneration == generation,
                          self.frameGeneration == frame else { return }
                    self.sendingFrame = false
                    if error != nil { self.lostConnection() }
                }
            }
        } else { sendingFrame = false }
    }

    private func applyInput(_ raw: [String: Any]) {
        guard let event = validatedEvent(raw) else { return }
        if event["type"] as? String == "release" { input.releaseAll(); return }
        guard shouldCapture, capture != nil else { return }
        input.apply(event)
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        guard case .string(let text) = message, text.utf8.count <= 32_768,
              let bytes = text.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let type = value["type"] as? String else { return }
        if type == "viewers" {
            updateViewers(value["count"])
        } else if type == "input", let raw = value["event"] as? [String: Any] {
            applyInput(raw)
        }
    }

    private func poll() {
        reconcileCapture()
        publishStatus(force: false)
        if connected && Date().timeIntervalSince(lastHeartbeat) >= 10 {
            lastHeartbeat = Date()
            publishStatus(force: true)
            let generation = socketGeneration
            socket?.sendPing { [weak self] error in
                guard error != nil else { return }
                Task { @MainActor in
                    guard let self, self.socketGeneration == generation else { return }
                    self.lostConnection()
                }
            }
        }
    }

    private func publishStatus(force: Bool) {
        let screen = CGPreflightScreenCaptureAccess()
        let accessibility = AXIsProcessTrusted()
        let locked = sessionLocked()
        let state: String
        let message: String
        if let error = lastError { state = "error"; message = error }
        else if !wanted { state = "disconnected"; message = "Desktop sharing disconnected on this Mac." }
        else if !connected { state = "connecting"; message = "Connecting to the desktop relay…" }
        else if paused { state = "paused"; message = "Desktop sharing paused on this Mac." }
        else if locked { state = "locked"; message = "Mac is locked. Unlock it locally to resume desktop sharing." }
        else if !screen || !accessibility {
            state = "permissions_required"
            message = "Grant Screen Recording and Accessibility to Schaffer Desktop in macOS settings."
        } else { state = "ready"; message = viewers > 0 ? "Live desktop connected." : "Mac is ready for a desktop connection." }
        stateItem?.title = "Schaffer Desktop: " + state.replacingOccurrences(of: "_", with: " ")
        pauseItem?.title = paused ? "Resume desktop sharing" : "Pause desktop sharing"
        connectItem?.title = wanted ? "Disconnect" : "Connect"
        statusItem?.button?.appearsDisabled = !connected || paused || locked || !screen || !accessibility
        let stamp = "\(state)|\(message)|\(screen)|\(accessibility)|\(viewers)"
        guard force || stamp != lastStatus else { return }
        lastStatus = stamp
        sendJSON(["type": "status", "state": state, "screenRecording": screen,
                  "accessibility": accessibility, "locked": locked, "viewers": viewers,
                  "ready": state == "ready" && screen && accessibility && !locked,
                  "message": message])
    }

    private func reconcileCapture() {
        if !canCapture {
            captureGeneration += 1
            captureStarting = false
            if let old = capture { capture = nil; Task { await old.stop() } }
            input.releaseAll()
            clearHTTPFrame()
            return
        }
        guard capture == nil, !captureStarting, Date() >= captureRetryAt else { return }
        captureStarting = true
        captureGeneration += 1
        let generation = captureGeneration
        let source = ScreenCapture()
        source.onFrame = { [weak self] data in
            Task { @MainActor in
                guard let self, self.captureGeneration == generation, self.shouldCapture,
                      !self.sendingFrame else { return }
                self.sendFrame(data)
            }
        }
        source.onError = { [weak self] message in
            Task { @MainActor in
                guard let self, self.captureGeneration == generation else { return }
                self.captureGeneration += 1
                self.captureStarting = false
                self.lastError = message
                self.captureRetryAt = Date().addingTimeInterval(5)
                if let old = self.capture { self.capture = nil; Task { await old.stop() } }
                self.input.releaseAll()
                self.clearHTTPFrame()
                self.publishStatus(force: true)
            }
        }
        Task {
            do {
                try await source.start()
                guard captureGeneration == generation, canCapture else { await source.stop(); return }
                capture = source
                captureStarting = false
                lastError = nil
                input.displayBounds = source.bounds
                sendJSON(["type": "hello", "width": source.width, "height": source.height,
                          "displayWidth": source.bounds.width, "displayHeight": source.bounds.height,
                          "scale": Double(source.width) / max(1, source.bounds.width),
                          "fps": 8, "display": "Main display", "ready": shouldCapture])
                publishStatus(force: true)
            } catch {
                guard captureGeneration == generation else { return }
                captureStarting = false
                lastError = "Screen capture unavailable. Check macOS Screen Recording permission and the display."
                captureRetryAt = Date().addingTimeInterval(5)
                publishStatus(force: true)
            }
        }
    }
}

func captureSelfTest() -> Bool {
    var policy = FrameFreshnessPolicy()
    var passed = !policy.needsSnapshot(now: 100)
    policy.begin(now: 10)
    passed = passed && !policy.needsSnapshot(now: 10.74) && policy.needsSnapshot(now: 10.75)
    passed = passed && !policy.observe(.idle) && policy.needsSnapshot(now: 11)
    let liveGeneration = policy.generation
    passed = passed && policy.acceptsSnapshot(generation: liveGeneration, permitted: true, unlocked: true)
    passed = passed && !policy.acceptsSnapshot(generation: liveGeneration, permitted: false, unlocked: true)
    passed = passed && !policy.acceptsSnapshot(generation: liveGeneration, permitted: true, unlocked: false)
    policy.recordOutput(now: 11)
    passed = passed && !policy.needsSnapshot(now: 11.74) && policy.needsSnapshot(now: 11.75)
    passed = passed && policy.observe(.suspended) && !policy.needsSnapshot(now: 100)
    passed = passed && !policy.acceptsSnapshot(generation: liveGeneration, permitted: true, unlocked: true)
    passed = passed && !policy.observe(.complete)
    passed = passed && !policy.acceptsSnapshot(generation: liveGeneration, permitted: true, unlocked: true)
    passed = passed && policy.observe(.blank) && !policy.needsSnapshot(now: 100)
    passed = passed && policy.observe(nil) && !policy.needsSnapshot(now: 100)
    policy.stop()
    let stoppedGeneration = policy.generation
    passed = passed && !policy.observe(.idle) && !policy.needsSnapshot(now: 100)
    policy.begin(now: 101)
    passed = passed && !policy.acceptsSnapshot(generation: stoppedGeneration, permitted: true, unlocked: true)
    policy.observe(.stopped)
    passed = passed && !policy.needsSnapshot(now: 200)
    print("Idle/suspended capture freshness: \(passed ? "passed" : "FAILED")")
    return passed
}

func selfTest() -> Bool {
    let valid: [[String: Any]] = [
        ["type": "pointer", "action": "down", "x": 0.5, "y": 0.75, "button": 0],
        ["type": "scroll", "deltaX": 0, "deltaY": 25],
        ["type": "key", "action": "down", "code": "KeyA", "modifiers": ["Meta"]],
        ["type": "text", "text": "Hello 👋"], ["type": "release"]
    ]
    let invalid: [[String: Any]] = [
        ["type": "pointer", "action": "down", "x": 1.5, "y": 0],
        ["type": "pointer", "action": "down", "x": true, "y": 0],
        ["type": "pointer", "action": "down", "x": 0, "y": 0, "button": 0.5],
        ["type": "scroll", "deltaX": 0, "deltaY": 20_000],
        ["type": "key", "action": "down", "code": "Unknown"],
        ["type": "key", "action": "down", "code": "KeyA", "modifiers": ["Other"]],
        ["type": "text", "text": String(repeating: "a", count: 2001)],
        ["type": "command", "command": "open"]
    ]
    let inputOK = valid.allSatisfy { validatedEvent($0) != nil } && invalid.allSatisfy { validatedEvent($0) == nil }
    let good = Configuration(relayUrl: "https://example.workers.dev", producerKey: String(repeating: "x", count: 32))
    let bad = Configuration(relayUrl: "https://example.workers.dev?key=exposed", producerKey: "short")
    let http = Configuration(relayUrl: "https://example.chatgpt.site/", producerKey: String(repeating: "x", count: 32), transport: "http")
    let badHTTP = Configuration(relayUrl: "wss://example.chatgpt.site", producerKey: String(repeating: "x", count: 32), transport: "http")
    let badMode = Configuration(relayUrl: "https://example.chatgpt.site", producerKey: String(repeating: "x", count: 32), transport: "other")
    let configOK = (try? good.socketURL().absoluteString) == "wss://example.workers.dev/agent" && (try? bad.socketURL()) == nil &&
        http.usesHTTP && (try? http.baseURL().absoluteString) == "https://example.chatgpt.site" &&
        (try? badHTTP.baseURL()) == nil && (try? badMode.baseURL()) == nil
    print("Input validation: \(inputOK ? "passed" : "FAILED")")
    print("Configuration validation: \(configOK ? "passed" : "FAILED")")
    return inputOK && configOK && captureSelfTest()
}

// URLProtocol fixtures exercise HTTPS framing without a network, capture, or input.
final class FixtureHTTP: URLProtocol {
    static var requests: [URLRequest] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        let path = request.url!.path
        let status = path == "/agent/failure" ? 401 : 200
        let payload = path == "/agent/bad-json" ? Data("not json".utf8) : Data("{\"epoch\":\"fixture\",\"viewers\":0}".utf8)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: payload)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

func httpSelfTest() async -> Bool {
    let settings = URLSessionConfiguration.ephemeral
    settings.protocolClasses = [FixtureHTTP.self]
    let configuration = Configuration(relayUrl: "https://fixture.example", producerKey: String(repeating: "x", count: 32), transport: "http")
    do {
        let client = try HTTPRelay(configuration: configuration, testingSession: settings)
        defer { client.invalidate() }
        let connect = try await client.request("/agent/connect", method: "POST", json: ["epoch": "fixture"])
        _ = try await client.request("/agent/poll", query: ["epoch": "fixture", "after": "7"])
        _ = try await client.request("/agent/frame", method: "PUT", query: ["epoch": "fixture", "id": "frame"],
                                     body: Data([0xff, 0xd8, 0xff, 0xd9]), contentType: "image/jpeg")
        let recorded = FixtureHTTP.requests
        let framing = connect["epoch"] as? String == "fixture" && recorded.count == 3 &&
            recorded[0].httpMethod == "POST" && recorded[1].httpMethod == "GET" && recorded[2].httpMethod == "PUT" &&
            recorded[2].value(forHTTPHeaderField: "Content-Type") == "image/jpeg" &&
            recorded.allSatisfy { $0.url?.host == "fixture.example" && $0.url?.scheme == "https" &&
                $0.value(forHTTPHeaderField: "Authorization") == "Bearer " + configuration.producerKey &&
                !($0.url?.absoluteString.contains(configuration.producerKey) ?? true) }
        var failedStatus = false, invalidJSON = false
        do { _ = try await client.request("/agent/failure") } catch { failedStatus = true }
        do { _ = try await client.request("/agent/bad-json") } catch { invalidJSON = true }
        let passed = framing && failedStatus && invalidJSON
        print("Mock HTTPS transport: \(passed ? "passed" : "FAILED")")
        return passed
    } catch {
        print("Mock HTTPS transport: FAILED")
        return false
    }
}

if CommandLine.arguments.contains("--self-test") {
    exit(selfTest() ? 0 : 1)
} else if CommandLine.arguments.contains("--http-self-test") {
    Task { exit(await httpSelfTest() ? 0 : 1) }
    RunLoop.current.run()
} else if CommandLine.arguments.contains("--capture-self-test") {
    exit(captureSelfTest() ? 0 : 1)
} else if CommandLine.arguments.contains("--probe") {
    let bytes = try JSONSerialization.data(withJSONObject: permissionSnapshot(), options: [.sortedKeys])
    print(String(data: bytes, encoding: .utf8)!)
} else {
    MainActor.assumeIsolated {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let delegate = AppDelegate()
        application.delegate = delegate
        application.run()
    }
}
