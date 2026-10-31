import XCTest
@testable import Codeg

/// Synthetic 32 ms tracks of speech probability (and RMS) for the policies.
private enum Track {
    static let frame = 0.032

    /// `count` frames of probability `p`.
    static func run(_ p: Float, _ count: Int) -> [Float] { Array(repeating: p, count: count) }

    /// Feed `probabilities` from frame `startFrame`; every decision (times
    /// rounded to the microsecond) with the index of the frame that made it.
    static func feed(_ policy: inout EndOfTurnPolicy, _ probabilities: [Float],
                     from startFrame: Int = 0) -> [(frame: Int, decision: EndOfTurnDecision)] {
        var out: [(Int, EndOfTurnDecision)] = []
        for (i, p) in probabilities.enumerated() {
            let index = startFrame + i
            if let decision = policy.frame(probability: p, at: Double(index) * frame) {
                out.append((index, rounded(decision)))
            }
        }
        return out
    }

    /// A decision with its time rounded to the microsecond, so frame sums
    /// compare exactly.
    static func rounded(_ decision: EndOfTurnDecision) -> EndOfTurnDecision {
        func r(_ t: TimeInterval) -> TimeInterval { (t * 1e6).rounded() / 1e6 }
        switch decision {
        case .speechStarted(let at): return .speechStarted(at: r(at))
        case .pause(let at): return .pause(at: r(at))
        case .resumed(let at): return .resumed(at: r(at))
        case .commit(let at, let reason): return .commit(at: r(at), reason: reason)
        case .discard(let at): return .discard(at: r(at))
        }
    }
}

final class TalkEndOfTurnTests: XCTestCase {
    func testSpeechOpensAtHalfHeldForTwoFrames() {
        var policy = EndOfTurnPolicy()
        XCTAssertTrue(Track.feed(&policy, [0.6, 0.2, 0.7, 0.1, 0.49, 0.49]).isEmpty, "one frame isn't enough")
        let decisions = Track.feed(&policy, [0.5, 0.9], from: 6)
        XCTAssertEqual(decisions.map(\.decision), [Track.rounded(.speechStarted(at: 6 * Track.frame))])
        XCTAssertEqual(decisions.first?.frame, 7)
        XCTAssertEqual(policy.utteranceStart ?? -1, 0, accuracy: 1e-9, "300 ms of pre-roll, from the start at most")
        var later = EndOfTurnPolicy()
        _ = Track.feed(&later, Track.run(0.1, 30) + [0.9, 0.9])
        XCTAssertEqual(later.utteranceStart ?? -1, 30 * Track.frame - 0.3, accuracy: 1e-9, "300 ms of pre-roll")
    }

    func testAPauseIs150msOfQuietAfterEnoughSpeech() {
        var policy = EndOfTurnPolicy()
        _ = Track.feed(&policy, Track.run(0.9, 10))
        // 0.35–0.5 still counts as speech.
        XCTAssertTrue(Track.feed(&policy, Track.run(0.4, 5), from: 10).isEmpty)
        XCTAssertTrue(Track.feed(&policy, Track.run(0.2, 4), from: 15).isEmpty, "128 ms of quiet")
        let decisions = Track.feed(&policy, [0.2], from: 19)
        XCTAssertEqual(decisions.map(\.decision), [Track.rounded(.pause(at: 20 * Track.frame))])
        XCTAssertEqual(policy.phase, .paused)
    }

    func testItCommitsAfter800msOfSilence() {
        var policy = EndOfTurnPolicy()
        _ = Track.feed(&policy, Track.run(0.9, 10))
        let decisions = Track.feed(&policy, Track.run(0.1, 40), from: 10)
        XCTAssertEqual(decisions.map(\.decision).first, Track.rounded(.pause(at: 15 * Track.frame)))
        // Speech ended at 0.32 s; 0.32 + 0.8 = 1.12 s is the end of frame 34.
        XCTAssertEqual(decisions.last?.decision, Track.rounded(.commit(at: 35 * Track.frame, reason: .silence)))
        XCTAssertEqual(decisions.last?.frame, 34)
        XCTAssertEqual(policy.trace?.commitReason, .silence)
    }

