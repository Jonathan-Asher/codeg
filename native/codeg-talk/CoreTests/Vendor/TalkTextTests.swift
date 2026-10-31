import XCTest
@testable import Codeg

/// Hebrew clean-up and matching, the words Talk listens for, and its
/// settings.
final class TalkHebrewTextTests: XCTestCase {
    func testNikudAndBidiMarksAreStripped() {
        XCTAssertEqual(HebrewText.stripMarks("שָׁלוֹם עוֹלָם"), "שלום עולם")
        XCTAssertEqual(HebrewText.stripMarks("בְּרֵאשִׁית"), "בראשית")
        XCTAssertEqual(HebrewText.stripMarks("בית־ספר"), "בית-ספר", "the maqaf becomes a hyphen")
        XCTAssertEqual(HebrewText.stripMarks("\u{200F}שלום\u{200E} \u{202B}עולם\u{202C}\u{2067}!\u{2069}"), "שלום עולם!")
        XCTAssertEqual(HebrewText.stripMarks("plain text"), "plain text")
    }

    func testGereshAndGershayimAreNormalized() {
        let table: [(String, String)] = [
            ("ד\"ר כהן", "ד״ר כהן"), ("צה\"ל", "צה״ל"), ("ארה\u{201D}ב", "ארה״ב"), ("ד''ר", "ד״ר"),
            ("ג'ירה", "ג׳ירה"), ("צ\u{2019}אט", "צ׳אט"), ("וכו'", "וכו׳"), ("'שלום' אמר", "'שלום' אמר"),
            ("\"שלום\"", "\"שלום\""), ("don't", "don't"), ("he said \"hi\"", "he said \"hi\""),
            ("ג' ו-ד'", "ג׳ ו-ד׳"),
        ]
        for (input, expected) in table {
            XCTAssertEqual(HebrewText.normalizeGershayim(input), expected, input)
        }
    }

    func testWordsAreUnicodeAware() {
        XCTAssertEqual(HebrewText.words("Hello, World! ד\"ר כהן don't, ג'ירה."),
                       ["hello", "world", "ד״ר", "כהן", "don't", "ג׳ירה"])
        XCTAssertEqual(HebrewText.words("עדכנתי את ה-README."), ["עדכנתי", "את", "ה", "readme"])
        XCTAssertEqual(HebrewText.words("שָׁלוֹם, 42 tests"), ["שלום", "42", "tests"])
        XCTAssertEqual(HebrewText.words("...!?"), [])
        XCTAssertEqual(HebrewText.normalized("  כן,  בטח!  "), "כן בטח")
        let tokens = HebrewText.tokens("לא, תריץ")
        XCTAssertEqual(tokens.map(\.word), ["לא", "תריץ"])
        XCTAssertEqual(String("לא, תריץ"[tokens[1].range]), "תריץ")
    }

    func testHebrewPrefixesAreStrippedForMatching() {
        XCTAssertEqual(HebrewText.stripPrefixes("הראשונה"), "ראשונה")
        XCTAssertEqual(HebrewText.stripPrefixes("וכשהלכתי"), "הלכתי", "at most three")
        XCTAssertEqual(HebrewText.stripPrefixes("כן"), "כן", "two letters are kept")
        XCTAssertEqual(HebrewText.stripPrefixes("וכן"), "כן")
        XCTAssertEqual(HebrewText.stripPrefixes("tests"), "tests")
        XCTAssertEqual(HebrewText.matchKey("הבדיקות"), HebrewText.matchKey("בדיקות"))
    }

    func testScripts() {
        XCTAssertTrue(HebrewText.containsHebrew("abc ש"))
        XCTAssertFalse(HebrewText.containsHebrew("abc"))
        XCTAssertTrue(HebrewText.containsLatin("שלום a"))
        XCTAssertFalse(HebrewText.containsLatin("שלום 42"))
        XCTAssertEqual(SpeechUnit.language(of: "שלום world"), .hebrew)
        XCTAssertEqual(SpeechUnit.language(of: "hello"), .english)
        XCTAssertEqual(SpeechUnit.language(of: "42."), .auto)
    }
}

final class TalkLexiconTests: XCTestCase {
    private func command(_ text: String) -> TalkLexicon.Command? {
        TalkLexicon.command(in: HebrewText.words(text))
    }

    func testCommands() {
        XCTAssertEqual(command("די"), .stop)
        XCTAssertEqual(command("די בבקשה"), .stop)
        XCTAssertEqual(command("אוקיי, שקט"), .stop)
        XCTAssertEqual(command("תחזרי על זה"), .repeatLast)
        XCTAssertEqual(command("go on"), .continueSpeech)
        XCTAssertEqual(command("תדלגי"), .skip)
        XCTAssertEqual(command("השתק"), .mute)
        XCTAssertEqual(command("תקשיבי"), .unmute)
        XCTAssertEqual(command("סיים שיחה"), .end)
        XCTAssertEqual(command("תבטל את הסוכן"), .cancelAgent)
        XCTAssertNil(command("תבטל את הסוכן ותתחיל מחדש"), "more than four words")
        XCTAssertNil(command("תעצור את השרת"))
        XCTAssertNil(command(""))
        for command in TalkLexicon.Command.allCases {
            for phrase in TalkLexicon.commandPhrases[command] ?? [] {
                XCTAssertLessThanOrEqual(phrase.split(separator: " ").count, TalkLexicon.maxCommandWords, phrase)
                XCTAssertEqual(HebrewText.normalized(phrase), phrase, "phrases are written normalized")
            }
        }
    }

