import Foundation

/// Port of the `hebrew-num2words` package (0.1.0) that RenikudPlus runs on any
/// Hebrew segment still carrying a digit. The BlueTTS normalizer expands most
/// numbers before G2P, so this is the second line of defence, as in Python.
enum HebrewNumberNormalizer {
    static let masc = "m", fem = "f"

    static let mascUnits = ["אפס", "אחד", "שניים", "שלושה", "ארבעה", "חמישה", "שישה", "שבעה", "שמונה", "תשעה", "עשרה"]
    static let femUnits = ["אפס", "אחת", "שתיים", "שלוש", "ארבע", "חמש", "שש", "שבע", "שמונה", "תשע", "עשר"]
    static let mascConstruct: [Int: String] = [2: "שני", 3: "שלושת", 4: "ארבעת", 5: "חמשת", 6: "ששת", 7: "שבעת",
                                               8: "שמונת", 9: "תשעת", 10: "עשרת"]
    static let femConstruct: [Int: String] = [2: "שתי"]
    static let mascTeens = ["אחד עשר", "שנים עשר", "שלושה עשר", "ארבעה עשר", "חמישה עשר",
                            "שישה עשר", "שבעה עשר", "שמונה עשר", "תשעה עשר"]
    static let femTeens = ["אחת עשרה", "שתים עשרה", "שלוש עשרה", "ארבע עשרה", "חמש עשרה",
                           "שש עשרה", "שבע עשרה", "שמונה עשרה", "תשע עשרה"]
    static let tens: [Int: String] = [2: "עשרים", 3: "שלושים", 4: "ארבעים", 5: "חמישים",
                                      6: "שישים", 7: "שבעים", 8: "שמונים", 9: "תשעים"]
    static let hundreds: [Int: String] = [1: "מאה", 2: "מאתיים", 3: "שלוש מאות", 4: "ארבע מאות", 5: "חמש מאות",
                                          6: "שש מאות", 7: "שבע מאות", 8: "שמונה מאות", 9: "תשע מאות"]
    static let ordMasc: [Int: String] = [1: "ראשון", 2: "שני", 3: "שלישי", 4: "רביעי", 5: "חמישי",
                                         6: "שישי", 7: "שביעי", 8: "שמיני", 9: "תשיעי", 10: "עשירי"]
    static let ordFem: [Int: String] = [1: "ראשונה", 2: "שנייה", 3: "שלישית", 4: "רביעית", 5: "חמישית",
                                        6: "שישית", 7: "שביעית", 8: "שמינית", 9: "תשיעית", 10: "עשירית"]
    static let months: [Int: String] = [1: "ינואר", 2: "פברואר", 3: "מרץ", 4: "אפריל", 5: "מאי", 6: "יוני",
                                        7: "יולי", 8: "אוגוסט", 9: "ספטמבר", 10: "אוקטובר", 11: "נובמבר", 12: "דצמבר"]
    static let monthNames = Set(months.values)

    struct Pair: Hashable { let a: Int; let b: Int }
    static let fractions: [Pair: String] = [
        Pair(a: 1, b: 2): "חצי", Pair(a: 1, b: 3): "שליש", Pair(a: 1, b: 4): "רבע", Pair(a: 2, b: 3): "שני שלישים",
        Pair(a: 3, b: 4): "שלושת רבעי", Pair(a: 1, b: 5): "חמישית", Pair(a: 2, b: 5): "שתי חמישיות",
        Pair(a: 3, b: 5): "שלוש חמישיות", Pair(a: 4, b: 5): "ארבע חמישיות", Pair(a: 1, b: 6): "שישית",
        Pair(a: 1, b: 8): "שמינית", Pair(a: 3, b: 8): "שלוש שמיניות", Pair(a: 1, b: 10): "עשירית",
    ]

    struct Unsupported: Error {}

    static func vav(_ w: String) -> String { "ו" + w }
    static func units(_ n: Int, _ g: String) -> String { (g == masc ? mascUnits : femUnits)[n] }
    static func teens(_ n: Int, _ g: String) -> String { (g == masc ? mascTeens : femTeens)[n - 11] }

    static func thousandsWords(_ k: Int) throws -> [String] {
        if k == 1 { return ["אלף"] }
        if k == 2 { return ["אלפיים"] }
        if let c = mascConstruct[k] { return [c, "אלפים"] }
        return try Py.split(cardinal(k, masc)) + ["אלף"]
    }

