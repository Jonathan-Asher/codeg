import Foundation

/// Port of `blue_onnx/text_norm.py` — text normalization applied before G2P.
///
/// Function names and order mirror the Python module so the two can be diffed
/// side by side. `prepareTextForSynthesis` is `prepare_text_for_synthesis`.
public enum TextNormalizer {
    // MARK: slow segments

    public static let slowMarkOpen = "【"
    public static let slowMarkClose = "】"
    static let slowSpeedScale: Float = 0.90
    static let slowPaceBlend: Float = 0.40
    static let slowPaceDptRef: Float = 0.0625
    static let slowSilence: Float = 0.12

    static let slowWrappedRe = PyRegex("【([^】]+)】")
    static let protectedSpanRe = PyRegex("(<en>.*?</en>|【[^】]*】)", ignoreCase: true, dotAll: true)
    static let inlineEnBlockRe = PyRegex("(<en>.*?</en>)", ignoreCase: true, dotAll: true)

    static let emojiRe = PyRegex(
        "[\\x{1F600}-\\x{1F64F}\\x{1F300}-\\x{1F5FF}\\x{1F680}-\\x{1F6FF}\\x{1F700}-\\x{1F77F}"
            + "\\x{1F780}-\\x{1F7FF}\\x{1F800}-\\x{1F8FF}\\x{1F900}-\\x{1F9FF}\\x{1FA00}-\\x{1FA6F}"
            + "\\x{1FA70}-\\x{1FAFF}\\x{2600}-\\x{26FF}\\x{2700}-\\x{27BF}\\x{1F1E6}-\\x{1F1FF}]+"
    )

    static let emailRe = PyRegex("[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}")
    static let alnumMixTokenRe = PyRegex("(?<![A-Za-z0-9])[A-Za-z0-9]+(?:[-_/][A-Za-z0-9]+)*(?![A-Za-z0-9])")
    static let dateRe = PyRegex("(?<!\\d)([0-3]?\\d)[/.]([01]?\\d)[/.](\\d{2}|\\d{4})(?!\\d)")
    static let timeRe = PyRegex("(?<!\\d)([01]?\\d|2[0-3]):([0-5]\\d)(?!\\d)")
    static let groupedIntCommaRe = PyRegex("(?<![\\w.,])\\d{1,3}(?:,\\d{3})+(?![\\w.,])")
    static let groupedIntDotRe = PyRegex("(?<![\\w.,])\\d{1,3}(?:\\.\\d{3})+(?![\\w.,])")
    static let plainNumberRe = PyRegex("(?<![\\w])\\d+(?:[.,]\\d+)?(?![\\w])")
    static let commaDecimalLangs: Set<String> = ["de", "es", "it"]
    static let listMarkerRe = PyRegex("(?<![\\d/])(\\d{1,2})\\.\\s+(?=[\\u0590-\\u05FFA-Za-z\"'(<])")

    static let hebrewMonthOrdinals: [Int: String] = [
        1: "לראשון", 2: "לשני", 3: "לשלישי", 4: "לרביעי", 5: "לחמישי", 6: "לשישי",
        7: "לשביעי", 8: "לשמיני", 9: "לתשיעי", 10: "לעשירי", 11: "לאחד עשר",
        12: "לשנים עשר",
    ]
    static let monthNames: [String: [String]] = [
        "en": ["January", "February", "March", "April", "May", "June", "July",
               "August", "September", "October", "November", "December"],
    ]
    static let dateDayMonthGlue: [String: String] = ["en": " of ", "es": " de ", "de": " ", "it": " "]
    static let percentWords: [String: String] = ["he": "אחוז", "en": "percent", "es": "por ciento",
                                                 "de": "Prozent", "it": "per cento"]
    static let ratioWords: [String: String] = ["he": "ל", "en": "to", "es": "a", "de": "zu", "it": "a"]
    static let plusWords: [String: String] = ["he": "פלוס", "en": "plus", "es": "más", "de": "plus", "it": "più"]
    static let hebrewListCardinals: [Int: String] = [
        1: "אחד", 2: "שתיים", 3: "שלוש", 4: "ארבע", 5: "חמש", 6: "שש", 7: "שבע",
        8: "שמונה", 9: "תשע", 10: "עשר", 11: "אחת עשרה", 12: "שתים עשרה",
        13: "שלוש עשרה", 14: "ארבע עשרה", 15: "חמש עשרה", 16: "שש עשרה",
        17: "שבע עשרה", 18: "שמונה עשרה", 19: "תשע עשרה", 20: "עשרים",
    ]
    static let hebrewDigitWords: [Character: String] = [
        "0": "אפס", "1": "אחת", "2": "שתיים", "3": "שלוש", "4": "ארבע",
        "5": "חמש", "6": "שש", "7": "שבע", "8": "שמונה", "9": "תשע",
    ]

