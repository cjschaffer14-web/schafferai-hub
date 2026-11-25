import AppKit
import ApplicationServices
import AudioToolbox
import AVFoundation
import CoreAudio
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

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
        request.setValue("SchafferDesktopAudio/1.0", forHTTPHeaderField: "User-Agent")
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

private final class SystemSoundCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private let queue = DispatchQueue(label: "com.schafferai.desktop-audio.samples")
    private let chunker = PCMChunker()
    private var accepting = false
    private var token = UUID()
    var onChunk: ((Data, UUID, Date) -> Void)?
    var onFailure: ((String) -> Void)?

    @MainActor func start(token: UUID) async throws {
        guard stream == nil else { return }
        guard CGPreflightScreenCaptureAccess() else { throw AudioError.message("Enable System Audio Recording for Schaffer Desktop Audio in macOS Settings.") }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
            throw AudioError.message("No desktop display is available for system audio.")
        }
        let config = SCStreamConfiguration()
        config.width = 2; config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.queueDepth = 3; config.showsCursor = false
        config.capturesAudio = true; config.sampleRate = 48_000; config.channelCount = 2
        config.excludesCurrentProcessAudio = true
        let capture = SCStream(filter: SCContentFilter(display: display, excludingApplications: [], exceptingWindows: []), configuration: config, delegate: self)
        try capture.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        queue.sync { self.chunker.reset(); self.token = token; self.accepting = true }
        stream = capture
        do { try await capture.startCapture() }
        catch { stream = nil; queue.sync { self.accepting = false; self.chunker.reset() }; throw error }
    }
    @MainActor func stop() async {
        queue.sync { self.accepting = false; self.chunker.reset() }
        let previous = stream; stream = nil
        try? await previous?.stopCapture()
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.async { self.accepting = false; self.chunker.reset() }
        onFailure?("System audio capture stopped. Check macOS System Audio Recording permission.")
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, accepting, CMSampleBufferDataIsReady(sampleBuffer),
              let description = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee,
              asbd.mFormatID == kAudioFormatLinearPCM, asbd.mSampleRate == 48_000, asbd.mChannelsPerFrame == 2 else { return }
        var required = 0
        var block: CMBlockBuffer?
        guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sampleBuffer, bufferListSizeNeededOut: &required,
            bufferListOut: nil, bufferListSize: 0, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment), blockBufferOut: &block) == noErr else { return }
        let memory = UnsafeMutableRawPointer.allocate(byteCount: max(required, MemoryLayout<AudioBufferList>.size), alignment: 16)
        defer { memory.deallocate() }
        let list = memory.bindMemory(to: AudioBufferList.self, capacity: 1)
        guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sampleBuffer, bufferListSizeNeededOut: nil,
            bufferListOut: list, bufferListSize: required, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment), blockBufferOut: &block) == noErr else { return }
        let buffers = UnsafeMutableAudioBufferListPointer(list)
        let frames = CMSampleBufferGetNumSamples(sampleBuffer)
        let planar = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        let isFloat = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
        guard frames > 0, frames <= 48_000, (planar ? buffers.count >= 2 : buffers.count >= 1) else { return }
        var pcm = Data(capacity: frames * 4)
        for frame in 0..<frames {
            for channel in 0..<2 {
                let buffer = buffers[planar ? channel : 0]
                let index = planar ? frame : frame * 2 + channel
                var value: Int16
                if isFloat && asbd.mBitsPerChannel == 32, let data = buffer.mData, (index + 1) * 4 <= Int(buffer.mDataByteSize) {
                    value = pcm16(data.assumingMemoryBound(to: Float.self)[index])
                } else if !isFloat && asbd.mBitsPerChannel == 16, let data = buffer.mData, (index + 1) * 2 <= Int(buffer.mDataByteSize) {
                    value = data.assumingMemoryBound(to: Int16.self)[index]
                } else { return }
                var little = value.littleEndian
                withUnsafeBytes(of: &little) { pcm.append(contentsOf: $0) }
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

@MainActor private final class AudioAgent: NSObject, NSApplicationDelegate {
    private var relay: Relay?
    private let capture = SystemSoundCapture()
    private let microphone = VirtualMicrophone()
    private var statusItem: NSStatusItem?
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
    private var uploadBusy = false
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
        menu.addItem(NSMenuItem(title: "Request System Audio Permission…", action: #selector(requestPermission), keyEquivalent: ""))
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
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.poll()
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
        }
    }
    @objc private func retryAudio() {
        Task {
            await stopAll(); captureFailure = false; sinkFailure = false; failedSinkDevice = nil; lastStatus = .distantPast
        }
    }
    @objc private func requestPermission() { _ = CGRequestScreenCaptureAccess(); captureFailure = false; lastStatus = .distantPast }
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
        return (allowed && CGPreflightScreenCaptureAccess() && !captureFailure, allowed && blackHoleDevice() != nil && !sinkFailure)
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
                        captureFailure = true; soundEnabled = false; message = "Enable System Audio Recording for Schaffer Desktop Audio in macOS Settings."
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
                if !caps.0 { message = "Enable System Audio Recording for Schaffer Desktop Audio in macOS Settings." }
                else if sinkFailure { message = "Remote microphone stopped. Use Retry Audio after checking BlackHole 2ch." }
                else if !caps.1 { message = "Install BlackHole 2ch to use the remote microphone." }
                else if captureFailure { message = "System audio needs permission or a helper relaunch." }
                else { message = "Audio ready. Select BlackHole 2ch as the microphone in Mac apps." }
            }
            if Date().timeIntervalSince(lastStatus) >= 2 { await report() }
            updateMenu()
        } catch {
            await stopAll(); message = "Audio relay unavailable; audio stopped."; updateMenu()
        }
    }
    private func upload(_ pcm: Data, token: UUID, capturedAt: Date) async {
        guard let relay, soundEnabled, captureRunning, !uploadBusy, !locked(), !suspended, !sleepingState,
              token == uploadToken, Date().timeIntervalSince(capturedAt) < 0.4,
              Date().timeIntervalSince(latestStateAt) < 1.2, pcm.count == 38_400, !epoch.isEmpty, !outputGeneration.isEmpty else { return }
        uploadBusy = true
        let activeToken = uploadToken; let generation = outputGeneration; let sentEpoch = epoch
        outputSequence += 1; let sequence = outputSequence
        defer { uploadBusy = false }
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
    print("PASS: PCM clipping, non-finite samples, chunk boundaries, buffer reset and secure configuration. No audio device was opened.")
}

if CommandLine.arguments.contains("--self-test") {
    do { try selfTest() } catch { fputs("Audio self-test failed.\n", stderr); exit(1) }
} else if CommandLine.arguments.contains("--capabilities") {
    let result: [String: Any] = ["screenRecording": CGPreflightScreenCaptureAccess(), "virtualInputName": blackHoleDevice() == nil ? "" : "BlackHole 2ch", "locked": locked()]
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