    static func subThousandGroups(_ n0: Int, _ g: String) -> [[String]] {
        var n = n0
        var groups: [[String]] = []
        if n >= 100 {
            groups.append(Py.split(hundreds[n / 100]!))
            n %= 100
        }
        if n >= 20 {
            var tail = [tens[n / 10]!]
            if n % 10 != 0 { tail.append(vav(units(n % 10, g))) }
            groups.append(tail)
        } else if n >= 11 {
            groups.append(Py.split(teens(n, g)))
        } else if n >= 1 {
            groups.append([units(n, g)])
        }
        return groups
    }

    /// `cardinal(n, gender, construct)`. Throws where Python would raise
    /// (KeyError past 999,999), which `expand_token` turns into passthrough.
    static func cardinal(_ n0: Int, _ g: String = fem, construct: Bool = false) throws -> String {
        if n0 < 0 { return try "מינוס " + cardinal(-n0, g, construct: construct) }
        if n0 == 0 { return "אפס" }
        var n = n0
        if construct {
            let table = g == masc ? mascConstruct : femConstruct
            if let w = table[n] { return w }
        }
        var groups: [[String]] = []
        if n >= 1000 {
            groups.append(try thousandsWords(n / 1000))
            n %= 1000
        }
        groups += subThousandGroups(n, g)
        if groups.count > 1 && !groups[groups.count - 1].contains(where: { Py.hasPrefix($0, "ו") }) {
            var last = groups[groups.count - 1]
            last[0] = vav(last[0])
            groups[groups.count - 1] = last
        }
        return groups.flatMap { $0 }.joined(separator: " ")
    }

    static func ordinal(_ n: Int, _ g: String = masc, definite: Bool = false) throws -> String {
        let table = g == masc ? ordMasc : ordFem
        if let w = table[n] { return definite ? "ה" + w : w }
        let card = try cardinal(n, g == fem ? fem : masc)
        return definite ? "ה" + card : card
    }

    static func spellDigits(_ digits: String) throws -> String {
        try digits.unicodeScalars.map { u -> String in
            guard let v = u.properties.numericValue, u.properties.numericType == .decimal else { throw Unsupported() }
            return femUnits[Int(v)]
        }.joined(separator: " ")
    }

    // MARK: gender