    static func canonicalLang(_ lang: String) -> String {
        let l = lang.lowercased()
        switch l {
        case "ge": return "de"
        case "en-us": return "en"
        default: return l
        }
    }

    static let wsRe = PyRegex("\\s+")

    public static func stripEmoji(_ text: String) -> String {
        Py.strip(wsRe.sub(emojiRe.sub(text, " "), " "))
    }

    /// `_map_en_spans`.
    static func mapEnSpans(_ text: String, _ lang: String, _ fn: (String, String, Bool) -> String) -> String {
        var out = ""
        for part in inlineEnBlockRe.split(text) {
            if inlineEnBlockRe.fullmatch(part) != nil {
                let sc = Py.scalars(part)
                let inner = Py.string(sc[4..<(sc.count - 5)])
                out += "<en>\(fn(inner, "en", true))</en>"
            } else {
                out += fn(part, lang, false)
            }
        }
        return out
    }

    static func maybeSlow(_ inner: String, _ insideEn: Bool) -> String {
        insideEn ? inner : markSlowSegment(inner)
    }

    static func spokenNumber(_ v: Num2Words.Value, _ lang: String) -> String? {
        Num2Words.cardinal(v, lang: lang)
    }

    static func spokenOrdinal(_ v: Int, _ lang: String) -> String? {
        Num2Words.ordinal(v, lang: lang) ?? spokenNumber(.int(v), lang)
    }

    static func spokenDigits(_ digits: String, _ lang: String) -> String {
        if lang == "he" {
            return digits.compactMap { hebrewDigitWords[$0] }.joined(separator: " ")
        }
        let words = digits.compactMap { c -> String? in
            guard let d = c.wholeNumberValue, c.isASCII else { return nil }
            return spokenNumber(.int(d), lang)
        }
        return words.joined(separator: " ")
    }

    static func markSlowSegment(_ inner: String) -> String { "\(slowMarkOpen)\(inner)\(slowMarkClose)" }

    public static func stripSlowMarkers(_ text: String) -> String {
        slowWrappedRe.sub(text) { $0.group(1) ?? "" }
    }

    static let punctOnlyRe = PyRegex("[.!?,;:…]+")

    /// `split_slow_segments`.
    static func splitSlowSegments(_ text: String) -> [(String, Bool)] {
        if !Py.contains(text, slowMarkOpen) { return [(text, false)] }
        var parts: [(String, Bool)] = []
        var last = text.startIndex
        for m in slowWrappedRe.finditer(text) {
            if m.range.lowerBound > last {
                let chunk = Py.strip(String(text[last..<m.range.lowerBound]))
                if !chunk.isEmpty { parts.append((chunk, false)) }
            }
            let inner = Py.strip(m.group(1) ?? "")
            if !inner.isEmpty { parts.append((inner, true)) }
            last = m.range.upperBound
        }
        if last < text.endIndex {
            let tail = Py.strip(String(text[last...]))
            if !tail.isEmpty { parts.append((tail, false)) }
        }
        var merged: [(String, Bool)] = []
        for (chunk, isSlow) in parts {
            if !merged.isEmpty && punctOnlyRe.fullmatch(chunk) != nil {
                let (prev, prevSlow) = merged[merged.count - 1]
                merged[merged.count - 1] = (prev + chunk, prevSlow)
            } else {
                merged.append((chunk, isSlow))
            }
        }
        return merged.isEmpty ? [(text, false)] : merged
    }

    // MARK: punctuation / markup

    static let sepHebLatRe = PyRegex("(?<=[\\u0590-\\u05FF])[-–—‑]+(?=[A-Za-z0-9])")
    static let sepLatHebRe = PyRegex("(?<=[A-Za-z0-9])[-–—‑]+(?=[\\u0590-\\u05FF])")
    static let sepLooseRe = PyRegex("(?<![A-Za-z])\\s*[-–—‑]+\\s*(?![A-Za-z])")
    static let colonLooseRe = PyRegex("(?<!\\d)\\s*:+\\s*(?!\\d)")

