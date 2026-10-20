import Foundation

/// A thin Python-`re`-flavoured wrapper over `NSRegularExpression` (ICU).
///
/// The normalizer and the G2P were ported line by line from Python, so the call
/// sites read like the original (`sub`, `split`, `finditer`, `fullmatch`). All
/// patterns are compiled once (they live in `static let`s) and are matched on
/// the UTF-16 view, which ICU walks by code point, so astral-plane ranges and
/// lookbehinds behave like Python's.
struct PyRegex: @unchecked Sendable {
    let regex: NSRegularExpression

    init(_ pattern: String, ignoreCase: Bool = false, dotAll: Bool = false) {
        var opts: NSRegularExpression.Options = []
        if ignoreCase { opts.insert(.caseInsensitive) }
        if dotAll { opts.insert(.dotMatchesLineSeparators) }
        do {
            regex = try NSRegularExpression(pattern: pattern, options: opts)
        } catch {
            fatalError("bad regex \(pattern): \(error)")
        }
    }

    struct Match {
        let string: String
        let result: NSTextCheckingResult

        var range: Range<String.Index> { Range(result.range, in: string)! }
        var nsRange: NSRange { result.range }
        var value: String { String(string[range]) }

        /// Group `i`, or nil when the group did not participate (Python's `None`).
        func group(_ i: Int) -> String? {
            let r = result.range(at: i)
            guard r.location != NSNotFound, let rr = Range(r, in: string) else { return nil }
            return String(string[rr])
        }

        func group(_ name: String) -> String? {
            let r = result.range(withName: name)
            guard r.location != NSNotFound, let rr = Range(r, in: string) else { return nil }
            return String(string[rr])
        }
    }

    func finditer(_ s: String) -> [Match] {
        regex.matches(in: s, range: NSRange(s.startIndex..., in: s)).map { Match(string: s, result: $0) }
    }

    func search(_ s: String) -> Match? {
        regex.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)).map { Match(string: s, result: $0) }
    }

    func matches(_ s: String) -> Bool { search(s) != nil }

    /// `re.match`: anchored at the start only.
    func match(_ s: String) -> Match? {
        regex.firstMatch(in: s, options: [.anchored], range: NSRange(s.startIndex..., in: s))
            .map { Match(string: s, result: $0) }
    }

    /// `re.fullmatch`.
    func fullmatch(_ s: String) -> Match? {
        let full = NSRange(s.startIndex..., in: s)
        // Try every match anchored at 0 and keep the one spanning the whole string.
        // ICU has no fullmatch flag, so wrap the pattern instead.
        let wrapped = PyRegex.fullCache(for: regex)
        guard let m = wrapped.firstMatch(in: s, options: [.anchored], range: full),
              m.range.location == 0, m.range.length == full.length else { return nil }
        return Match(string: s, result: m)
    }

    /// `re.sub` with a replacement closure. `count == 0` replaces all.
    func sub(_ s: String, count: Int = 0, _ repl: (Match) -> String) -> String {
        let ms = regex.matches(in: s, range: NSRange(s.startIndex..., in: s))
        if ms.isEmpty { return s }
        var out = ""
        var last = s.startIndex
        var n = 0
        for m in ms {
            if count > 0 && n >= count { break }
            let r = Range(m.range, in: s)!
            out += s[last..<r.lowerBound]
            out += repl(Match(string: s, result: m))
            last = r.upperBound
            n += 1
        }
        out += s[last...]
        return out
    }

    /// `re.sub` with a literal replacement (no group references).
    func sub(_ s: String, _ literal: String, count: Int = 0) -> String {
        sub(s, count: count) { _ in literal }
    }

    /// `re.split`: captured groups are interleaved in the result, like Python.
    func split(_ s: String) -> [String] {
        let ms = regex.matches(in: s, range: NSRange(s.startIndex..., in: s))
        var out: [String] = []
        var last = s.startIndex
        for m in ms {
            let r = Range(m.range, in: s)!
            // Python skips empty matches adjacent to the previous match end only in
            // corner cases; none of the ported patterns can match empty.
            out.append(String(s[last..<r.lowerBound]))
            if m.numberOfRanges > 1 {
                for g in 1..<m.numberOfRanges {
                    let gr = m.range(at: g)
                    if gr.location == NSNotFound {
                        out.append("")
                    } else {
                        out.append(String(s[Range(gr, in: s)!]))
                    }
                }
            }
            last = r.upperBound
        }
        out.append(String(s[last...]))
        return out
    }

    // MARK: fullmatch support

    private static let lock = NSLock()
    nonisolated(unsafe) private static var full: [String: NSRegularExpression] = [:]

    private static func fullCache(for r: NSRegularExpression) -> NSRegularExpression {
        lock.lock()
        defer { lock.unlock() }
        let key = "\(r.options.rawValue)|\(r.pattern)"
        if let c = full[key] { return c }
        // A trailing \z after a non-capturing group forces a match spanning the input.
        let c = try! NSRegularExpression(pattern: "(?:\(r.pattern))\\z", options: r.options)
        full[key] = c
        return c
    }
}

// MARK: - Python string helpers