    static let femImPlurals: Set<String> = ["שנים", "נשים", "מילים", "ביצים", "דבורים", "חיטים", "תאנים", "פעמים",
                                            "אבנים", "עצים", "יונים", "צפרניים", "שעורים"]
    static let mascOtPlurals: Set<String> = ["שולחנות", "כיסאות", "מקומות", "לילות", "קולות", "חלומות", "רחובות",
                                             "אבות", "שמות", "לוחות", "קירות", "מטבעות", "שבועות", "רעיונות",
                                             "חלונות", "זנבות", "מזלגות", "סכינים", "אריות", "נכסים"]
    static let nounGender: [String: String] = [
        "שעה": fem, "שעות": fem, "דקה": fem, "דקות": fem, "שניה": fem, "שניות": fem,
        "שנה": fem, "שנות": fem, "מנה": fem, "מנות": fem, "כוס": fem, "כוסות": fem,
        "קומה": fem, "קומות": fem, "פעם": fem, "פעמים": fem, "בת": fem, "בנות": fem,
        "מעלה": fem, "מעלות": fem, "טיסה": fem, "טיסות": fem, "אישה": fem, "נשים": fem,
        "דירה": fem, "דירות": fem, "עונה": fem, "עונות": fem, "שורה": fem, "שורות": fem,
        "חנות": fem, "חנויות": fem, "מסעדה": fem, "מסעדות": fem, "פגישה": fem, "פגישות": fem,
        "יחידה": fem, "יחידות": fem, "משימה": fem, "משימות": fem, "מחברת": fem, "מחברות": fem,
        "מעטפה": fem, "מעטפות": fem, "חולצה": fem, "חולצות": fem, "מיטה": fem, "מיטות": fem,
        "דלת": fem, "דלתות": fem, "רגל": fem, "רגליים": fem, "יד": fem, "ידיים": fem,
        "עין": fem, "עיניים": fem, "אוזן": fem, "אוזניים": fem, "עיר": fem, "ערים": fem,
        "ארץ": fem, "דרך": fem, "נפש": fem, "כיתה": fem, "כיתות": fem,
        "שקל": masc, "שקלים": masc, "ש\"ח": masc, "אגורה": fem, "אגורות": fem,
        "דולר": masc, "דולרים": masc, "יורו": masc, "אירו": masc,
        "יום": masc, "ימים": masc, "ימי": masc, "חודש": masc, "חודשים": masc, "חודשי": masc,
        "שבוע": masc, "שבועות": masc, "איש": masc, "אנשים": masc, "ילד": masc, "ילדים": masc,
        "בן": masc, "בנים": masc, "חבר": masc, "חברים": masc, "עובד": masc, "עובדים": masc,
        "ספר": masc, "ספרים": masc, "כלב": masc, "כלבים": masc, "חתול": masc, "חתולים": masc,
        "תפוח": masc, "תפוחים": masc, "כרטיס": masc, "כרטיסים": masc,
        "מטר": masc, "מטרים": masc, "קילומטר": masc, "קילו": masc, "ליטר": masc,
        "מיליון": masc, "מיליארד": masc, "אלף": masc, "אחוז": masc, "אחוזים": masc,
        "מוצר": masc, "מוצרים": masc, "משתתף": masc, "משתתפים": masc,
        "בניין": masc, "בניינים": masc, "משרד": masc, "משרדים": masc,
        "סטודנט": masc, "סטודנטים": masc, "דייר": masc, "דיירים": masc,
        "עט": masc, "עטים": masc, "מכתב": masc, "מכתבים": masc, "כדור": masc, "כדורים": masc,
        "נרשם": masc, "נרשמים": masc, "פועל": masc, "פועלים": masc,
        "ק\"ג": masc, "ק\"מ": masc, "מ\"ר": masc, "קמ\"ש": masc, "מ\"מ": masc, "ס\"מ": masc,
    ]

    static let prefixRe = PyRegex("^(?:[בכלמשו]?ה|[בכלמשוה])")

    static func stripPrefix(_ word: String) -> String {
        if Py.len(word) > 3 {
            let stripped = prefixRe.sub(word, "", count: 1)
            if Py.len(stripped) >= 2 { return stripped }
        }
        return word
    }

    static func nounGenderOf(_ w0: String) -> String? {
        let word = Py.strip(w0, ".,!?;:\"'()[]—–-")
        if word.isEmpty { return nil }
        for cand in [word, stripPrefix(word)] {
            if let g = nounGender[cand] { return g }
            if femImPlurals.contains(cand) { return fem }
            if mascOtPlurals.contains(cand) { return masc }
        }
        let stem = stripPrefix(word)
        if Py.len(stem) < 3 { return nil }
        if Py.hasSuffix(stem, "יות") || Py.hasSuffix(stem, "ות") { return fem }
        if Py.hasSuffix(stem, "ים") || Py.hasSuffix(stem, "יים") { return masc }
        return nil
    }

    // MARK: context vocabularies

    static let codeNouns: Set<String> = ["קוד", "מספר", "מיקוד", "סיסמה", "סיסמא", "סיומת", "ברקוד", "טלפון",
                                         "שלוחה", "סניף", "מזהה", "כרטיס", "אשראי", "פוליסה", "הזמנה",
                                         "משלוח", "זהות", "ת.ז", "ת\"ז", "רישיון", "אימות", "פנימי", "סודי",
                                         "סידורי", "חשאי", "אישי", "בנק", "גישה", "ז", "מנעול"]
    static let ordinalNouns: Set<String> = ["קומה", "פעם", "מקום", "פרק", "חלק", "עונה", "טסט", "שורה", "שלב",
                                            "כיתה", "רבעון", "סיבוב", "מחזור"]
    static let hourCues: Set<String> = ["שעה", "השעה", "בשעה", "לשעה", "שעון", "השעון"]
    static let dayOfMonthCues: Set<String> = ["לחודש", "בחודש", "החודש"]
    static let yearCues: Set<String> = ["שנת", "בשנת", "משנת", "לשנת", "שנה", "השנה"]
    static let punctTail = ".,!?;:\"')]…"