    static func stripSilentSeparatorTokens(_ text: String) -> String {
        var t = sepHebLatRe.sub(text, " ")
        t = sepLatHebRe.sub(t, " ")
        t = sepLooseRe.sub(t, " ")
        t = colonLooseRe.sub(t, " ")
        return Py.strip(wsRe.sub(t, " "))
    }

    static let openBracketRe = PyRegex("\\s*[(\\[{]\\s*")
    static let closeBracketRe = PyRegex("\\s*[)\\]}]\\s*")

    static func stripBrackets(_ text: String) -> String {
        closeBracketRe.sub(openBracketRe.sub(text, ", "), ", ")
    }

    static let dotsRe = PyRegex("(?<!\\d)\\.{2,}(?!\\d)")
    static let bangsRe = PyRegex("!+")
    static let questionsRe = PyRegex("\\?+")
    static let commasRe = PyRegex(",(?:\\s*,)+")
    static let softBeforeStopRe = PyRegex("\\s*[,;:]+\\s*(?=[.!?])")
    static let softAfterStopRe = PyRegex("(?<=[.!?])\\s*[,;:]+\\s*")

    static func normalizeRepeatedPunctuation(_ text: String) -> String {
        var t = Py.replace(text, "…", ",")
        t = dotsRe.sub(t, ",")
        t = bangsRe.sub(t, "!")
        t = questionsRe.sub(t, "?")
        t = commasRe.sub(t, ",")
        t = softBeforeStopRe.sub(t, "")
        return softAfterStopRe.sub(t, " ")
    }

    static let headerRe = PyRegex("(^|\\s)#{1,6}\\s*")
    static let anymoreRe = PyRegex("\\banymore\\b", ignoreCase: true)

    static func normalizeCommonText(_ text: String) -> String {
        var t = headerRe.sub(text) { $0.group(1) ?? "" }
        t = stripBrackets(t)
        t = normalizeRepeatedPunctuation(t)
        return anymoreRe.sub(t) { m in
            (m.value.first?.isUppercase ?? false) ? "Any more" : "any more"
        }
    }

    static let quoteEndRe = PyRegex("(?<=\\S)\\s*[\"“„”]\\s*$")
    static let quoteOpenRe = PyRegex("\\s*:?\\s*[\"“„”]\\s*(?=\\S)")
    static let quoteCloseRe = PyRegex("(?<=\\S)\\s*[\"“„”]")

    static func expandDialogueQuotes(_ text: String, _ lang: String) -> String {
        var t = quoteEndRe.sub(text, ".")
        t = quoteOpenRe.sub(t, ", ")
        return quoteCloseRe.sub(t, ", ")
    }

    // MARK: Hebrew spelling quirks

    static let abbrevQuoteRe = PyRegex("(?<=[\\u0590-\\u05FF])[\"״](?=[\\u0590-\\u05FF])")

    static func stripHebrewAbbreviationQuotes(_ text: String, _ lang: String) -> String {
        guard canonicalLang(lang) == "he" else { return text }
        return abbrevQuoteRe.sub(text, "")
    }

    static let phoneticGereshRe = PyRegex("(?<=[גצז])'(?=[\\u0590-\\u05FF])")

    static func normalizePhoneticGeresh(_ text: String, _ lang: String) -> String {
        guard canonicalLang(lang) == "he" else { return text }
        return phoneticGereshRe.sub(text, "׳")
    }

    static let gereshLoanwordRe = PyRegex("(?<![\\u0590-\\u05FF])(?:ג['׳]מיני|מנג['׳]ר)(?![\\u0590-\\u05FF])")
    static let gereshLoanwordEn: [String: String] = [
        "ג'מיני": "Gemini", "ג׳מיני": "Gemini", "מנג'ר": "Manager", "מנג׳ר": "Manager",
    ]

    static func expandGereshLoanwords(_ text: String, _ lang: String) -> String {
        guard canonicalLang(lang) == "he" else { return text }
        return mapEnSpans(text, canonicalLang(lang)) { seg, _, insideEn in
            if insideEn { return seg }
            return gereshLoanwordRe.sub(seg) { m in
                if let en = gereshLoanwordEn[m.value] { return "<en>\(en)</en>" }
                return m.value
            }
        }
    }

