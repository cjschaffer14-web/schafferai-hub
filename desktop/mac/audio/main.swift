import AppKit
import ApplicationServices
import AudioToolbox
import AVFoundation
import CoreAudio
import CoreGraphics
import CoreMedia
import Foundation

private enum AudioError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

private struct Configuration: Decodable {
    let relayUrl: String
    let producerKey: String
    func baseURL() throws -> URL {
        guard var parts = URLComponents(string: relayUrl), parts.scheme == "https",
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              (32...249).contains(producerKey.count), !producerKey.contains("\n"), !producerKey.contains("\r") else {
            throw AudioError.message("The private HTTPS desktop configuration is invalid.")
        }
        parts.path = ""
        guard let url = parts.url else { throw AudioError.message("Invalid relay address.") }
        return url
    }
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

private final class Relay {
    let base: URL
    let key: String
    private let redirectDelegate = NoRedirects()
    private let session: URLSession
    init(_ config: Configuration) throws {
        base = try config.baseURL(); key = config.producerKey
        let settings = URLSessionConfiguration.ephemeral
        settings.httpShouldSetCookies = false; settings.urlCache = nil
        settings.requestCachePolicy = .reloadIgnoringLocalCacheData
        settings.timeoutIntervalForRequest = 1.5; settings.timeoutIntervalForResource = 2
        settings.httpMaximumConnectionsPerHost = 6 // Three sound uploads plus state, status and microphone requests.
        session = URLSession(configuration: settings, delegate: redirectDelegate, delegateQueue: nil)
    }
    func request(_ path: String, query: [String: String] = [:], body: [String: Any]? = nil) async throws -> [String: Any] {
        guard path.hasPrefix("/agent/") else { throw AudioError.message("Invalid audio route.") }
        var parts = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        parts.path = path
        if !query.isEmpty { parts.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var request = URLRequest(url: parts.url!)
        request.httpMethod = body == nil ? "GET" : "POST"
        request.setValue("Bearer " + key, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.setValue("SchafferDesktopAudio/1.1", forHTTPHeaderField: "User-Agent")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (bytes, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, (200...299).contains(response.statusCode), bytes.count <= 524_288 else {
            throw AudioError.message("The audio relay request failed.")
        }
        if bytes.isEmpty { return [:] }
        guard let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
            throw AudioError.message("The audio relay returned an invalid response.")
        }
        return object
    }
}

private func locked() -> Bool {
    guard let info = CGSessionCopyCurrentDictionary() as? [String: Any] else { return true }
    return info["CGSSessionScreenIsLocked"] as? Bool == true || info[kCGSessionOnConsoleKey as String] as? Bool == false
}

private func stringProperty(_ device: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String? {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value) == noErr,
          let result = value?.takeRetainedValue() else { return nil }
    return result as String
}

private func blackHoleDevice() -> AudioDeviceID? {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var bytes: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &bytes) == noErr else { return nil }
    var devices = [AudioDeviceID](repeating: 0, count: Int(bytes) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &bytes, &devices) == noErr else { return nil }
    return devices.first { stringProperty($0, kAudioDevicePropertyDeviceUID) == "BlackHole2ch_UID" }
}

// Only complete 200 ms packets are emitted. No audio is persisted to disk.
private final class PCMChunker {
    private var pending = Data()
    func reset() { pending.removeAll(keepingCapacity: false) }
    func append(_ pcm: Data) -> [Data] {
        pending.append(pcm)
        var chunks: [Data] = []
        while pending.count >= 38_400 {
            chunks.append(Data(pending.prefix(38_400)))
            pending.removeFirst(38_400)
        }
        if pending.count > 38_400 { reset() }
        return chunks
    }
}

private func pcm16(_ sample: Float) -> Int16 {
    guard sample.isFinite else { return 0 }
    return Int16(max(-32_768, min(32_767, Int((max(-1, min(1, sample)) * 32_768).rounded()))))
}

private func ownAudioProcess() -> AudioObjectID? {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var pid = getpid(), value = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    let result = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address,
        UInt32(MemoryLayout<pid_t>.size), &pid, &size, &value)
    return result == noErr && value != kAudioObjectUnknown ? value : nil
}

// A private output-process tap needs only the dedicated system-audio permission.
// It never opens a microphone input, changes a default device, or mutes speakers.
private final class SystemSoundCapture {
    private static let enabledKey = "systemAudioEngineWasEnabled"
    private var tap = AudioObjectID(kAudioObjectUnknown)
    private var aggregate = AudioObjectID(kAudioObjectUnknown)
    private var ioProc: AudioDeviceIOProcID?
    private let queue = DispatchQueue(label: "com.schafferai.desktop-audio.samples")
    private let chunker = PCMChunker()
    private var accepting = false
    private var token = UUID()
    private var inputFormat: AVAudioFormat?
    private var converter: AVAudioConverter?
    private let outputFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32,
        sampleRate: 48_000, channels: 2, interleaved: false)!
    private(set) var enabled = UserDefaults.standard.bool(forKey: enabledKey)
    var onChunk: ((Data, UUID, Date) -> Void)?
    var onFailure: ((String) -> Void)?