    func testADanglingLastWordWaitsTwiceAsLong() {
        var policy = EndOfTurnPolicy()
        _ = Track.feed(&policy, Track.run(0.9, 10))
        _ = Track.feed(&policy, Track.run(0.1, 5), from: 10)
        policy.pauseTranscript("אני רוצה לבדוק את")
        XCTAssertEqual(policy.commitDeadline ?? 0, 0.32 + 1.6, accuracy: 1e-9)
        let decisions = Track.feed(&policy, Track.run(0.1, 60), from: 15)
        XCTAssertEqual(decisions.last?.decision, Track.rounded(.commit(at: 60 * Track.frame, reason: .silence)))
        XCTAssertEqual(policy.trace?.pauses.first?.dangling, true)

        for (text, dangling) in [("תבדוק את הלוגים של", true), ("check the logs and", true), ("כתבתי ו", true),
                                 ("תבדוק את הלוגים", false), ("check the logs", false), ("", false)] {
            XCTAssertEqual(TalkLexicon.endsDangling(text), dangling, text)
        }
    }

    func testPatienceScalesTheWait() {
        for (patience, expected) in [(TalkPatience.short, 0.32 + 0.56), (.normal, 0.32 + 0.8), (.long, 0.32 + 1.2)] {
            var config = EndOfTurnConfig.standard
            config.patience = patience
            var policy = EndOfTurnPolicy(config: config)
            _ = Track.feed(&policy, Track.run(0.9, 10))
            _ = Track.feed(&policy, Track.run(0.1, 5), from: 10)
            XCTAssertEqual(policy.commitDeadline ?? 0, expected, accuracy: 1e-9, patience.rawValue)
            guard case .commit(let at, _)? = Track.feed(&policy, Track.run(0.1, 60), from: 15).last?.decision else {
                return XCTFail("no commit")
            }
            XCTAssertGreaterThanOrEqual(at, expected - 1e-9)
            XCTAssertLessThan(at, expected + Track.frame)
        }
    }

    func testSpeakingAgainAfterAPauseResumes() {
        var policy = EndOfTurnPolicy()
        _ = Track.feed(&policy, Track.run(0.9, 10))
        _ = Track.feed(&policy, Track.run(0.1, 5), from: 10)
        XCTAssertTrue(Track.feed(&policy, [0.8, 0.1], from: 15).isEmpty, "one frame doesn't resume")
        XCTAssertEqual(Track.feed(&policy, [0.8, 0.8], from: 17).map(\.decision),
                       [Track.rounded(.resumed(at: 18 * Track.frame))])
        XCTAssertEqual(policy.phase, .speaking)
        XCTAssertEqual(policy.trace?.pauses.first?.resumed, true)
        // The next silence is measured from the new end of speech.
        let decisions = Track.feed(&policy, Track.run(0.1, 40), from: 19)
        XCTAssertEqual(decisions.last?.decision,
                       Track.rounded(.commit(at: 19 * Track.frame + 0.8, reason: .silence)))
    }

    func testABlipOrAShortUtteranceIsDropped() {
        var blip = EndOfTurnPolicy()
        _ = Track.feed(&blip, Track.run(0.9, 4))
        XCTAssertEqual(Track.feed(&blip, Track.run(0.1, 5), from: 4).map(\.decision),
                       [Track.rounded(.discard(at: 9 * Track.frame))])
        XCTAssertEqual(blip.phase, .idle)

        var short = EndOfTurnPolicy()
        _ = Track.feed(&short, Track.run(0.9, 9))
        let decisions = Track.feed(&short, Track.run(0.1, 40), from: 9).map(\.decision)
        XCTAssertEqual(decisions.first, Track.rounded(.pause(at: 14 * Track.frame)),
                       "288 ms is enough for a pause…")
        XCTAssertEqual(decisions.last, Track.rounded(.discard(at: 9 * Track.frame + 0.8)),
                       "…but under 300 ms is dropped")
        XCTAssertEqual(short.trace?.discarded, true)
    }