    static let inwordHyphenRe = PyRegex("(?<=[\\u0590-\\u05FF])[-–—‑]+(?=[\\u0590-\\u05FF])")

    static func stripHebrewInwordHyphens(_ text: String, _ lang: String) -> String {
        guard canonicalLang(lang) == "he" else { return text }
        return inwordHyphenRe.sub(text, "")
    }

    static let lamedBeforeLatinRe = PyRegex("(?<![\\u0590-\\u05FF])ל\\s*[-–—‑]?\\s*(?=[A-Za-z0-9])")

    static func expandHebrewLamedBeforeLatin(_ text: String, _ lang: String) -> String {
        guard canonicalLang(lang) == "he" else { return text }
        return lamedBeforeLatinRe.sub(text, "אל ")
    }

    // MARK: codes, emails, numbers

    static let localDotRe = PyRegex("[._]+")
    static let localDashRe = PyRegex("[-]+")
    static let localPlusRe = PyRegex("[+]+")

    static func emailToSpokenEnglish(_ email: String) -> String {
        let parts = email.split(separator: "@", maxSplits: 1, omittingEmptySubsequences: false)
        var local = String(parts[0])
        let domain = parts.count > 1 ? String(parts[1]) : ""
        func spellShortLabel(_ label: String) -> String {
            let n = Py.len(label)
            if n > 0 && n <= 2 && label.unicodeScalars.allSatisfy({ Py.isAlpha($0) }) {
                return label.map { String($0) }.joined(separator: " ")
            }
            return label
        }
        local = localDotRe.sub(local, " dot ")
        local = localDashRe.sub(local, " dash ")
        local = localPlusRe.sub(local, " plus ")
        let domainParts = domain.components(separatedBy: ".").filter { !$0.isEmpty }.map(spellShortLabel)
        return Py.strip(wsRe.sub("\(local) at \(domainParts.joined(separator: " dot "))", " "))
    }

    static func expandEmails(_ text: String, _ lang: String) -> String {
        mapEnSpans(text, canonicalLang(lang)) { seg, _, insideEn in
            if insideEn { return seg }
            return emailRe.sub(seg) { "<en>\(emailToSpokenEnglish($0.value))</en>" }
        }
    }

    static let spellableTokenRe = PyRegex("[A-Za-z0-9][A-Za-z0-9\\-_/]*")
    static let codeSepRe = PyRegex("[-_/]")
    static let codeSplitRe = PyRegex("[-_/]+")

    static func shouldSpellAlphanumericToken(_ token: String) -> Bool {
        if token.isEmpty || Py.contains(token, "@") { return false }
        if spellableTokenRe.fullmatch(token) == nil { return false }
        let letters = token.unicodeScalars.filter { Py.isAsciiAlpha($0) }
        let digits = token.unicodeScalars.filter { Py.isDigit($0) }
        if letters.isEmpty || digits.isEmpty { return false }
        if letters.count < 2 && digits.count < 2 { return false }
        return Py.len(codeSepRe.sub(token, "")) >= 3
    }

    static func spellAlphanumericCode(_ code: String, _ lang: String) -> String {
        let lang = canonicalLang(lang)
        var letters: [String] = []
        var digitGroups: [String] = []
        for seg in codeSplitRe.split(code) {
            if seg.isEmpty { continue }
            let segLetters = seg.unicodeScalars.filter { Py.isAsciiAlpha($0) }.map { String($0).uppercased() }
            let segDigits = Py.string(seg.unicodeScalars.filter { Py.isDigit($0) })
            if !segLetters.isEmpty { letters += segLetters }
            if !segDigits.isEmpty { digitGroups.append(segDigits) }
        }
        let digitParts = digitGroups.map { spokenDigits($0, lang) }.filter { !$0.isEmpty }
        if letters.isEmpty && digitParts.isEmpty { return "" }
        let lettersBlock = letters.isEmpty ? "" : "<en>\(letters.joined(separator: " "))</en>"
        var digitsBlock = digitParts.joined(separator: " , ")
        if !digitsBlock.isEmpty { digitsBlock += " ." }
        let inner = [lettersBlock, digitsBlock].filter { !$0.isEmpty }.joined(separator: " ")
        return markSlowSegment(inner)
    }