    // This explicit menu action briefly starts tap IO to let macOS present its
    // normal audio consent dialog. Every sample is discarded; nothing is sent.
    @MainActor func requestPermission() async throws {
        await stop()
        enabled = false
        do {
            try begin(token: UUID(), deliver: false)
            let requestedTap = tap, requestedAggregate = aggregate
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard tap == requestedTap, aggregate == requestedAggregate, ioProc != nil else {
                throw AudioError.message("The system audio setup check was interrupted. Use Enable System Sound to retry.")
            }
            await stop()
            enabled = true
            UserDefaults.standard.set(true, forKey: Self.enabledKey)
        } catch {
            await stop()
            UserDefaults.standard.set(false, forKey: Self.enabledKey)
            throw error
        }
    }
    @MainActor func start(token: UUID) async throws {
        guard aggregate == kAudioObjectUnknown else { return }
        guard enabled else { throw AudioError.message("Enable system sound from the Schaffer Desktop Audio menu.") }
        do { try begin(token: token, deliver: true) }
        catch {
            await stop(); enabled = false
            UserDefaults.standard.set(false, forKey: Self.enabledKey)
            throw error
        }
    }
    @MainActor private func begin(token: UUID, deliver: Bool) throws {
        guard let selfProcess = ownAudioProcess() else {
            throw AudioError.message("This audio helper could not identify its own audio process; capture was not started.")
        }
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [selfProcess])
        description.name = "Schaffer Desktop System Sound"
        description.isPrivate = true
        description.muteBehavior = .unmuted
        if #available(macOS 26.0, *), let bundleID = Bundle.main.bundleIdentifier {
            description.bundleIDs = [bundleID]
            description.isProcessRestoreEnabled = true
        }
        try check(AudioHardwareCreateProcessTap(description, &tap), "create system audio tap")
        var address = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try check(AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &asbd), "read system audio format")
        guard asbd.mFormatID == kAudioFormatLinearPCM, asbd.mChannelsPerFrame == 2,
              (8_000...192_000).contains(asbd.mSampleRate),
              let format = AVAudioFormat(streamDescription: &asbd),
              let nextConverter = AVAudioConverter(from: format, to: outputFormat),
              let tapUID = stringProperty(tap, kAudioTapPropertyUID) else {
            throw AudioError.message("The system audio tap returned an unsupported stereo format.")
        }
        nextConverter.primeMethod = .none
        let composition: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Schaffer Desktop Audio Capture",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: tapUID,
                kAudioSubTapDriftCompensationKey: true]]
        ]
        try check(AudioHardwareCreateAggregateDevice(composition as CFDictionary, &aggregate), "create private audio input")
        queue.sync {
            self.chunker.reset(); self.token = token; self.inputFormat = format
            self.converter = nextConverter; self.accepting = deliver
        }
        try check(AudioDeviceCreateIOProcIDWithBlock(&ioProc, aggregate, queue) { [weak self] _, input, _, output, _ in
            // Tap-only aggregates have no hardware output. Clear any supplied
            // output defensively; captured samples are never monitored locally.
            for buffer in UnsafeMutableAudioBufferListPointer(output) {
                if let data = buffer.mData { memset(data, 0, Int(buffer.mDataByteSize)) }
            }
            self?.consume(input)
        }, "prepare system audio input")
        try check(AudioDeviceStart(aggregate, ioProc), "start system audio input")
    }
    private func check(_ status: OSStatus, _ operation: String) throws {
        guard status == noErr else {
            throw AudioError.message("Could not \(operation) (OSStatus \(status)). Allow System Audio Recording for Schaffer Desktop Audio in macOS Settings.")
        }
    }
    @MainActor func stop() async {
        queue.sync { self.accepting = false; self.chunker.reset() }
        if aggregate != kAudioObjectUnknown {
            if let ioProc {
                AudioDeviceStop(aggregate, ioProc)
                AudioDeviceDestroyIOProcID(aggregate, ioProc)
            }
            ioProc = nil
            AudioHardwareDestroyAggregateDevice(aggregate)
            aggregate = kAudioObjectUnknown
        }
        if tap != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tap); tap = kAudioObjectUnknown }
        queue.sync { self.inputFormat = nil; self.converter = nil }
    }
    static func offlineConversionTest() throws {
        let capture = SystemSoundCapture()
        let input = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 44_100, channels: 2, interleaved: false)!
        guard let converter = AVAudioConverter(from: input, to: capture.outputFormat),
              let buffer = AVAudioPCMBuffer(pcmFormat: input, frameCapacity: 4_410),
              let channels = buffer.floatChannelData else { throw AudioError.message("Offline converter setup failed.") }
        converter.primeMethod = .none; buffer.frameLength = 4_410
        for frame in 0..<4_410 { channels[0][frame] = 0.25; channels[1][frame] = -0.25 }
        capture.inputFormat = input; capture.converter = converter; capture.accepting = true
        var packets = [Data]()
        capture.onChunk = { data, _, _ in packets.append(data) }
        for _ in 0..<3 { capture.consume(buffer.audioBufferList) }
        capture.accepting = false
        guard packets.count == 1, packets[0].count == 38_400 else { throw AudioError.message("Offline stereo resampling packetization failed.") }
        for frame in [1_000, 5_000, 9_000] {
            for channel in 0..<2 {
                let offset = frame * 4 + channel * 2
                let sample = Int16(bitPattern: UInt16(packets[0][offset]) | UInt16(packets[0][offset + 1]) << 8)
                let expected = channel == 0 ? 8_192 : -8_192
                guard abs(Int(sample) - expected) < 64 else { throw AudioError.message("Offline stereo channel conversion failed.") }
            }
        }
    }
    private func consume(_ input: UnsafePointer<AudioBufferList>) {
        guard accepting, let format = inputFormat, let converter else { return }
        let source = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
        guard let first = source.first, format.streamDescription.pointee.mBytesPerFrame > 0 else { return }
        let frameCount = Int(first.mDataByteSize) / Int(format.streamDescription.pointee.mBytesPerFrame)
        guard frameCount > 0, frameCount <= 96_000,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frameCount)) else { return }
        buffer.frameLength = AVAudioFrameCount(frameCount)
        let destination = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        guard destination.count == source.count else { return }
        for index in 0..<source.count {
            guard let from = source[index].mData, let to = destination[index].mData,
                  source[index].mDataByteSize <= destination[index].mDataByteSize else { return }
            memcpy(to, from, Int(source[index].mDataByteSize))
        }
        let capacity = AVAudioFrameCount(ceil(Double(frameCount) * 48_000 / format.sampleRate) + 64)
        guard let converted = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return }
        var supplied = false, error: NSError?
        let result = converter.convert(to: converted, error: &error) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true; status.pointee = .haveData; return buffer
        }
        guard result != .error, error == nil, let channels = converted.floatChannelData else {
            accepting = false; onFailure?("System audio conversion stopped; use Retry Audio in the helper menu."); return
        }
        var pcm = Data(capacity: Int(converted.frameLength) * 4)
        for frame in 0..<Int(converted.frameLength) {
            for channel in 0..<2 {
                var value = pcm16(channels[channel][frame]).littleEndian
                withUnsafeBytes(of: &value) { pcm.append(contentsOf: $0) }
            }
        }
        for chunk in chunker.append(pcm) { onChunk?(chunk, token, Date()) }
    }
}