    func testAnInterruptionStartsTheUtteranceWhereItBegan() {
        var policy = EndOfTurnPolicy()
        // Talked over the speech from 1.0 s; confirmed at 1.6 s, already quiet.
        policy.begin(at: 1.0, speechUntil: 1.5)
        XCTAssertEqual(policy.phase, .speaking)
        let decisions = Track.feed(&policy, Track.run(0.1, 40), from: 50)
        XCTAssertEqual(decisions.first?.decision, Track.rounded(.pause(at: 55 * Track.frame)))
        XCTAssertEqual(decisions.last?.decision, Track.rounded(.commit(at: 72 * Track.frame, reason: .silence)),
                       "800 ms after the speech heard before the confirmation")
    }

    func testSixtySecondsCommits() {
        var policy = EndOfTurnPolicy()
        let decisions = Track.feed(&policy, Track.run(0.9, 1_900)).map(\.decision)
        XCTAssertEqual(decisions.first, .speechStarted(at: 0))
        guard case .commit(let at, .maxLength)? = decisions.dropFirst().first else {
            return XCTFail("no forced commit")
        }
        XCTAssertGreaterThanOrEqual(at, 60)
        XCTAssertLessThan(at, 60 + Track.frame)
        XCTAssertEqual(decisions.count, 3, "speaking on starts the next utterance")
    }

    func testSmartTurnShadowOnlyRecordsAndActiveCommits() {
        func paused(_ mode: SmartTurnMode) -> EndOfTurnPolicy {
            var config = EndOfTurnConfig.standard
            config.smartTurn = mode
            var policy = EndOfTurnPolicy(config: config)
            _ = Track.feed(&policy, Track.run(0.9, 10))
            _ = Track.feed(&policy, Track.run(0.1, 5), from: 10)
            return policy
        }
        var shadow = paused(.shadow)
        XCTAssertNil(shadow.smartTurn(probability: 0.9, at: 0.5))
        XCTAssertEqual(shadow.trace?.pauses.last?.smartTurn, 0.9)
        XCTAssertEqual(shadow.trace?.smartTurnWouldCommit, true)

        var active = paused(.active)
        XCTAssertNil(active.smartTurn(probability: 0.3, at: 0.5))
        XCTAssertEqual(active.smartTurn(probability: 0.7, at: 0.55), .commit(at: 0.55, reason: .smartTurn))

        var dangling = paused(.active)
        dangling.pauseTranscript("תבדוק אם")
        XCTAssertNil(dangling.smartTurn(probability: 0.95, at: 0.5), "a dangling word waits for the silence")
        XCTAssertEqual(dangling.trace?.smartTurnWouldCommit, false)
        XCTAssertNil(dangling.smartTurn(probability: nil, at: 0.5))
    }
}

final class TalkFinalTranscriptTests: XCTestCase {
    func testTheFinalTextReadyBeforeTheCommitIsUsed() {
        var choice = FinalTranscriptChoice()
        XCTAssertNil(choice.finalReady("Whisper text", at: 1.0))
        XCTAssertEqual(choice.committed(liveText: "zipformer text", at: 1.5), .init(text: "Whisper text", source: .final))
    }

    func testTheFinalTextIsUsedWithin500msOfTheCommit() {
        var choice = FinalTranscriptChoice()
        XCTAssertNil(choice.committed(liveText: "live", at: 2.0))
        XCTAssertEqual(choice.deadline ?? 0, 2.5, accuracy: 1e-9)
        XCTAssertNil(choice.tick(at: 2.3))
        XCTAssertEqual(choice.finalReady("final", at: 2.45), .init(text: "final", source: .final))
    }

