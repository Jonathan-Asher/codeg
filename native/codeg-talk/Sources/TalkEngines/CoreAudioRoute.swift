@testable import TalkHost
import CoreAudio
import Foundation

/// The Mac's audio route from Core Audio: the default input and output
/// devices, their transport types and the built-in output's data source
/// (speakers or the headphone jack), with listeners for changes.
@MainActor
final class CoreAudioRoute {
    private var onChange: (@MainActor () -> Void)?
    private var listening = false
    /// The output device whose data source is watched.
    private var watchedOutput: AudioDeviceID?

    private let defaultInputAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    private let defaultOutputAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    private let dataSourceAddress = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDataSource, mScope: kAudioDevicePropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain)

    /// One block for every listener: Core Audio removes a listener by the
    /// block it was added with.
    private lazy var listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
        // Delivered on the main queue (see `start`).
        MainActor.assumeIsolated { self?.changed() }
    }

    /// The route now.
    nonisolated static func current() -> MacRoute {
        MacRoute(input: device(defaultDevice(kAudioHardwarePropertyDefaultInputDevice), output: false),
                 output: device(defaultDevice(kAudioHardwarePropertyDefaultOutputDevice), output: true))
    }

    /// Call `onChange` (on the main actor) when the default input or output
    /// device changes, or the built-in output switches between speakers and
    /// headphones.
    func start(_ onChange: @escaping @MainActor () -> Void) {
        self.onChange = onChange
        guard !listening else { return }
        listening = true
        var input = defaultInputAddress
        var output = defaultOutputAddress
        AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &input, .main, listener)
        AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &output, .main, listener)
        watchOutputDataSource()
    }

    func stop() {
        onChange = nil
        guard listening else { return }
        listening = false
        var input = defaultInputAddress
        var output = defaultOutputAddress
        AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &input, .main, listener)
        AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &output, .main, listener)
        unwatchOutputDataSource()
    }

    private func changed() {
        watchOutputDataSource()
        onChange?()
    }

    /// Follow the data source of the current default output (the headphone
    /// jack), if it has one.
    private func watchOutputDataSource() {
        let output = Self.defaultDevice(kAudioHardwarePropertyDefaultOutputDevice)
        guard output != watchedOutput else { return }
        unwatchOutputDataSource()
        guard let output else { return }
        var address = dataSourceAddress
        guard AudioObjectHasProperty(output, &address) else { return }
        if AudioObjectAddPropertyListenerBlock(output, &address, .main, listener) == noErr {
            watchedOutput = output
        }
    }

    private func unwatchOutputDataSource() {
        guard let device = watchedOutput else { return }
        var address = dataSourceAddress
        AudioObjectRemovePropertyListenerBlock(device, &address, .main, listener)
        watchedOutput = nil
    }

    // MARK: - Reading Core Audio

    nonisolated static func defaultDevice(_ selector: AudioObjectPropertySelector) -> AudioDeviceID? {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        var device = AudioDeviceID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
        guard status == noErr, device != kAudioObjectUnknown else { return nil }
        return device
    }

    nonisolated static func device(_ id: AudioDeviceID?, output: Bool) -> MacDevice? {
        guard let id else { return nil }
        let transport = uint32(id, kAudioDevicePropertyTransportType, scope: kAudioObjectPropertyScopeGlobal) ?? 0
        let source = output ? uint32(id, kAudioDevicePropertyDataSource, scope: kAudioDevicePropertyScopeOutput) : nil
        return MacDevice(id: id, transport: MacTransport(code: transport), dataSource: source, name: name(id))
    }

    nonisolated private static func uint32(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector,
                                           scope: AudioObjectPropertyScope) -> UInt32? {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: scope,
                                                 mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectHasProperty(id, &address) else { return nil }
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr else { return nil }
        return value
    }

    nonisolated private static func name(_ id: AudioObjectID) -> String? {
        var address = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName,
                                                 mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        var name: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &name) == noErr,
              let value = name?.takeRetainedValue() else { return nil }
        return value as String
    }
}