// This graph never accesses inputNode. Its only output is the exact BlackHole UID.
@MainActor private final class VirtualMicrophone {
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var queued = 0
    private var serial = 0
    private var device: AudioDeviceID = 0
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
    func start() throws {
        if engine != nil { return }
        guard let target = blackHoleDevice() else { throw AudioError.message("BlackHole 2ch is not available. Finish its installation and restart the Mac if requested.") }
        let next = AVAudioEngine()
        let output = next.outputNode
        guard let unit = output.audioUnit else { throw AudioError.message("The virtual microphone output is unavailable.") }
        var selected = target
        guard AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &selected, UInt32(MemoryLayout<AudioDeviceID>.size)) == noErr else {
            throw AudioError.message("Could not select BlackHole 2ch. Mac speakers were not selected.")
        }
        var checked: AudioDeviceID = 0; var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &checked, &size) == noErr,
              checked == target, stringProperty(checked, kAudioDevicePropertyDeviceUID) == "BlackHole2ch_UID" else {
            throw AudioError.message("The virtual microphone device could not be verified.")
        }
        let source = AVAudioPlayerNode()
        next.attach(source); next.connect(source, to: next.mainMixerNode, format: format)
        next.prepare(); try next.start(); source.play()
        engine = next; player = source; device = target; queued = 0; serial += 1
    }
    func stop() {
        serial += 1; player?.stop(); engine?.stop(); engine = nil; player = nil; queued = 0; device = 0
    }
    func play(_ pcm: Data) throws {
        guard pcm.count == 6_400 else { throw AudioError.message("Invalid remote microphone packet.") }
        guard engine != nil, let player, blackHoleDevice() == device else {
            stop(); throw AudioError.message("BlackHole 2ch disconnected; remote microphone stopped.")
        }
        if queued >= 3 { player.stop(); queued = 0; serial += 1; player.play() }
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 3_200), let samples = buffer.floatChannelData?[0] else { return }
        buffer.frameLength = 3_200
        pcm.withUnsafeBytes { raw in
            for index in 0..<3_200 {
                let value = Int16(bitPattern: UInt16(raw[index * 2]) | UInt16(raw[index * 2 + 1]) << 8)
                samples[index] = Float(value) / 32_768
            }
        }
        queued += 1; let generation = serial
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in
                if let self, self.serial == generation { self.queued = max(0, self.queued - 1) }
            }
        }
    }
}

