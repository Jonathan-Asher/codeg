import Foundation

/// Turns the English text inside `<en>…</en>` spans into IPA for BlueTTS.
///
/// The reference pipeline uses espeak-ng (en-us) through the Python
/// `phonemizer` package with `preserve_punctuation=True, with_stress=True,
/// language_switch="remove-flags"` and a `" "` word separator, then collapses
/// whitespace. Implementations must return that same shape: IPA words with
/// primary/secondary stress marks, separated by single spaces, punctuation kept
/// in place. `BlueTTSEspeak.EspeakPhonemizer` is the reference implementation
/// (GPL-3); `CMUDictPhonemizer`-style alternatives can plug in here.
public protocol EnglishPhonemizer: Sendable {
    /// Phonemize one English segment. Called serially by the pipeline.
    func phonemize(_ text: String) throws -> String
}

/// Port of `phonemizer.punctuation.Punctuation` (phonemizer-fork 3.3.2 /
/// phonemizer 3.4.0 as installed in the reference venv) — the part of the
/// phonemizer front end that hides punctuation from the backend and puts it
/// back afterwards. Backend-agnostic, so any `EnglishPhonemizer` built on a
/// per-chunk backend can reuse it.
public enum PunctuationPreserver {
    struct MarkIndex {
        let index: Int
        let mark: String
        let position: Character  // B, E, I, A
    }

    /// `_DEFAULT_MARKS` with decimal separators guarded between digits.
    static let marksRe: PyRegex = {
        let marks = ";:,.!?¡¿—…\"«»“”(){}[]"
        let decimals = marks.filter { ",.".contains($0) }
        let others = marks.filter { !",.".contains($0) }
        func esc(_ s: String) -> String {
            s.map { c -> String in
                let special = "\\^-[]{}()*+?.|$/"
                return special.contains(c) ? "\\\(c)" : String(c)
            }.joined()
        }
        var alts: [String] = []
        if !others.isEmpty { alts.append("[\(esc(String(others)))]") }
        if !decimals.isEmpty {
            alts.append("(?<![0-9])[\(esc(String(decimals)))]")
            alts.append("[\(esc(String(decimals)))](?![0-9])")
        }
        return PyRegex("(\\s*(?:\(alts.joined(separator: "|")))+\\s*)+")
    }()

    /// `Punctuation.preserve` for a single line.
    static func preserve(_ line0: String) -> ([String], [MarkIndex]) {
        let matches = marksRe.finditer(line0)
        if matches.isEmpty { return (line0.isEmpty ? [] : [line0], []) }
        if matches.count == 1 && Py.eq(matches[0].value, line0) {
            return ([], [MarkIndex(index: 0, mark: line0, position: "A")])
        }
        var marks: [MarkIndex] = []
        for (k, m) in matches.enumerated() {
            var position: Character = "I"
            if k == 0 && Py.hasPrefix(line0, m.value) {
                position = "B"
            } else if k == matches.count - 1 && Py.hasSuffix(line0, m.value) {
                position = "E"
            }
            marks.append(MarkIndex(index: 0, mark: m.value, position: position))
        }
        var preserved: [String] = []
        var line = line0
        for mark in marks {
            // `line.split(mark.mark)` then prefix = first piece, suffix = rest joined.
            if let r = line.range(of: mark.mark, options: .literal) {
                preserved.append(String(line[..<r.lowerBound]))
                line = String(line[r.upperBound...])
            } else {
                preserved.append(line)
                line = ""
            }
        }
        preserved.append(line)
        return (preserved.filter { !$0.isEmpty }, marks)
    }

    /// `Punctuation.restore` with `strip=False`.
    static func restore(_ text0: [String], _ marks0: [MarkIndex], wordSep: String) -> [String] {
        var text = text0
        var marks = marks0
        var out: [String] = []
        var pos = 0
        while !text.isEmpty || !marks.isEmpty {
            if marks.isEmpty {
                for var line in text {
                    if !wordSep.isEmpty && !Py.hasSuffix(line, wordSep) { line += wordSep }
                    out.append(line)
                }
                text = []
            } else if text.isEmpty {
                out.append(Py.replace(marks.map(\.mark).joined(), " ", wordSep))
                marks = []
            } else {
                let current = marks[0]
                if current.index == pos {
                    marks.removeFirst()
                    let mark = Py.replace(current.mark, " ", wordSep)
                    if !wordSep.isEmpty && Py.hasSuffix(text[0], wordSep) {
                        text[0] = String(text[0].unicodeScalars.dropLast(wordSep.unicodeScalars.count))
                    }
                    switch current.position {
                    case "B":
                        text[0] = mark + text[0]
                    case "E":
                        out.append(text[0] + mark + (Py.hasSuffix(mark, wordSep) ? "" : wordSep))
                        text.removeFirst()
                        pos += 1
                    case "A":
                        out.append(mark + (Py.hasSuffix(mark, wordSep) ? "" : wordSep))
                        pos += 1
                    default:
                        if text.count == 1 {
                            text[0] = text[0] + mark
                        } else {
                            let first = text.removeFirst()
                            text[0] = first + mark + text[0]
                        }
                    }
                } else {
                    out.append(text.removeFirst())
                    pos += 1
                }
            }
        }
        return out
    }

    /// Full phonemizer-style run over one input line: split on punctuation,
    /// phonemize every chunk with `backend` (which must return words joined
    /// and terminated by `wordSep`, as phonemizer's espeak post-processing
    /// does), restore punctuation, and return the first output line.
    public static func run(_ line: String, wordSep: String = " ",
                           backend: (String) throws -> String) rethrows -> String {
        let (chunks, marks) = preserve(line)
        var phonemized: [String] = []
        for c in chunks { phonemized.append(try backend(c)) }
        let restored = restore(phonemized, marks, wordSep: wordSep)
        return restored.first ?? ""
    }
}
