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

    func socketURL() throws -> URL {
        guard var url = URLComponents(string: relayUrl),
              let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              ["https", "wss"].contains(url.scheme?.lowercased() ?? ""),
              producerKey.count >= 32, producerKey.count <= 249,
              !producerKey.contains("\r"), !producerKey.contains("\n") else {
            throw PortalError.message("Configuration needs an HTTPS relay URL and a valid producer key.")
        }
        url.scheme = "wss"
        url.path = "/agent"
        guard let result = url.url else { throw PortalError.message("Invalid relay URL.") }
        return result
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

final class ScreenCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private let queue = DispatchQueue(label: "com.schafferai.desktop.frames", qos: .userInitiated)
    private let context = CIContext(options: [.cacheIntermediates: false])
    private var lastFrame: TimeInterval = 0
    var onFrame: ((Data) -> Void)?
    var onError: ((String) -> Void)?
    private(set) var bounds = CGRect.zero
    private(set) var width = 0
    private(set) var height = 0

    func start() async throws {
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
        do { try await newStream.startCapture() }
        catch { stream = nil; throw error }
    }

    func stop() async {
        guard let old = stream else { return }
        stream = nil
        try? await old.stopCapture()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onError?("Screen capture stopped. Check macOS Screen Recording permission.")
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid,
              let buffer = sampleBuffer.imageBuffer else { return }
        let now = ProcessInfo.processInfo.systemUptime
        guard now - lastFrame >= 0.12 else { return }
        lastFrame = now
        autoreleasepool {
            let source = CIImage(cvPixelBuffer: buffer)
            guard let image = context.createCGImage(source, from: source.extent) else { return }
            let bytes = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(bytes, UTType.jpeg.identifier as CFString, 1, nil) else { return }
            CGImageDestinationAddImage(destination, image,
                                      [kCGImageDestinationLossyCompressionQuality: 0.58] as CFDictionary)
            guard CGImageDestinationFinalize(destination), bytes.length <= 1_500_000 else { return }
            onFrame?(bytes as Data)
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
        wanted = false
        input.releaseAll()
        stopPowerAssertion()
        socket?.cancel(with: .goingAway, reason: nil)
        networkTask?.cancel()
        if let capture { Task { await capture.stop() } }
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

    private var shouldCapture: Bool {
        wanted && connected && !paused && viewers > 0 &&
        CGPreflightScreenCaptureAccess() && AXIsProcessTrusted() && !sessionLocked()
    }

    private func connect() {
        guard wanted else { return }
        startPowerAssertion()
        reconnectTimer?.invalidate()
        socketGeneration += 1
        let generation = socketGeneration
        networkTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        connected = false
        viewers = 0
        do {
            let raw = try Data(contentsOf: URL(fileURLWithPath: configPath))
            let configuration = try JSONDecoder().decode(Configuration.self, from: raw)
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
        socketGeneration += 1
        networkTask?.cancel()
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        connected = false
        viewers = 0
        reconcileCapture()
    }

    private func lostConnection() {
        guard socket != nil || connected else { return }
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
        guard connected, let socket,
              let data = try? JSONSerialization.data(withJSONObject: value),
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

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        guard case .string(let text) = message, text.utf8.count <= 32_768,
              let bytes = text.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let type = value["type"] as? String else { return }
        if type == "viewers", let count = finiteNumber(value["count"]), (0...32).contains(count) {
            viewers = Int(count)
            reconcileCapture()
            publishStatus(force: true)
        } else if type == "input", let raw = value["event"] as? [String: Any], let event = validatedEvent(raw) {
            if event["type"] as? String == "release" { input.releaseAll(); return }
            guard shouldCapture, capture != nil else { return }
            input.apply(event)
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
        if !shouldCapture {
            captureGeneration += 1
            captureStarting = false
            if let old = capture { capture = nil; Task { await old.stop() } }
            input.releaseAll()
            sendingFrame = false
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
                      !self.sendingFrame, let socket = self.socket else { return }
                self.sendingFrame = true
                let socketGeneration = self.socketGeneration
                socket.send(.data(data)) { [weak self] error in
                    Task { @MainActor in
                        guard let self, self.socketGeneration == socketGeneration else { return }
                        self.sendingFrame = false
                        if error != nil { self.lostConnection() }
                    }
                }
            }
        }
        source.onError = { [weak self] message in
            Task { @MainActor in
                guard let self, self.captureGeneration == generation else { return }
                self.lastError = message
                self.captureRetryAt = Date().addingTimeInterval(5)
                if let old = self.capture { self.capture = nil; Task { await old.stop() } }
                self.input.releaseAll()
                self.publishStatus(force: true)
            }
        }
        Task {
            do {
                try await source.start()
                guard captureGeneration == generation, shouldCapture else { await source.stop(); return }
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
    let configOK = (try? good.socketURL().absoluteString) == "wss://example.workers.dev/agent" && (try? bad.socketURL()) == nil
    print("Input validation: \(inputOK ? "passed" : "FAILED")")
    print("Configuration validation: \(configOK ? "passed" : "FAILED")")
    return inputOK && configOK
}

if CommandLine.arguments.contains("--self-test") {
    exit(selfTest() ? 0 : 1)
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