@MainActor private final class AudioAgent: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var relay: Relay?
    private let capture = SystemSoundCapture()
    private let microphone = VirtualMicrophone()
    private var statusItem: NSStatusItem?
    private var setupWindow: NSWindow?
    private var setupMessage: NSTextField?
    private var setupButton: NSButton?
    private var permissionRequestRunning = false
    private var loop: Task<Void, Never>?
    private var epoch = ""
    private var outputGeneration = ""
    private var inputGeneration = ""
    private var outputSequence = 0
    private var inputSequence = 0
    private var soundEnabled = false
    private var micEnabled = false
    private var captureRunning = false
    private var captureStarting = false
    private var suspended = false
    private var sleepingState = false
    // Never reset this count on stop or generation changes. Each old request
    // retains its reservation until its own defer releases it.
    private var uploadInFlight = 0
    private var uploadToken = UUID()
    private var latestStateAt = Date.distantPast
    private var lastStatus = Date.distantPast
    private var message = "Waiting for the desktop relay."
    private var captureFailure = false
    private var sinkFailure = false
    private var failedSinkDevice: AudioDeviceID?

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem?.button?.image = NSImage(systemSymbolName: "speaker.wave.2", accessibilityDescription: "Schaffer Desktop Audio")
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Schaffer Desktop Audio", action: nil, keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Audio Setup…", action: #selector(showSetup), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Enable System Sound…", action: #selector(requestPermission), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Open Audio Permissions…", action: #selector(openPermissions), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Retry Audio", action: #selector(retryAudio), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Pause Audio", action: #selector(togglePause), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Audio Helper", action: #selector(quit), keyEquivalent: "q"))
        for item in menu.items { item.target = self }
        statusItem?.menu = menu
        do {
            let arguments = CommandLine.arguments
            let path: String
            if let index = arguments.firstIndex(of: "--config"), index + 1 < arguments.count { path = arguments[index + 1] }
            else { path = NSHomeDirectory() + "/Library/Application Support/SchafferDesktop/config.json" }
            let config = try JSONDecoder().decode(Configuration.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
            relay = try Relay(config)
        } catch { message = "Private desktop configuration is unavailable."; updateMenu(); return }
        capture.onChunk = { [weak self] pcm, token, capturedAt in Task { @MainActor in await self?.upload(pcm, token: token, capturedAt: capturedAt) } }
        capture.onFailure = { [weak self] text in Task { @MainActor in
            guard let self else { return }
            self.message = text; self.captureFailure = true; self.captureRunning = false
            self.soundEnabled = false; self.uploadToken = UUID()
            await self.capture.stop(); await self.report(); self.updateMenu()
        } }
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(sleeping), name: NSWorkspace.willSleepNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(waking), name: NSWorkspace.didWakeNotification, object: nil)
        DistributedNotificationCenter.default().addObserver(self, selector: #selector(screenLocked), name: NSNotification.Name("com.apple.screenIsLocked"), object: nil)
        if !capture.enabled { showSetup() }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.poll()
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
        }
    }
    @objc private func showSetup() {
        NSApplication.shared.setActivationPolicy(.regular)
        if setupWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 490, height: 235),
                styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = "Schaffer Desktop Audio"
            window.isReleasedWhenClosed = false
            window.delegate = self
            window.center()
            let title = NSTextField(labelWithString: "Enable your Mac’s sound in the portal")
            title.font = .boldSystemFont(ofSize: 18)
            title.frame = NSRect(x: 24, y: 178, width: 442, height: 28)
            let detail = NSTextField(wrappingLabelWithString: "Enable system sound, then allow the normal macOS audio request. Sound is sent only when a connected visitor turns on Sound in the portal. Your Mac’s microphone and speaker settings stay unchanged.")
            detail.frame = NSRect(x: 24, y: 82, width: 442, height: 88)
            let button = NSButton(title: "Enable System Sound", target: self, action: #selector(requestPermission))
            button.bezelStyle = .rounded
            button.frame = NSRect(x: 24, y: 25, width: 180, height: 34)
            window.contentView?.addSubview(title); window.contentView?.addSubview(detail); window.contentView?.addSubview(button)
            setupWindow = window; setupMessage = detail; setupButton = button
        }
        setupWindow?.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
    func windowWillClose(_ notification: Notification) {
        if notification.object as? NSWindow === setupWindow {
            NSApplication.shared.setActivationPolicy(.accessory)
        }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showSetup() }
        return true
    }
    @objc private func retryAudio() {
        sinkFailure = false; failedSinkDevice = nil
        requestPermission()
    }
    @objc private func requestPermission() {
        guard !permissionRequestRunning else { return }
        permissionRequestRunning = true; setupButton?.isEnabled = false
        setupMessage?.stringValue = "macOS may show its system-audio permission request. This setup check discards audio and never uploads it."
        Task {
            await stopAll()
            do {
                try await capture.requestPermission(); captureFailure = false
                message = "System audio engine is ready."
                setupMessage?.stringValue = "System audio is enabled. Connect at schafferai.com/desktop/ and turn on Sound to hear this Mac."
            } catch {
                captureFailure = true; message = error.localizedDescription
                setupMessage?.stringValue = message
            }
            permissionRequestRunning = false; setupButton?.isEnabled = true
            lastStatus = .distantPast; await report(); updateMenu()
        }
    }
    @objc private func openPermissions() { NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!) }
    @objc private func togglePause(_ sender: NSMenuItem) {
        suspended.toggle(); sender.title = suspended ? "Resume Audio" : "Pause Audio"
        Task { await stopAll(); lastStatus = .distantPast }
    }
    @objc private func sleeping() { sleepingState = true; Task { await stopAll(); await report(ready: false) } }
    @objc private func waking() { sleepingState = false; captureFailure = false; lastStatus = .distantPast }
    @objc private func screenLocked() { Task { await stopAll(); await report(ready: false); lastStatus = .distantPast } }
    @objc private func quit() { loop?.cancel(); Task { await stopAll(); await report(ready: false); NSApplication.shared.terminate(nil) } }
    func applicationWillTerminate(_ notification: Notification) { loop?.cancel(); microphone.stop() }
    private func updateMenu() {
        statusItem?.button?.toolTip = message
        statusItem?.menu?.items.first?.title = message
    }
    private func stopAll() async {
        soundEnabled = false; micEnabled = false; uploadToken = UUID()
        captureRunning = false; microphone.stop()
        await capture.stop()
    }
    private func capability() -> (Bool, Bool) {
        let allowed = !suspended && !sleepingState && !locked()
        return (allowed && capture.enabled && !captureFailure, allowed && blackHoleDevice() != nil && !sinkFailure)
    }
    private func report(ready: Bool = true) async {
        guard let relay, !epoch.isEmpty else { return }
        let caps = capability()
        _ = try? await relay.request("/agent/audio/status", body: ["epoch": epoch, "status": [
            "captureReady": ready && caps.0, "microphoneReady": ready && caps.1,
            "virtualInputName": blackHoleDevice() == nil ? "" : "BlackHole 2ch", "message": message
        ]])
        lastStatus = Date()
    }
    private func poll() async {
        guard let relay else { return }
        if permissionRequestRunning {
            if suspended || sleepingState || locked() { await stopAll() }
            return
        }
        do {
            let state = try await relay.request("/agent/audio-state")
            guard let nextEpoch = state["epoch"] as? String, !nextEpoch.isEmpty else {
                await stopAll(); epoch = ""; message = "Waiting for the desktop Mac."; updateMenu(); return
            }
            let newOutput = state["outputGeneration"] as? String ?? ""
            let newInput = state["inputGeneration"] as? String ?? ""
            if nextEpoch != epoch {
                await stopAll(); epoch = nextEpoch; outputGeneration = ""; inputGeneration = ""; lastStatus = .distantPast
            }
            if newOutput != outputGeneration {
                soundEnabled = false; captureRunning = false; uploadToken = UUID()
                await capture.stop(); outputGeneration = newOutput
                outputSequence = (state["outputSequence"] as? NSNumber)?.intValue ?? 0
            }
            if newInput != inputGeneration {
                micEnabled = false; microphone.stop(); inputGeneration = newInput
                inputSequence = 0
            }
            latestStateAt = Date()
            let healthy = state["videoHealthy"] as? Bool == true && state["videoReady"] as? Bool == true && state["unlocked"] as? Bool == true && !suspended && !sleepingState && !locked()
            if sinkFailure && blackHoleDevice() != failedSinkDevice { sinkFailure = false; failedSinkDevice = nil }
            let caps = capability()
            let wantsSound = healthy && caps.0 && ((state["soundViewers"] as? NSNumber)?.intValue ?? 0) > 0 && !outputGeneration.isEmpty
            let wantsMic = healthy && caps.1 && state["micActive"] as? Bool == true && !inputGeneration.isEmpty
            if !healthy {
                await stopAll(); message = suspended ? "Desktop audio is paused." : "Desktop audio stops while the Mac is locked or unavailable."
            } else {
                if wantsSound && !captureRunning && !captureStarting {
                    captureStarting = true
                    let requestedToken = uploadToken; let requestedEpoch = epoch; let requestedGeneration = outputGeneration
                    do {
                        try await capture.start(token: requestedToken)
                        if requestedToken == uploadToken && requestedEpoch == epoch && requestedGeneration == outputGeneration && !locked() && !suspended && !sleepingState && Date().timeIntervalSince(latestStateAt) < 1.2 {
                            captureRunning = true; soundEnabled = true
                        } else {
                            soundEnabled = false; captureRunning = false; await capture.stop()
                        }
                    } catch {
                        captureFailure = true; soundEnabled = false; message = "Enable System Sound from the Schaffer Desktop Audio menu, then allow its system audio request."
                    }
                    captureStarting = false
                } else if !wantsSound && (captureRunning || soundEnabled) {
                    soundEnabled = false; captureRunning = false; uploadToken = UUID(); await capture.stop()
                }
                if wantsMic {
                    do { try microphone.start(); micEnabled = true }
                    catch {
                        micEnabled = false; microphone.stop(); sinkFailure = true; failedSinkDevice = blackHoleDevice()
                        message = "Remote microphone stopped. Use Retry Audio after checking BlackHole 2ch."
                        await report()
                    }
                    if micEnabled { try await receiveMicrophone() }
                } else if micEnabled { micEnabled = false; microphone.stop() }
                if !caps.0 { message = "Enable System Sound from the Schaffer Desktop Audio menu, then allow its system audio request." }
                else if sinkFailure { message = "Remote microphone stopped. Use Retry Audio after checking BlackHole 2ch." }
                else if !caps.1 { message = "Install BlackHole 2ch to use the remote microphone." }
                else if captureFailure { message = "System audio needs permission or Retry Audio from the helper menu." }
                else { message = "Audio ready. Select BlackHole 2ch as the microphone in Mac apps." }
            }
            if Date().timeIntervalSince(lastStatus) >= 2 { await report() }
            updateMenu()
        } catch {
            await stopAll(); message = "Audio relay unavailable; audio stopped."; updateMenu()
        }
    }
    private func upload(_ pcm: Data, token: UUID, capturedAt: Date) async {
        guard let relay, soundEnabled, captureRunning, uploadInFlight < 3, !locked(), !suspended, !sleepingState,
              token == uploadToken, Date().timeIntervalSince(capturedAt) < 0.4,
              Date().timeIntervalSince(latestStateAt) < 1.2, pcm.count == 38_400, !epoch.isEmpty, !outputGeneration.isEmpty else { return }
        uploadInFlight += 1
        let activeToken = uploadToken; let generation = outputGeneration; let sentEpoch = epoch
        outputSequence += 1; let sequence = outputSequence
        defer { uploadInFlight -= 1 }
        do {
            _ = try await relay.request("/agent/audio", body: ["epoch": sentEpoch, "generation": generation, "seq": sequence,
                "sampleRate": 48_000, "channels": 2, "encoding": "s16le", "pcm": pcm.base64EncodedString()])
        } catch {
            if activeToken == uploadToken { message = "A system audio packet was dropped; waiting for a fresh packet." }
        }
    }
    private func receiveMicrophone() async throws {
        guard let relay, micEnabled, !locked(), !suspended, !sleepingState else { return }
        let generation = inputGeneration; let sentEpoch = epoch; let requestedAt = Date()
        let response = try await relay.request("/agent/microphone", query: ["epoch": sentEpoch, "generation": generation, "after": String(inputSequence)])
        guard micEnabled, generation == inputGeneration, sentEpoch == epoch,
              response["epoch"] as? String == sentEpoch, response["generation"] as? String == generation,
              (response["sampleRate"] as? NSNumber)?.intValue == 16_000,
              (response["channels"] as? NSNumber)?.intValue == 1,
              response["encoding"] as? String == "s16le",
              let chunks = response["chunks"] as? [[String: Any]], chunks.count <= 6,
              !locked(), !suspended, !sleepingState else { return }
        for chunk in chunks {
            guard let seq = (chunk["seq"] as? NSNumber)?.intValue, seq > inputSequence,
                  let age = (chunk["ageMs"] as? NSNumber)?.doubleValue, age >= 0, age <= 1_200,
                  let encoded = chunk["pcm"] as? String, encoded.count <= 8_536,
                  let pcm = Data(base64Encoded: encoded), pcm.count == 6_400 else { continue }
            // Skip backlog: only the last 600 ms can reach the virtual input.
            inputSequence = seq
            if age + Date().timeIntervalSince(requestedAt) * 1_000 <= 600 {
                do { try microphone.play(pcm) }
                catch {
                    micEnabled = false; microphone.stop(); sinkFailure = true; failedSinkDevice = blackHoleDevice()
                    message = "Remote microphone stopped. Use Retry Audio after checking BlackHole 2ch."
                    await report(); return
                }
            }
        }
    }
}