    func testPastTheGraceTheLiveTextIsUsed() {
        var choice = FinalTranscriptChoice()
        _ = choice.committed(liveText: "live", at: 2.0)
        XCTAssertEqual(choice.tick(at: 2.5), .init(text: "live", source: .live))
        XCTAssertNil(choice.finalReady("late", at: 2.7))
        XCTAssertEqual(choice.result?.source, .live)
    }

    func testAnEmptyOrMissingFinalTextFallsBackToLive() {
        var empty = FinalTranscriptChoice()
        _ = empty.committed(liveText: "live", at: 1)
        XCTAssertEqual(empty.finalReady("  ", at: 1.1), .init(text: "live", source: .live))

        var unloaded = FinalTranscriptChoice(expectsFinal: false)
        XCTAssertEqual(unloaded.committed(liveText: "live words", at: 1), .init(text: "live words", source: .live))

        var failed = FinalTranscriptChoice()
        _ = failed.committed(liveText: "live", at: 1)
        XCTAssertEqual(failed.finalFailed(), .init(text: "live", source: .live))
    }
}

final class TalkBargeInTests: XCTestCase {
    /// Quiet with RMS 0.01…0.05, then speech starts at 3 s.
    private func speaking(_ sentence: String = "אני בודק את הקובץ עכשיו") -> BargeInPolicy {
        var policy = BargeInPolicy()
        for i in 0..<94 {
            _ = policy.frame(probability: 0.1, rms: 0.01 + Float(i % 5) * 0.01, at: Double(i) * Track.frame)
        }
        policy.speechStarted(at: 3.0)
        policy.sentenceStarted(sentence, at: 3.0)
        return policy
    }

    /// Frames of speech at `rms` from `start`; the decisions.
    private func talk(_ policy: inout BargeInPolicy, rms: Float, from start: TimeInterval, frames: Int,
                      p: Float = 0.8) -> [(time: TimeInterval, decision: BargeInDecision)] {
        var out: [(TimeInterval, BargeInDecision)] = []
        for i in 0..<frames {
            let t = start + Double(i) * Track.frame
            if let decision = policy.frame(probability: p, rms: rms, at: t) { out.append((t, decision)) }
        }
        return out
    }

    func testTheNoiseFloorIsThe20thPercentileOfTheQuietBeforeTheSpeech() {
        var policy = speaking()
        XCTAssertEqual(policy.noiseFloor, 0.02, accuracy: 1e-6)
        // Quiet older than 3 s doesn't count.
        policy.speechEnded(at: 3.5)
        for i in 0..<20 { _ = policy.frame(probability: 0.1, rms: 0.2, at: 10 + Double(i) * Track.frame) }
        policy.speechStarted(at: 11)
        XCTAssertEqual(policy.noiseFloor, 0.2, accuracy: 1e-6)
        // Speech frames don't count either.
        var fresh = BargeInPolicy()
        for i in 0..<20 { _ = fresh.frame(probability: 0.9, rms: 0.5, at: Double(i) * Track.frame) }
        fresh.speechStarted(at: 1)
        XCTAssertEqual(fresh.noiseFloor, BargeInConfig.standard.defaultFloor)
    }

    func testACandidateNeeds300msOfLoudSpeechOnceArmed() {
        var policy = speaking()
        // Before 250 ms into the sentence nothing counts.
        XCTAssertTrue(talk(&policy, rms: 0.2, from: 3.0, frames: 7).isEmpty)
        let decisions = talk(&policy, rms: 0.2, from: 3.0 + 7 * Track.frame, frames: 12)
        XCTAssertEqual(decisions.map(\.decision), [.candidate])
        // Frame 7 (3.224 s) is still inside the first 250 ms; the run starts
        // at frame 8 (3.256 s) and its tenth frame (320 ms) makes it.
        XCTAssertEqual(decisions.first?.time ?? 0, 3.0 + 17 * Track.frame, accuracy: 1e-9)
        XCTAssertEqual(policy.candidateStart ?? 0, 3.0 + 8 * Track.frame, accuracy: 1e-9)
    }

