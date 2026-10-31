import Foundation

/// Speaks units one after another on Talk's audio: synthesizes ahead (up to
/// ``lookAheadUnits`` sentences after the one playing, or
/// ``lookAheadSeconds`` of queued audio), queues each chunk as it comes so
/// the first sound is early, and says when each unit starts and when
/// everything handed over was heard.
///
/// - The first unit of a reply is synthesized with a short first chunk
///   (``SpeechUnit/isFirstOfReply``; the synthesizer cuts it at a comma).
/// - ``stopAfterCurrent()`` lets the unit playing finish and drops the rest;
///   ``stop()`` drops everything now.
/// - After the audio engine was rebuilt (a route change drops what was
///   queued), ``respeak()`` says the current unit again from its start.
@MainActor
final class SentenceSpeaker {
    private struct Item {
        let serial: Int
        let unit: SpeechUnit
        var chunks: [SpeechChunk] = []
        var synthesized = false
        var scheduled = 0
        var played = 0
        var announced = false
        /// When its synthesis began (telemetry: time to first audio).
        var synthesisStart: TimeInterval?
    }

    /// Sentences synthesized ahead of the one playing.
    var lookAheadUnits = 2
    /// Audio queued ahead of what plays, at most.
    var lookAheadSeconds: TimeInterval = 8

    /// A unit started playing.
    var onUnitStarted: ((SpeechUnit) -> Void)?
    /// Everything handed over was heard (not called after ``stop()``).
    var onFinished: (() -> Void)?
    /// A unit's first audio came out of the synthesizer, after `latency`
    /// seconds.
    var onFirstAudio: ((SpeechUnit, TimeInterval) -> Void)?
    /// A unit couldn't be synthesized.
    var onFailure: ((SpeechUnit, Error) -> Void)?

    private let audio: TalkAudioIO
    private let synthesizer: Synthesizer
    private let clock: TalkClock
    private var items: [Item] = []
    private var nextSerial = 0
    private var generation = 0
    private var synthesizing = false
    private var outstanding = 0
    private var queuedSeconds: TimeInterval = 0
    private var stopAfterFirst = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    /// The RMS of the unit playing, for the orb (0 when quiet).
    private(set) var level: Float = 0

    init(audio: TalkAudioIO, synthesizer: Synthesizer, clock: TalkClock) {
        self.audio = audio
        self.synthesizer = synthesizer
        self.clock = clock
    }

    /// Something is being spoken or waits to be.
    var isActive: Bool { !items.isEmpty }

    /// The unit playing now, if any.
    var current: SpeechUnit? {
        guard let first = items.first, first.announced else { return nil }
        return first.unit
    }

    // MARK: - Handing units over

    func enqueue(_ units: [SpeechUnit]) {
        guard !units.isEmpty else { return }
        for unit in units {
            nextSerial += 1
            items.append(Item(serial: nextSerial, unit: unit))
        }
        startSynthesis()
    }

    /// Stop now and drop everything.
    func stop() {
        generation &+= 1
        synthesizing = false
        items = []
        outstanding = 0
        queuedSeconds = 0
        stopAfterFirst = false
        level = 0
        audio.stopSpeech()
        wakeWaiters()
    }

    /// Let the unit playing finish, then stop; nothing after it is said.
    func stopAfterCurrent() {
        guard let first = items.first else {
            onFinished?()
            return
        }
        if items.count > 1 { items.removeSubrange(1...) }
        if first.synthesized, first.played >= first.chunks.count, first.scheduled == first.chunks.count {
            // It was heard already (nothing left to wait for).
            finishFirst()
            return
        }
        stopAfterFirst = true
        wakeWaiters()
    }

    /// The audio engine was rebuilt and dropped what was queued: say the
    /// current unit again from its start, then the rest.
    func respeak() {
        guard !items.isEmpty else { return }
        generation &+= 1
        synthesizing = false
        outstanding = 0
        queuedSeconds = 0
        for index in items.indices {
            if !items[index].synthesized { items[index].chunks = [] }
            items[index].scheduled = 0
            items[index].played = 0
            items[index].announced = false
        }
        wakeWaiters()
        for index in items.indices {
            guard items[index].synthesized else { break }
            for chunk in items[index].chunks { schedule(chunk, serial: items[index].serial) }
        }
        startSynthesis()
    }

    // MARK: - Synthesis

    private func startSynthesis() {
        guard !synthesizing else { return }
        synthesizing = true
        let gen = generation
        Task { @MainActor [weak self] in await self?.synthesize(generation: gen) }
    }