private func selfTest() throws {
    try SystemSoundCapture.offlineConversionTest()
    guard pcm16(1) == 32_767, pcm16(-1) == -32_768, pcm16(.nan) == 0, pcm16(0) == 0 else { throw AudioError.message("PCM conversion failed.") }
    let chunker = PCMChunker()
    guard chunker.append(Data(repeating: 0, count: 20_000)).isEmpty,
          chunker.append(Data(repeating: 0, count: 18_400)).first?.count == 38_400 else { throw AudioError.message("PCM packetization failed.") }
    chunker.reset()
    guard chunker.append(Data(repeating: 1, count: 76_800)).count == 2 else { throw AudioError.message("PCM buffering failed.") }
    let configuration = Configuration(relayUrl: "https://example.com", producerKey: String(repeating: "a", count: 32))
    guard try configuration.baseURL().scheme == "https" else { throw AudioError.message("HTTPS configuration failed.") }
    do { _ = try Configuration(relayUrl: "https://user@example.com", producerKey: String(repeating: "a", count: 32)).baseURL(); throw AudioError.message("Credential URL accepted.") }
    catch AudioError.message(let message) where message == "The private HTTPS desktop configuration is invalid." {}
    print("PASS: 44.1→48 kHz stereo conversion, PCM clipping, chunk boundaries, reset and secure configuration. No audio device was opened.")
}

if CommandLine.arguments.contains("--self-test") {
    do { try selfTest() } catch { fputs("Audio self-test failed.\n", stderr); exit(1) }
} else if CommandLine.arguments.contains("--capabilities") {
    let result: [String: Any] = ["systemAudioEnabled": UserDefaults.standard.bool(forKey: "systemAudioEngineWasEnabled"), "audioProcessIdentityAvailable": ownAudioProcess() != nil, "virtualInputName": blackHoleDevice() == nil ? "" : "BlackHole 2ch", "locked": locked()]
    let bytes = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    print(String(data: bytes, encoding: .utf8)!)
} else {
    MainActor.assumeIsolated {
        let application = NSApplication.shared
        let delegate = AudioAgent()
        application.delegate = delegate
        application.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) { application.run() }
    }
}