    static func expandAlphanumericCodes(_ text: String, _ lang: String) -> String {
        mapEnSpans(text, canonicalLang(lang)) { seg, segLang, insideEn in
            if insideEn { return seg }
            return alnumMixTokenRe.sub(seg) { m in
                let token = m.value
                if !shouldSpellAlphanumericToken(token) { return token }
                let s = spellAlphanumericCode(token, segLang)
                return s.isEmpty ? token : s
            }
        }
    }

    static func expandListMarkers(_ text: String, _ lang: String) -> String {
        mapEnSpans(text, canonicalLang(lang)) { seg, segLang, insideEn in
            if insideEn { return seg }
            return listMarkerRe.sub(seg) { m in
                let n = Int(m.group(1)!)!
                let word: String
                if segLang == "he", let w = hebrewListCardinals[n] {
                    word = w
                } else if let w = spokenNumber(.int(n), segLang) {
                    word = w
                } else {
                    return m.value
                }
                return "\(word). "
            }
        }
    }

    static let plusRe = PyRegex("\\s+\\+\\s+")

    static func expandPlusSign(_ text: String, _ lang: String) -> String {
        mapEnSpans(text, canonicalLang(lang)) { seg, segLang, insideEn in
            if insideEn { return seg }
            let word = plusWords[segLang] ?? plusWords["en"]!
            return plusRe.sub(seg, " \(word) ")
        }
    }

    static let starRe = PyRegex("\\*(\\d{2,})")
    static let phoneRe = PyRegex("(?<!\\d)0\\d{0,2}-\\d{6,8}(?!\\d)")

    static func expandPhoneNumbers(_ text: String, _ lang: String) -> String {
        guard canonicalLang(lang) == "he" else { return text }
        return mapEnSpans(text, canonicalLang(lang)) { seg, _, insideEn in
            if insideEn { return seg }
            var s = starRe.sub(seg) { m in markSlowSegment("כוכבית " + spokenDigits(m.group(1)!, "he")) }
            s = phoneRe.sub(s) { m in markSlowSegment(spokenDigits(Py.replace(m.value, "-", ""), "he")) }
            return s
        }
    }

    static func expandTimes(_ text: String, _ lang: String) -> String {
        mapEnSpans(text, canonicalLang(lang)) { seg, segLang, insideEn in
            timeRe.sub(seg) { m in
                let hour = Int(m.group(1)!)!, minute = Int(m.group(2)!)!
                guard let hourWord = spokenNumber(.int(hour), segLang) else { return m.value }
                if minute == 0 { return maybeSlow(hourWord, insideEn) }
                guard let minuteWord = spokenNumber(.int(minute), segLang) else { return m.value }
                let joined = segLang == "he" ? "\(hourWord) ו\(minuteWord)" : "\(hourWord) \(minuteWord)"
                return maybeSlow(joined, insideEn)
            }
        }
    }

    static func expandDates(_ text: String, _ lang: String) -> String {
        mapEnSpans(text, canonicalLang(lang)) { seg, segLang, insideEn in
            dateRe.sub(seg) { m in
                let day = Int(m.group(1)!)!, month = Int(m.group(2)!)!
                let rawYear = m.group(3)!
                guard (1...31).contains(day), (1...12).contains(month) else { return m.value }
                var year = Int(rawYear)!
                if rawYear.count == 2 { year += year < 70 ? 2000 : 1900 }
                guard let yearWord = spokenNumber(.int(year), segLang) else { return m.value }
                if segLang == "he" {
                    guard let dayWord = spokenNumber(.int(day), "he") else { return m.value }
                    return maybeSlow("\(dayWord) \(hebrewMonthOrdinals[month]!) \(yearWord)", insideEn)
                }
                guard let months = monthNames[segLang], let dayWord = spokenOrdinal(day, segLang) else {
                    return m.value
                }
                let glue = dateDayMonthGlue[segLang] ?? " "
                return maybeSlow("\(dayWord)\(glue)\(months[month - 1]) \(yearWord)", insideEn)
            }
        }
    }

    static let percentNumRe = PyRegex("(\\d+(?:[.,]\\d+)?)\\s*%")
    static let percentRe = PyRegex("%")

