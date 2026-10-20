import Foundation

/// Port of the two `num2words` converters the normalizer calls: `lang="he"`
/// (`lang_HE.py`) and `lang="en"` (`lang_EN.py` over `lang_EU`/`base`).
///
/// Only the entry points reachable from `text_norm.py` are ported:
/// cardinals of ints and floats for both languages, and English ordinals.
/// Anything else returns nil, which the normalizer treats like Python's
/// `except Exception: return None`.
enum Num2Words {
    /// A number as `text_norm` hands it to `num2words`: Python int or float.
    enum Value: Sendable {
        case int(Int)
        case float(Double)
    }

    static func cardinal(_ v: Value, lang: String) -> String? {
        switch lang {
        case "he": return Hebrew.toCardinal(v, gender: "f")
        case "en": return English.toCardinal(v)
        default: return nil
        }
    }

    static func ordinal(_ n: Int, lang: String) -> String? {
        switch lang {
        case "en": return English.toOrdinal(n)
        case "he": return Hebrew.toOrdinal(n, gender: "m")
        default: return nil
        }
    }

    // MARK: - float2tuple (base.py)

    /// `Num2Word_Base.float2tuple`: (pre, post, precision).
    static func float2tuple(_ value: Double) -> (Int, Int, Int)? {
        guard value.isFinite, abs(value) < 9.2e18 else { return nil }
        let pre = Int(value)  // trunc toward zero, like int()
        let precision = decimalExponent(of: value)
        let post = abs(value - Double(pre)) * pow(10.0, Double(precision))
        let postInt: Int
        if abs(post.rounded(.toNearestOrEven) - post) < 0.01 {
            postInt = Int(post.rounded(.toNearestOrEven))
        } else {
            postInt = Int(post.rounded(.down))
        }
        return (pre, postInt, precision)
    }