    static func hourWord(_ h0: Int) throws -> String {
        var h = ((h0 % 24) + 24) % 24
        if h == 0 { h = 12 }
        if h > 12 { h -= 12 }
        return try cardinal(h, fem)
    }

    static func expandTime(_ hh: Int, _ mm: Int) throws -> String {
        let hour = try hourWord(hh)
        if mm == 0 { return hour }
        if mm == 15 { return hour + " ורבע" }
        if mm == 30 { return hour + " וחצי" }
        if mm == 45 { return try "רבע ל" + hourWord(hh + 1) }
        if mm < 30 { return try hour + " " + vav(cardinal(mm, masc)) }
        if mm > 30 { return try cardinal(60 - mm, masc) + " ל" + hourWord(hh + 1) }
        return hour
    }

    static func expandDate(_ day: Int, _ month: Int, _ year: Int?) throws -> String {
        guard let mname = months[month] else { throw Unsupported() }
        var out = try cardinal(day, masc) + " ב" + mname
        if let y = year { out += try " " + cardinal(y, fem) }
        return out
    }

    static func decimalWords(_ intPart: String, _ fracPart: String, _ g: String) throws -> String {
        guard let ip = TextNormalizer.pyInt(intPart) else { throw Unsupported() }
        let fp = fracPart
        if fp == "5" {
            if ip == 0 { return "חצי" }
            return try cardinal(ip, g) + " וחצי"
        }
        if Py.len(fp) == 2 {
            guard let f = TextNormalizer.pyInt(fp) else { throw Unsupported() }
            return try cardinal(ip, ip != 1 ? fem : masc) + " " + cardinal(f, fem)
        }
        let head = try ip == 1 ? cardinal(ip, masc) : cardinal(ip, fem)
        return try head + " נקודה " + spellDigits(fp)
    }

    static func groupedDigits(_ groups: [String]) throws -> String {
        if let g0 = groups.first, (g0 == "1" || g0 == "*"), groups.count > 1, Py.len(groups[1]) == 3 {
            var out: [String] = []
            if Py.len(g0) > 1 {
                out.append(try spellDigits(g0))
            } else {
                guard let v = TextNormalizer.pyInt(g0) else { throw Unsupported() }  // int("*") raises
                out.append(femUnits[v])
            }
            if Py.len(g0) == 1 {
                guard let v = TextNormalizer.pyInt(g0) else { throw Unsupported() }
                out[0] = mascUnits[v]
            }
            for g in groups.dropFirst() {
                guard let v = TextNormalizer.pyInt(g) else { throw Unsupported() }
                out.append(try cardinal(v, fem))
            }
            return out.joined(separator: " ")
        }
        return try groups.map { try spellDigits($0) }.joined(separator: " ")
    }

    // MARK: token driver

    static let heb = "\\u0590-\\u05EA"
    static let tokenRe = PyRegex(
        "^(?<pre>[\(heb)\"']{0,4})(?<sep>-?)(?<body>\\d[\\d.,:/%\\-]*?)(?<post>[\\.,!\\?;:\"'\\)\\]…]*)$"
    )

    static func nextNounGender(_ next: ArraySlice<String>) -> String? {
        guard let w = next.first else { return nil }
        return nounGenderOf(w)
    }

    static func isCodeContext(_ prev0: ArraySlice<String>) -> Bool {
        var prev = prev0
        var i = prev.endIndex - 1
        while i >= prev.startIndex {
            if prev[i].unicodeScalars.contains(where: { Py.isDigit($0) }) {
                prev = prev[(i + 1)...]
                break
            }
            i -= 1
        }
        for w in prev.suffix(3) {
            let base = Py.strip(w, punctTail + "-")
            if codeNouns.contains(base) || codeNouns.contains(stripPrefix(base)) { return true }
        }
        return false
    }

    static func prevBase(_ prev: ArraySlice<String>, _ k: Int = 1) -> String {
        if prev.count < k { return "" }
        return Py.strip(prev[prev.endIndex - k], punctTail + "-")
    }

    static let monthPrefixRe = PyRegex("^[בלמה]")

    static func monthFollows(_ next: ArraySlice<String>) -> Bool {
        guard let first = next.first else { return false }
        let w = Py.strip(first, punctTail)
        if dayOfMonthCues.contains(w) { return true }
        let stripped = monthPrefixRe.sub(w, "", count: 1)
        return monthNames.contains(w) || monthNames.contains(stripped)
    }