    static func expandPercentSymbols(_ text: String, _ lang: String) -> String {
        mapEnSpans(text, canonicalLang(lang)) { seg, segLang, _ in
            let word = percentWords[segLang] ?? percentWords["en"]!
            let s = percentNumRe.sub(seg) { "\($0.group(1)!) \(word)" }
            return percentRe.sub(s, " \(word) ")
        }
    }

    static let ratioRe = PyRegex("(?<!\\d)(\\d+)\\s*:\\s*(\\d+)(?!\\d)")

    static func expandRatios(_ text: String, _ lang: String) -> String {
        mapEnSpans(text, canonicalLang(lang)) { seg, segLang, _ in
            let word = ratioWords[segLang] ?? ratioWords["en"]!
            return ratioRe.sub(seg) { "\($0.group(1)!) \(word) \($0.group(2)!)" }
        }
    }

    /// Python `int(s)` for a run of Unicode decimal digits.
    static func pyInt(_ s: String) -> Int? {
        var v = 0
        for u in s.unicodeScalars {
            guard let d = u.properties.numericType == .decimal ? u.properties.numericValue : nil else { return nil }
            let (m, o1) = v.multipliedReportingOverflow(by: 10)
            let (a, o2) = m.addingReportingOverflow(Int(d))
            if o1 || o2 { return nil }
            v = a
        }
        return s.isEmpty ? nil : v
    }

    /// Python `float(s)` for `\d+\.\d+`.
    static func pyFloat(_ s: String) -> Double? {
        let ascii = Py.string(s.unicodeScalars.map { u -> Unicode.Scalar in
            if u.properties.numericType == .decimal, let v = u.properties.numericValue {
                return Unicode.Scalar(UInt8(48 + Int(v)))
            }
            return u
        })
        return Double(ascii)
    }

    static func expandNumbers(_ text: String, _ lang: String) -> String {
        let lang = canonicalLang(lang)
        let commaDecimal = commaDecimalLangs.contains(lang)
        let groupRe = commaDecimal ? groupedIntDotRe : groupedIntCommaRe
        let groupMark = commaDecimal ? "." : ","

        func replGrouped(_ m: PyRegex.Match) -> String {
            guard let n = pyInt(Py.replace(m.value, groupMark, "")),
                  let w = spokenNumber(.int(n), lang), !w.isEmpty else { return m.value }
            return w
        }
        func replPlain(_ m: PyRegex.Match) -> String {
            let raw = m.value
            let value: Num2Words.Value
            if Py.contains(raw, ".") || Py.contains(raw, ",") {
                guard let f = pyFloat(Py.replace(raw, ",", ".")) else { return raw }
                value = .float(f)
            } else {
                guard let n = pyInt(raw) else { return raw }
                value = .int(n)
            }
            guard let w = spokenNumber(value, lang), !w.isEmpty else { return raw }
            return w
        }
        func expandSegment(_ s: String) -> String {
            plainNumberRe.sub(groupRe.sub(s, replGrouped), replPlain)
        }
        return protectedSpanRe.split(text).map { p in
            protectedSpanRe.fullmatch(p) != nil ? p : expandSegment(p)
        }.joined()
    }

    /// `prepare_text_for_synthesis`.
    public static func prepareTextForSynthesis(_ text: String, lang: String = "he", markSlow: Bool = true) -> String {
        var t = stripEmoji(text)
        t = normalizeCommonText(t)
        t = stripHebrewAbbreviationQuotes(t, lang)
        t = normalizePhoneticGeresh(t, lang)
        t = expandGereshLoanwords(t, lang)
        t = expandDialogueQuotes(t, lang)
        t = stripHebrewInwordHyphens(t, lang)
        t = expandHebrewLamedBeforeLatin(t, lang)
        t = expandEmails(t, lang)
        t = expandAlphanumericCodes(t, lang)
        t = expandListMarkers(t, lang)
        t = expandPlusSign(t, lang)
        t = expandPhoneNumbers(t, lang)
        t = expandTimes(t, lang)
        t = expandDates(t, lang)
        t = expandPercentSymbols(t, lang)
        t = expandRatios(t, lang)
        t = expandNumbers(t, lang)
        t = stripSilentSeparatorTokens(t)
        return markSlow ? t : stripSlowMarkers(t)
    }
}