    private func synthesize(generation gen: Int) async {
        defer { if gen == generation { synthesizing = false } }
        while gen == generation {
            guard let position = items.firstIndex(where: { !$0.synthesized }) else { return }
            let serial = items[position].serial
            while gen == generation, let index = index(of: serial), !mayStart(index) {
                await waitForProgress()
            }
            guard gen == generation, let index = index(of: serial) else { return }
            let unit = items[index].unit
            items[index].synthesisStart = clock.now()
            var first = true
            do {
                for try await chunk in synthesizer.synthesize(unit) {
                    guard gen == generation, let at = self.index(of: serial) else { return }
                    guard !chunk.samples.isEmpty else { continue }
                    if first, let started = items[at].synthesisStart {
                        first = false
                        onFirstAudio?(unit, clock.now() - started)
                    }
                    items[at].chunks.append(chunk)
                    schedule(chunk, serial: serial)
                }
            } catch {
                guard gen == generation else { return }
                onFailure?(unit, error)
            }
            guard gen == generation, let at = self.index(of: serial) else { return }
            items[at].synthesized = true
            if items[at].chunks.isEmpty || items[at].played >= items[at].chunks.count && items[at].scheduled > 0 {
                // Nothing to hear (it failed or was empty), or already heard.
                if at == 0 { finishFirst() } else if items[at].chunks.isEmpty { items.remove(at: at) }
            }
        }
    }

    /// Whether the unit at `index` may be synthesized now.
    private func mayStart(_ index: Int) -> Bool {
        if index == 0 { return true }
        if stopAfterFirst { return false }
        return index <= lookAheadUnits && queuedSeconds < lookAheadSeconds
    }

    private func waitForProgress() async {
        await withCheckedContinuation { continuation in waiters.append(continuation) }
    }

    private func wakeWaiters() {
        let waiting = waiters
        waiters = []
        for waiter in waiting { waiter.resume() }
    }

    private func index(of serial: Int) -> Int? {
        items.firstIndex { $0.serial == serial }
    }

    // MARK: - Playing

    private func schedule(_ chunk: SpeechChunk, serial: Int) {
        guard let index = index(of: serial) else { return }
        let wasQuiet = outstanding == 0
        items[index].scheduled += 1
        outstanding += 1
        queuedSeconds += chunk.duration
        let gen = generation
        let duration = chunk.duration
        audio.schedule(chunk.samples, sampleRate: chunk.sampleRate) { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.played(serial: serial, duration: duration, generation: gen)
            }
        }
        if index == 0, wasQuiet, !items[0].announced { announceFirst() }
    }

    private func played(serial: Int, duration: TimeInterval, generation gen: Int) {
        guard gen == generation, let index = index(of: serial) else { return }
        outstanding = max(0, outstanding - 1)
        queuedSeconds = max(0, queuedSeconds - duration)
        items[index].played += 1
        wakeWaiters()
        guard index == 0 else { return }
        let first = items[0]
        if first.synthesized, first.played >= first.chunks.count {
            finishFirst()
        }
    }

    /// The first unit was heard to its end: on to the next, or done.
    private func finishFirst() {
        guard !items.isEmpty else { return }
        items.removeFirst()
        if stopAfterFirst {
            stopAfterFirst = false
            if !items.isEmpty || outstanding > 0 {
                generation &+= 1
                synthesizing = false
                items = []
                outstanding = 0
                queuedSeconds = 0
                audio.stopSpeech()
            }
            level = 0
            wakeWaiters()
            onFinished?()
            return
        }
        // Units that came to nothing are passed over.
        while let first = items.first, first.synthesized, first.chunks.isEmpty { items.removeFirst() }
        guard !items.isEmpty else {
            level = 0
            wakeWaiters()
            onFinished?()
            return
        }
        if items[0].scheduled > 0 { announceFirst() }
        wakeWaiters()
    }

    private func announceFirst() {
        guard !items.isEmpty, !items[0].announced else { return }
        items[0].announced = true
        level = Self.rms(items[0].chunks)
        onUnitStarted?(items[0].unit)
    }

    private static func rms(_ chunks: [SpeechChunk]) -> Float {
        var sum: Float = 0
        var count = 0
        for chunk in chunks.prefix(2) {
            for sample in chunk.samples {
                sum += sample * sample
            }
            count += chunk.samples.count
        }
        return count > 0 ? (sum / Float(count)).squareRoot() : 0
    }
}