    func testSignalsTakeTheLongestPhrase() {
        func signals(_ text: String) -> [TalkLexicon.Signal] {
            TalkLexicon.signals(in: HebrewText.words(text)).map(\.signal)
        }
        XCTAssertEqual(signals("לא בטוח"), [.unclear])
        XCTAssertEqual(signals("no problem"), [.yes])
        XCTAssertEqual(signals("למה לא"), [.yes])
        XCTAssertEqual(signals("אל תשאל שוב"), [.always])
        XCTAssertEqual(signals("אף פעם לא"), [.never])
        XCTAssertEqual(signals("ולא"), [.no])
        XCTAssertEqual(signals("כן לא"), [.yes, .no])
        XCTAssertEqual(signals("תריץ"), [.yes])
        XCTAssertEqual(signals("לא, תריץ קודם את הבדיקות"), [.no], "a verb inside an instruction isn't a yes")
        XCTAssertEqual(signals("כן, תריץ"), [.yes, .yes])
        for (_, phrases) in TalkLexicon.signalPhrases {
            for phrase in phrases { XCTAssertEqual(HebrewText.normalized(phrase), phrase, phrase) }
        }
    }

    func testOrdinals() {
        func ordinals(_ text: String) -> [TalkLexicon.Ordinal] { TalkLexicon.ordinals(in: HebrewText.words(text)) }
        XCTAssertEqual(ordinals("הראשונה"), [.index(0)])
        XCTAssertEqual(ordinals("השני"), [.index(1)])
        XCTAssertEqual(ordinals("שנייה"), [], "alone it means 'a second'")
        XCTAssertEqual(ordinals("אפשרות שנייה"), [.index(1)])
        XCTAssertEqual(ordinals("הראשון והשלישי"), [.index(0), .index(2)])
        XCTAssertEqual(ordinals("the second one"), [.index(1)])
        XCTAssertEqual(ordinals("one"), [.index(0)])
        XCTAssertEqual(ordinals("האחרונה"), [.last])
        XCTAssertEqual(ordinals("option 3"), [.index(2)])
    }

    func testWaitIsOnlyWait() {
        XCTAssertTrue(TalkLexicon.isOnlyWait(HebrewText.words("רגע")))
        XCTAssertTrue(TalkLexicon.isOnlyWait(HebrewText.words("שנייה אחת")))
        XCTAssertTrue(TalkLexicon.isOnlyWait(HebrewText.words("hold on please")))
        XCTAssertFalse(TalkLexicon.isOnlyWait(HebrewText.words("רגע, את השנייה")))
    }
}

final class TalkPrefsTests: XCTestCase {
    private var suite = ""
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suite = "talk-prefs-tests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        super.tearDown()
    }

    func testDefaults() {
        let prefs = TalkPrefs(defaults: defaults)
        XCTAssertTrue(prefs.handsFree)
        XCTAssertEqual(prefs.patience, .normal)
        XCTAssertTrue(prefs.interruptBySpeaking)
        XCTAssertFalse(prefs.speakProgress)
        XCTAssertFalse(prefs.smartTurnActive)
        XCTAssertEqual(prefs.echoMode, .automatic)
        XCTAssertEqual(prefs.endOfTurnConfig, .standard)
        XCTAssertEqual(prefs.bargeInConfig, .standard)
    }

    func testChangesAreKeptUnderCodegTalkKeys() {
        let prefs = TalkPrefs(defaults: defaults)
        prefs.handsFree = false
        prefs.patience = .long
        prefs.interruptBySpeaking = false
        prefs.speakProgress = true
        prefs.smartTurnActive = true
        prefs.echoMode = .voiceProcessing
        let again = TalkPrefs(defaults: defaults)
        XCTAssertFalse(again.handsFree)
        XCTAssertEqual(again.patience, .long)
        XCTAssertFalse(again.interruptBySpeaking)
        XCTAssertTrue(again.speakProgress)
        XCTAssertTrue(again.smartTurnActive)
        XCTAssertEqual(again.echoMode, .voiceProcessing)
        XCTAssertEqual(defaults.string(forKey: "codeg.talk.patience"), "long")
        XCTAssertEqual(defaults.object(forKey: "codeg.talk.handsFree") as? Bool, false)
        XCTAssertEqual(defaults.string(forKey: "codeg.talk.lab.echoMode"), "voiceProcessing")
        XCTAssertEqual(again.endOfTurnConfig.patience, .long)
        XCTAssertEqual(again.endOfTurnConfig.smartTurn, .active)
        XCTAssertFalse(again.bargeInConfig.enabled)
        XCTAssertEqual(TalkPatience.short.multiplier, 0.7)
        XCTAssertEqual(TalkPatience.long.multiplier, 1.5)
    }

    func testAnUnknownStoredValueFallsBackToTheDefault() {
        defaults.set("sometimes", forKey: TalkPrefs.patienceKey)
        defaults.set("laser", forKey: TalkPrefs.echoModeKey)
        let prefs = TalkPrefs(defaults: defaults)
        XCTAssertEqual(prefs.patience, .normal)
        XCTAssertEqual(prefs.echoMode, .automatic)
    }
}