    static func expandInteger(_ body: String, _ pre: String, _ prev: ArraySlice<String>,
                              _ next: ArraySlice<String>) throws -> String {
        let digits = body
        guard let n = TextNormalizer.pyInt(digits) else { throw Unsupported() }
        let nd = Py.len(digits)
        let first = digits.unicodeScalars.first!
        if nd >= 5 || (nd >= 3 && isCodeContext(prev))
            || (nd > 1 && first == "0") {
            return try spellDigits(digits)
        }
        if yearCues.contains(prevBase(prev)) {
            return try cardinal(n, fem)
        }
        if monthFollows(next) && 1 <= n && n <= 31 {
            return try cardinal(n, masc)
        }
        let prevW = prevBase(prev)
        let prevStripped = ordinalNouns.contains(prevW) ? prevW : stripPrefix(prevW)
        if Py.hasSuffix(pre, "ה") && n <= 999 {
            let g = nounGender[prevStripped] ?? nounGenderOf(prevW) ?? masc
            return try ordinal(n, g)
        }
        if ordinalNouns.contains(prevStripped) && n <= 10 {
            return try ordinal(n, nounGender[prevStripped] ?? masc)
        }
        if let g = nextNounGender(next) {
            if n == 2 { return try cardinal(2, g, construct: true) }
            return try cardinal(n, g)
        }
        if ["ב", "מ", "ל"].contains(pre) || ["עד", "ועד"].contains(prevW)
            || hourCues.contains(prevW) || hourCues.contains(prevBase(prev, 2)) {
            if 0 <= n && n <= 24 && !isCodeContext(prev) {
                return try hourWord(n)
            }
        }
        return try cardinal(n, n == 1 ? masc : fem)
    }

    static let percentGroupedRe = PyRegex("\\d{1,3}(?:,\\d{3})+")
    static let clockRe = PyRegex("(\\d{1,2}):(\\d{2})")
    static let slashRe = PyRegex("(\\d{1,2})/(\\d{1,4})")
    static let dmyRe = PyRegex("(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})")
    static let myRe = PyRegex("(\\d{1,2})\\.(\\d{4})")
    static let decimalRe = PyRegex("(\\d+)\\.(\\d+)")
    static let digitRunRe = PyRegex("\\d+")