enum Py {
    /// Python's `str.isspace()` for one scalar.
    static func isSpace(_ u: Unicode.Scalar) -> Bool {
        switch u.value {
        case 0x09...0x0D, 0x1C...0x1F, 0x20, 0x85, 0xA0, 0x1680, 0x2000...0x200A,
             0x2028, 0x2029, 0x202F, 0x205F, 0x3000:
            return true
        default:
            return false
        }
    }

    /// Python's `str.isalpha()` for one scalar (general category L*).
    static func isAlpha(_ u: Unicode.Scalar) -> Bool {
        switch u.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter:
            return true
        default:
            return false
        }
    }

    /// Python's `str.isdigit()` for one scalar (approximated by Nd + No digits).
    static func isDigit(_ u: Unicode.Scalar) -> Bool {
        if u.properties.generalCategory == .decimalNumber { return true }
        return u.properties.numericType == .digit
    }

    static func isDecimal(_ u: Unicode.Scalar) -> Bool {
        u.properties.generalCategory == .decimalNumber
    }

    static func isAsciiAlpha(_ u: Unicode.Scalar) -> Bool {
        (u.value >= 0x41 && u.value <= 0x5A) || (u.value >= 0x61 && u.value <= 0x7A)
    }

    /// `str.strip()` (whitespace).
    static func strip(_ s: String) -> String {
        let sc = Array(s.unicodeScalars)
        var a = 0, b = sc.count
        while a < b && isSpace(sc[a]) { a += 1 }
        while b > a && isSpace(sc[b - 1]) { b -= 1 }
        return String(String.UnicodeScalarView(sc[a..<b]))
    }

    static func lstrip(_ s: String) -> String {
        let sc = Array(s.unicodeScalars)
        var a = 0
        while a < sc.count && isSpace(sc[a]) { a += 1 }
        return String(String.UnicodeScalarView(sc[a...]))
    }

    static func rstrip(_ s: String) -> String {
        let sc = Array(s.unicodeScalars)
        var b = sc.count
        while b > 0 && isSpace(sc[b - 1]) { b -= 1 }
        return String(String.UnicodeScalarView(sc[..<b]))
    }

    /// `str.strip(chars)`.
    static func strip(_ s: String, _ chars: String) -> String {
        let set = Set(chars.unicodeScalars)
        let sc = Array(s.unicodeScalars)
        var a = 0, b = sc.count
        while a < b && set.contains(sc[a]) { a += 1 }
        while b > a && set.contains(sc[b - 1]) { b -= 1 }
        return String(String.UnicodeScalarView(sc[a..<b]))
    }

    static func lstrip(_ s: String, _ chars: String) -> String {
        let set = Set(chars.unicodeScalars)
        let sc = Array(s.unicodeScalars)
        var a = 0
        while a < sc.count && set.contains(sc[a]) { a += 1 }
        return String(String.UnicodeScalarView(sc[a...]))
    }

    static func rstrip(_ s: String, _ chars: String) -> String {
        let set = Set(chars.unicodeScalars)
        let sc = Array(s.unicodeScalars)
        var b = sc.count
        while b > 0 && set.contains(sc[b - 1]) { b -= 1 }
        return String(String.UnicodeScalarView(sc[..<b]))
    }

    /// `str.split()` with no separator: runs of whitespace, no empty strings.
    static func split(_ s: String) -> [String] {
        var out: [String] = []
        var cur = String.UnicodeScalarView()
        for u in s.unicodeScalars {
            if isSpace(u) {
                if !cur.isEmpty { out.append(String(cur)); cur = String.UnicodeScalarView() }
            } else {
                cur.append(u)
            }
        }
        if !cur.isEmpty { out.append(String(cur)) }
        return out
    }

    /// `str.split(sep)` with an explicit separator (keeps empty pieces).
    static func split(_ s: String, sep: String) -> [String] {
        s.components(separatedBy: sep)
    }

    /// Code-point length (`len()` in Python).
    static func len(_ s: String) -> Int { s.unicodeScalars.count }

    static func scalars(_ s: String) -> [Unicode.Scalar] { Array(s.unicodeScalars) }

    static func string(_ sc: some Sequence<Unicode.Scalar>) -> String {
        var v = String.UnicodeScalarView()
        v.append(contentsOf: sc)
        return String(v)
    }

    /// Literal (non-canonical-equivalence) replace, like Python `str.replace`.
    static func replace(_ s: String, _ old: String, _ new: String) -> String {
        s.replacingOccurrences(of: old, with: new, options: .literal)
    }

    /// Literal `in`.
    static func contains(_ s: String, _ needle: String) -> Bool {
        s.range(of: needle, options: .literal) != nil
    }

    static func hasSuffix(_ s: String, _ suf: String) -> Bool {
        let a = Array(s.unicodeScalars), b = Array(suf.unicodeScalars)
        return a.count >= b.count && Array(a[(a.count - b.count)...]) == b
    }

    static func hasPrefix(_ s: String, _ pre: String) -> Bool {
        let a = Array(s.unicodeScalars), b = Array(pre.unicodeScalars)
        return a.count >= b.count && Array(a[..<b.count]) == b
    }

    /// Exact code-point equality (Swift `==` is canonical equivalence).
    static func eq(_ a: String, _ b: String) -> Bool {
        a.unicodeScalars.elementsEqual(b.unicodeScalars)
    }

    static func isHebrewBlock(_ u: Unicode.Scalar) -> Bool { u.value >= 0x0590 && u.value <= 0x05FF }
}