    /// `abs(Decimal(str(value)).as_tuple().exponent)` for the decimal forms
    /// `float(raw)` can produce from `\d+(?:[.,]\d+)?`.
    static func decimalExponent(of value: Double) -> Int {
        let repr = pyFloatRepr(value)
        if let e = repr.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            let mant = String(repr[..<e])
            let exp = Int(repr[repr.index(after: e)...]) ?? 0
            let fracDigits = mant.split(separator: ".", omittingEmptySubsequences: false).dropFirst().first?.count ?? 0
            return abs(exp - fracDigits)
        }
        if let dot = repr.firstIndex(of: ".") {
            return repr.distance(from: repr.index(after: dot), to: repr.endIndex)
        }
        return 0
    }

    /// Python `repr(float)`: shortest round-tripping digits, ".0" for integral values.
    static func pyFloatRepr(_ v: Double) -> String {
        var s = "\(v)"  // Swift also prints the shortest round-trip form
        if !s.contains(".") && !s.contains("e") && !s.contains("n") && !s.contains("i") {
            s += ".0"
        }
        return s
    }

    // MARK: - Hebrew (lang_HE.py)

    enum Hebrew {
        static let zero = "אפס"
        static let ones: [Int: [String]] = [
            1: ["אחת", "אחד", "אחת", "אחד", "ראשונה", "ראשון", "ראשונות", "ראשונים"],
            2: ["שתיים", "שניים", "שתי", "שני", "שנייה", "שני", "שניות", "שניים"],
            3: ["שלוש", "שלושה", "שלוש", "שלושת", "שלישית", "שלישי", "שלישיות", "שלישיים"],
            4: ["ארבע", "ארבעה", "ארבע", "ארבעת", "רביעית", "רביעי", "רביעיות", "רביעיים"],
            5: ["חמש", "חמישה", "חמש", "חמשת", "חמישית", "חמישי", "חמישיות", "חמישיים"],
            6: ["שש", "שישה", "שש", "ששת", "שישית", "שישי", "שישיות", "שישיים"],
            7: ["שבע", "שבעה", "שבע", "שבעת", "שביעית", "שביעי", "שביעיות", "שביעיים"],
            8: ["שמונה", "שמונה", "שמונה", "שמונת", "שמינית", "שמיני", "שמיניות", "שמיניים"],
            9: ["תשע", "תשעה", "תשע", "תשעת", "תשיעית", "תשיעי", "תשיעיות", "תשיעיים"],
        ]
        static let tens: [Int: [String]] = [
            0: ["עשר", "עשרה", "עשר", "עשרת", "עשירית", "עשירי", "עשיריות", "עשיריים"],
            1: ["עשרה", "עשר"],
            2: ["שתים עשרה", "שנים עשר"],
        ]
        static let twenties: [Int: String] = [
            2: "עשרים", 3: "שלושים", 4: "ארבעים", 5: "חמישים",
            6: "שישים", 7: "שבעים", 8: "שמונים", 9: "תשעים",
        ]
        static let hundreds: [Int: [String]] = [1: ["מאה", "מאת"], 2: ["מאתיים"], 3: ["מאות"]]
        static let thousands: [Int: [String]] = [1: ["אלף"], 2: ["אלפיים"], 3: ["אלפים", "אלפי"]]
        static let large: [Int: [String]] = [
            1: ["מיליון", "מיליוני"], 2: ["מיליארד", "מיליארדי"], 3: ["טריליון", "טריליוני"],
            4: ["קוודריליון", "קוודריליוני"], 5: ["קווינטיליון", "קווינטיליוני"],
            6: ["סקסטיליון", "סקסטיליוני"],
        ]
        static let and = "ו"
        static let def = "ה"

        /// `get_digits`: [units, tens, hundreds] of the last three digits.
        static func digits(_ x: Int) -> (Int, Int, Int) {
            let v = x % 1000
            return (v % 10, (v / 10) % 10, v / 100)
        }

        static func splitbyx(_ n: String, _ x: Int) -> [Int] {
            let chars = Array(n)
            let length = chars.count
            if length <= x { return [Int(n)!] }
            var out: [Int] = []
            let start = length % x
            if start > 0 { out.append(Int(String(chars[..<start]))!) }
            var i = start
            while i < length {
                out.append(Int(String(chars[i..<min(i + x, length)]))!)
                i += x
            }
            return out
        }

        static func chunk2word(_ n: Int, _ i: Int, _ x: Int, gender: String, construct: Bool,
                               ordinal: Bool, plural: Bool) -> [String] {
            var words: [String] = []
            let (n1, n2, n3) = digits(x)
            if n3 > 0 {
                if construct && n == 100 {
                    words.append(hundreds[n3]![1])
                } else if n3 <= 2 {
                    words.append(hundreds[n3]![0])
                } else {
                    words.append(ones[n3]![0] + " " + hundreds[3]![0])
                }
            }
            if n2 > 1 {
                words.append(twenties[n2]!)
            }
            if i == 0 || x >= 11 {
                let male = (gender == "m" || i > 0) ? 1 : 0
                let cop = (2 * ((construct && i == 0) ? 1 : 0) + 4 * (ordinal ? 1 : 0) + 2 * (plural ? 1 : 0))
                    * (n < 11 ? 1 : 0)
                if n2 == 1 {
                    if n1 == 0 {
                        words.append(tens[n1]![male + cop])
                    } else if n1 == 2 {
                        words.append(tens[n1]![male])
                    } else {
                        words.append(ones[n1]![male] + " " + tens[1]![male])
                    }
                } else if n1 > 0 {
                    words.append(ones[n1]![male + cop])
                }
            }
            let p = pow1000(i)
            let constructLast = construct && (p > 0 && n % p == 0)
            let cl = constructLast ? 1 : 0
            if i == 1 {
                if x >= 11 {
                    words[words.count - 1] = words[words.count - 1] + " " + thousands[1]![0]
                } else if n1 == 0 {
                    words.append(tens[0]![3] + " " + thousands[3]![cl])
                } else if n1 <= 2 {
                    words.append(thousands[n1]![0])
                } else {
                    words.append(ones[n1]![3] + " " + thousands[3]![cl])
                }
            } else if i > 1 {
                guard let big = large[i - 1] else { return words }
                if x >= 11 {
                    words[words.count - 1] = words[words.count - 1] + " " + big[cl]
                } else if n1 == 0 {
                    words.append(tens[0]![1 + 2 * cl] + " " + big[cl])
                } else if n1 == 1 {
                    words.append(big[0])
                } else {
                    let idx = 1 + 2 * ((constructLast || x == 2) ? 1 : 0)
                    words.append(ones[n1]![idx] + " " + big[cl])
                }
            }
            return words
        }

        static func pow1000(_ i: Int) -> Int {
            var p = 1
            for _ in 0..<i {
                let (r, o) = p.multipliedReportingOverflow(by: 1000)
                if o { return 0 }
                p = r
            }
            return p
        }

        static func int2word(_ n: Int, gender: String = "f", construct: Bool = false,
                             ordinal: Bool = false, definite: Bool = false, plural: Bool = false) -> String? {
            if n == 0 { return ordinal ? def + zero : zero }
            guard n > 0 else { return nil }
            var words: [String] = []
            let chunks = splitbyx(String(n), 3)
            var i = chunks.count
            for x in chunks {
                i -= 1
                if x == 0 { continue }
                if i > 1 && large[i - 1] == nil { return nil }
                words += chunk2word(n, i, x, gender: gender, construct: construct, ordinal: ordinal, plural: plural)
                if words.count > 1 {
                    words[words.count - 1] = and + words[words.count - 1]
                }
            }
            if ordinal && (n >= 11 || definite) {
                words[0] = def + words[0]
            }
            return words.joined(separator: " ")
        }

        static func toCardinal(_ v: Value, gender: String) -> String? {
            switch v {
            case .int(let n):
                var out = ""
                var value = n
                if value < 0 { value = -value; out = "מינוס " }
                guard let w = int2word(value, gender: gender) else { return nil }
                return out + w
            case .float(let d):
                if d == d.rounded(.towardZero) && abs(d) < 9.2e18 {
                    // `int(value) == value` holds for integral floats: cardinal path.
                    return toCardinal(.int(Int(d)), gender: gender)
                }
                return toCardinalFloat(d, gender: gender)
            }
        }

        static func toCardinalFloat(_ d: Double, gender: String) -> String? {
            guard let (pre, post, precision) = float2tuple(d) else { return nil }
            var postS = String(post)
            if postS.count < precision { postS = String(repeating: "0", count: precision - postS.count) + postS }
            guard let head = toCardinal(.int(pre), gender: gender) else { return nil }
            var out = [head]
            if precision > 0 { out.append("נקודה") }
            let digits = Array(postS)
            for i in 0..<precision {
                guard i < digits.count, let curr = Int(String(digits[i])),
                      let w = toCardinal(.int(curr), gender: "f") else { return nil }
                out.append(w)
            }
            return out.joined(separator: " ")
        }

        static func toOrdinal(_ n: Int, gender: String) -> String? {
            guard n >= 0 else { return nil }
            return int2word(n, gender: gender, ordinal: true)
        }
    }

    // MARK: - English (lang_EN.py over lang_EU / base)

    enum English {
        /// `cards` in OrderedDict order: high (descending), mid, low (descending).
        static let cards: [(Int, String)] = {
            var c: [(Int, String)] = []
            // high numwords reachable within Int64: 10^18 .. 10^6
            let high: [(Int, String)] = [
                (1_000_000_000_000_000_000, "quintillion"),
                (1_000_000_000_000_000, "quadrillion"),
                (1_000_000_000_000, "trillion"),
                (1_000_000_000, "billion"),
                (1_000_000, "million"),
            ]
            c += high
            c += [(1000, "thousand"), (100, "hundred"), (90, "ninety"), (80, "eighty"), (70, "seventy"),
                  (60, "sixty"), (50, "fifty"), (40, "forty"), (30, "thirty")]
            let low = ["twenty", "nineteen", "eighteen", "seventeen", "sixteen", "fifteen", "fourteen",
                       "thirteen", "twelve", "eleven", "ten", "nine", "eight", "seven", "six", "five",
                       "four", "three", "two", "one", "zero"]
            for (k, w) in low.enumerated() { c.append((low.count - 1 - k, w)) }
            return c
        }()
        static let cardWord: [Int: String] = Dictionary(uniqueKeysWithValues: cards.map { ($0.0, $0.1) })

        /// Python's nested `splitnum` output: a pair, or a list of nodes.
        indirect enum Node {
            case pair(String, Int)
            case list([Node])
        }

        static func splitnum(_ value: Int) -> [Node] {
            for (elem, _) in cards {
                if elem > value { continue }
                var out: [Node] = []
                let div: Int, mod: Int
                if value == 0 { div = 1; mod = 0 } else { div = value / elem; mod = value % elem }
                if div == 1 {
                    out.append(.pair(cardWord[1]!, 1))
                } else {
                    if div == value {
                        // "system tallies": unreachable for these cards (elem == 1 only below 2).
                        return [.pair(String(repeating: cardWord[elem]!, count: div), div * elem)]
                    }
                    out.append(.list(splitnum(div)))
                }
                out.append(.pair(cardWord[elem]!, elem))
                if mod != 0 {
                    out.append(.list(splitnum(mod)))
                }
                return out
            }
            return []
        }

        static func merge(_ l: (String, Int), _ r: (String, Int)) -> (String, Int) {
            let (ltext, lnum) = l, (rtext, rnum) = r
            if lnum == 1 && rnum < 100 { return (rtext, rnum) }
            if 100 > lnum && lnum > rnum { return ("\(ltext)-\(rtext)", lnum + rnum) }
            if lnum >= 100 && 100 > rnum { return ("\(ltext) and \(rtext)", lnum + rnum) }
            if rnum > lnum { return ("\(ltext) \(rtext)", lnum * rnum) }
            return ("\(ltext), \(rtext)", lnum + rnum)
        }

        /// `Num2Word_Base.clean`.
        static func clean(_ input: [Node]) -> (String, Int) {
            var val = input
            var out = val
            while val.count != 1 {
                out = []
                let left = val[0], right = val[1]
                if case .pair(let lt, let ln) = left, case .pair(let rt, let rn) = right {
                    let m = merge((lt, ln), (rt, rn))
                    out.append(.pair(m.0, m.1))
                    if val.count > 2 {
                        out.append(.list(Array(val[2...])))
                    }
                } else {
                    for elem in val {
                        if case .list(let l) = elem {
                            if l.count == 1 {
                                out.append(l[0])
                            } else {
                                let c = clean(l)
                                out.append(.pair(c.0, c.1))
                            }
                        } else {
                            out.append(elem)
                        }
                    }
                }
                val = out
            }
            // `out[0]` — a pair at this point for every reachable input.
            if case .pair(let t, let n) = out[0] { return (t, n) }
            if case .list(let l) = out[0] { return clean(l) }
            return ("", 0)
        }

        static func toCardinal(_ v: Value) -> String? {
            switch v {
            case .int(let n):
                var value = n
                var out = ""
                if value < 0 { value = -value; out = "minus " }
                if value >= 1_000_000_000_000_000_000 * 1 && value / 1000 >= 1_000_000_000_000_000 {
                    // beyond the cards we carry (MAXVAL is far larger in Python, but Int64 caps us)
                }
                let (words, _) = clean(splitnum(value))
                return out + words
            case .float(let d):
                if d == d.rounded(.towardZero) && abs(d) < 9.2e18 {
                    return toCardinal(.int(Int(d)))
                }
                guard let (pre, post, precision) = float2tuple(d) else { return nil }
                var postS = String(post)
                if postS.count < precision { postS = String(repeating: "0", count: precision - postS.count) + postS }
                guard let head = toCardinal(.int(pre)) else { return nil }
                var out = [head]
                if precision > 0 { out.append("point") }
                let digits = Array(postS)
                for i in 0..<precision {
                    guard i < digits.count, let c = Int(String(digits[i])), let w = toCardinal(.int(c)) else { return nil }
                    out.append(w)
                }
                return out.joined(separator: " ")
            }
        }

        static let ords: [String: String] = [
            "one": "first", "two": "second", "three": "third", "four": "fourth", "five": "fifth",
            "six": "sixth", "seven": "seventh", "eight": "eighth", "nine": "ninth", "ten": "tenth",
            "eleven": "eleventh", "twelve": "twelfth",
        ]

        static func toOrdinal(_ n: Int) -> String? {
            guard n >= 0, let card = toCardinal(.int(n)) else { return nil }
            var outwords = card.components(separatedBy: " ")
            var lastwords = outwords[outwords.count - 1].components(separatedBy: "-")
            var lastword = lastwords[lastwords.count - 1].lowercased()
            if let o = ords[lastword] {
                lastword = o
            } else {
                if lastword.hasSuffix("y") { lastword = String(lastword.dropLast()) + "ie" }
                lastword += "th"
            }
            lastwords[lastwords.count - 1] = lastword
            outwords[outwords.count - 1] = lastwords.joined(separator: "-")
            return outwords.joined(separator: " ")
        }
    }
}