    static func expandBody(_ body: String, _ pre: String, _ prev: ArraySlice<String>,
                           _ next: ArraySlice<String>) throws -> String {
        if Py.hasSuffix(body, "%") {
            var core = String(body.unicodeScalars.dropLast())
            if percentGroupedRe.fullmatch(core) != nil { core = Py.replace(core, ",", "") }
            let tail = (next.first.map { ["אחוז", "אחוזים"].contains(Py.strip($0, punctTail)) } ?? false) ? "" : " אחוז"
            if Py.contains(core, ".") {
                let parts = core.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
                return try decimalWords(parts[0], parts.count > 1 ? parts[1] : "", masc) + tail
            }
            guard let v = TextNormalizer.pyInt(core) else { throw Unsupported() }
            return try cardinal(v, masc) + tail
        }
        if let m = clockRe.fullmatch(body) {
            return try expandTime(TextNormalizer.pyInt(m.group(1)!)!, TextNormalizer.pyInt(m.group(2)!)!)
        }
        if let m = slashRe.fullmatch(body) {
            let a = TextNormalizer.pyInt(m.group(1)!)!, b = TextNormalizer.pyInt(m.group(2)!)!
            if let f = fractions[Pair(a: a, b: b)] { return f }
            if 1 <= b && b <= 12 && 1 <= a && a <= 31 { return try expandDate(a, b, nil) }
            return try cardinal(a, fem) + " " + cardinal(b, fem)
        }
        if Py.contains(body, "-") {
            let groups = body.components(separatedBy: "-")
            if groups.count >= 2 && groups.allSatisfy({ g in !g.isEmpty && g.unicodeScalars.allSatisfy { Py.isDigit($0) } }) {
                if groups.count >= 3 || groups.contains(where: { Py.len($0) >= 5 }) {
                    return try groupedDigits(groups)
                }
                if groups.allSatisfy({ Py.len($0) <= 2 }) {
                    return try groups.map { g -> String in
                        guard let v = TextNormalizer.pyInt(g) else { throw Unsupported() }
                        return try cardinal(v, fem)
                    }.joined(separator: " ")
                }
                return try groupedDigits(groups)
            }
        }
        if percentGroupedRe.fullmatch(body) != nil {
            guard let n = TextNormalizer.pyInt(Py.replace(body, ",", "")) else { throw Unsupported() }
            let g = nextNounGender(next)
            if n >= 1_000_000 {
                let head = n / 1_000_000, rest = n % 1_000_000
                let word = head == 1 ? "מיליון" : try cardinal(head, masc, construct: true) + " מיליון"
                return rest == 0 ? word : try word + " " + cardinal(rest, g ?? masc)
            }
            return try cardinal(n, g ?? masc)
        }
        if let m = dmyRe.fullmatch(body) {
            let d = TextNormalizer.pyInt(m.group(1)!)!, mo = TextNormalizer.pyInt(m.group(2)!)!
            let y = TextNormalizer.pyInt(m.group(3)!)!
            if 1 <= d && d <= 31 && 1 <= mo && mo <= 12 { return try expandDate(d, mo, y) }
        }
        if let m = myRe.fullmatch(body), let mo = TextNormalizer.pyInt(m.group(1)!), 1 <= mo && mo <= 12 {
            return try "ב" + months[mo]! + " " + cardinal(TextNormalizer.pyInt(m.group(2)!)!, fem)
        }
        if let m = decimalRe.fullmatch(body) {
            let ipS = m.group(1)!, fpS = m.group(2)!
            let ip = TextNormalizer.pyInt(ipS)!, fp = TextNormalizer.pyInt(fpS)!
            let clockCue = hourCues.contains(prevBase(prev))
            let unitFollows = next.first.map { nounGenderOf($0) != nil } ?? false
            if !clockCue && ["ב", "ל", "ה"].contains(pre) && Py.len(fpS) <= 2
                && 1 <= fp && fp <= 12 && 1 <= ip && ip <= 31 && !unitFollows {
                return try expandDate(ip, fp, nil)
            }
            if clockCue && Py.len(fpS) == 2 { return try expandTime(ip, fp) }
            let g = nextNounGender(next)
            return try decimalWords(ipS, fpS, g ?? fem)
        }
        if !body.isEmpty && body.unicodeScalars.allSatisfy({ Py.isDigit($0) }) {
            return try expandInteger(body, pre, prev, next)
        }
        var failed = false
        let out = digitRunRe.sub(body) { mm in
            guard let v = TextNormalizer.pyInt(mm.value), let w = try? cardinal(v, fem) else { failed = true; return mm.value }
            return w
        }
        if failed { throw Unsupported() }
        return out
    }

    static func expandToken(_ token: String, _ prev: ArraySlice<String>, _ next: ArraySlice<String>) -> String {
        if !token.unicodeScalars.contains(where: { Py.isDigit($0) }) { return token }
        guard let m = tokenRe.match(token), m.range.upperBound == token.endIndex else {
            var failed = false
            let out = digitRunRe.sub(token) { mm in
                guard let v = TextNormalizer.pyInt(mm.value), let w = try? cardinal(v, fem) else { failed = true; return mm.value }
                return w
            }
            return failed ? token : out
        }
        let pre = m.group("pre") ?? "", body = m.group("body") ?? "", post = m.group("post") ?? ""
        do {
            var words = try expandBody(body, pre, prev, next)
            if !pre.isEmpty { words = pre + words }
            return words + post
        } catch {
            return token
        }
    }

    static let hasDigitRe = PyRegex("\\d")

    static func containsDigit(_ text: String) -> Bool { hasDigitRe.search(text) != nil }

    /// `normalize_numbers`.
    static func normalize(_ text: String) -> String {
        if !containsDigit(text) { return text }
        let tokens = Py.split(text)
        var out: [String] = []
        for (i, tok) in tokens.enumerated() {
            if containsDigit(tok) {
                out.append(expandToken(tok, tokens[..<i], tokens[(i + 1)...]))
            } else {
                out.append(tok)
            }
        }
        return out.joined(separator: " ")
    }
}