    func testQuietSpeechUnderTwiceTheFloorIsNotACandidate() {
        var policy = speaking()
        XCTAssertTrue(talk(&policy, rms: 0.035, from: 3.3, frames: 40).isEmpty)
        XCTAssertTrue(talk(&policy, rms: 0.2, from: 4.6, frames: 40, p: 0.45).isEmpty)
    }

    func testEachNewSentenceRearms() {
        var policy = speaking()
        _ = talk(&policy, rms: 0.2, from: 3.3, frames: 5)
        policy.sentenceStarted("שני", at: 3.3 + 5 * Track.frame)
        XCTAssertTrue(talk(&policy, rms: 0.2, from: 3.3 + 5 * Track.frame, frames: 7).isEmpty)
    }

    func testTwoFreshWordsConfirm() {
        var policy = speaking()
        _ = talk(&policy, rms: 0.2, from: 3.3, frames: 10)
        XCTAssertNil(policy.transcript("תעשה", at: 3.8), "one word isn't enough")
        XCTAssertEqual(policy.transcript("תעשה משהו אחר", at: 4.0), .confirmed)
        policy.speechEnded(at: 4.0)
        XCTAssertTrue(policy.allowsSpeechStart(rms: 0.001, at: 4.1), "no gate after a confirmed interruption")
    }

    func testAStopWordAloneConfirmsUnlessItIsEcho() {
        var policy = speaking()
        _ = talk(&policy, rms: 0.2, from: 3.3, frames: 10)
        XCTAssertEqual(policy.transcript("די", at: 3.8), .confirmed)

        var echo = speaking("די מהר זה נגמר")
        _ = talk(&echo, rms: 0.2, from: 3.3, frames: 10)
        XCTAssertNil(echo.transcript("די", at: 3.8))
    }

    func testEchoOfWhatIsSpokenIsRejectedAfterOneAndAHalfSeconds() {
        var policy = speaking("הבדיקות עברו בהצלחה")
        policy.sentenceStarted("עכשיו אני דוחף את השינויים", at: 3.4)
        let candidate = talk(&policy, rms: 0.2, from: 3.7, frames: 10)
        XCTAssertEqual(candidate.map(\.decision), [.candidate])
        XCTAssertNil(policy.transcript("בדיקות עברו", at: 4.2), "the previous sentence counts as echo")
        XCTAssertNil(policy.transcript("דוחף את השינויים", at: 4.4))
        let since = candidate[0].time + Track.frame
        XCTAssertNil(policy.frame(probability: 0.2, rms: 0.01, at: since + 1.4))
        XCTAssertEqual(policy.frame(probability: 0.2, rms: 0.01, at: since + 1.5), .rejected)
        XCTAssertEqual(policy.phase, .speaking)
    }

    func testFewerThanSixtyPercentEchoConfirms() {
        XCTAssertTrue(BargeInPolicy.confirms("רגע תעצור את זה", current: BargeInPolicy.keys("תעצור את השרת"),
                                             previous: []))
        XCTAssertFalse(BargeInPolicy.confirms("תעצור את השרת", current: BargeInPolicy.keys("תעצור את השרת"),
                                              previous: []))
        XCTAssertFalse(BargeInPolicy.confirms("", current: [], previous: []))
    }

    func testAfterTheSpeechNewSpeechWaits600msUnlessItIsLoud() {
        var policy = speaking()
        policy.speechEnded(at: 5.0)
        XCTAssertFalse(policy.allowsSpeechStart(rms: 0.05, at: 5.3))
        XCTAssertTrue(policy.allowsSpeechStart(rms: 0.07, at: 5.3), "three times the floor")
        XCTAssertTrue(policy.allowsSpeechStart(rms: 0.01, at: 5.6))
    }

    func testOffOnlyLearnsTheFloor() {
        var config = BargeInConfig.standard
        config.enabled = false
        var policy = BargeInPolicy(config: config)
        policy.speechStarted(at: 0)
        policy.sentenceStarted("שלום", at: 0)
        XCTAssertTrue(talk(&policy, rms: 1, from: 0.3, frames: 40).isEmpty)
    }
}
