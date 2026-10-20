import Foundation

/// Port of `renikud_onnx.G2P` (renikud-plus 0.5.0): unvocalized Hebrew -> IPA.
///
/// Ported paths: number front end, grapheme normalization, niqqud stripping
/// (`niqqud="strip"`) and reading (`niqqud="use"`), long-input windowing, the
/// exact-MAP cascade decode (and the greedy fallback for models exported
/// without cascade metadata), IPA rendering, and `vocalize`.
///
/// The attested-reading rescorer only switches on when a `datastore.json` sits
/// beside the model. The published Hugging Face repo ships none, and the spike
/// ran without one, so that layer (and the opt-in force lexicon) is not ported;
/// `RenikudG2P` refuses to start if a datastore is present so the gap can never
/// change output silently.
final class RenikudG2P: @unchecked Sendable {
    static let safeChunkChars = 2046
    static let stressMark = "ˈ"
    static let neg: Float = -1e30
    static let alefOrd: UInt32 = 0x05D0
    static let tafOrd: UInt32 = 0x05EA

    enum NiqqudMode: String, Sendable { case strip, use }

    struct ConfigError: Error, CustomStringConvertible {
        let description: String
    }

    private let session: OrtSession
    private let vocab: [Unicode.Scalar: Int64]
    private let unkId: Int64
    private let clsId: Int64
    private let sepId: Int64
    private let consonantVocab: [Int: String]
    private let vowelVocab: [Int: String]
    private let consonantIds: [String: Int]
    private let vowelIds: [String: Int]
    private let letterConstraints: [Unicode.Scalar: [Int]]
    private let gereshMap: [Unicode.Scalar: String]
    private let supportsGender: Bool
    private let supportsExactMap: Bool
    private let condSoftmax: Bool
    // cascade matrices, row-major
    private let wvc: [Float]  // [C, V]
    private let wsc: [Float]  // [C, 2]
    private let wsv: [Float]  // [V, 2]
    private let nC: Int
    private let nV: Int
    private var forbidden: [[Bool]] = []  // [letter - alef][C]
    let niqqud: NiqqudMode
    let chunkChars: Int?

    init(modelURL: URL, threads: Int, provider: ExecutionProvider = .cpu,
         niqqud: NiqqudMode = .strip, chunkChars: Int? = RenikudG2P.safeChunkChars) throws {
        let side = modelURL.deletingLastPathComponent().appendingPathComponent("datastore.json")
        if FileManager.default.fileExists(atPath: side.path) {
            throw ConfigError(description: "datastore.json found next to the RenikudPlus model; the rescorer is not ported, remove it or port the layer")
        }
        let meta = try OnnxMetadataReader.read(modelURL)
        session = try OrtSession(path: modelURL, threads: threads, provider: provider)
        self.niqqud = niqqud
        self.chunkChars = chunkChars

        func json(_ key: String) throws -> Any {
            guard let s = meta[key], let d = s.data(using: .utf8) else {
                throw ConfigError(description: "RenikudPlus metadata key missing: \(key)")
            }
            return try JSONSerialization.jsonObject(with: d, options: [.fragmentsAllowed])
        }
        guard let v = try json("vocab") as? [String: Int] else { throw ConfigError(description: "vocab") }
        var voc: [Unicode.Scalar: Int64] = [:]
        var unk: Int64 = 0
        for (k, id) in v {
            let sc = Array(k.unicodeScalars)
            if k == "[UNK]" { unk = Int64(id) }
            if sc.count == 1 { voc[sc[0]] = Int64(id) }
        }
        vocab = voc
        unkId = unk
        guard let cv = try json("consonant_vocab") as? [String: String],
              let vv = try json("vowel_vocab") as? [String: String] else { throw ConfigError(description: "label vocab") }
        consonantVocab = Dictionary(uniqueKeysWithValues: cv.map { (Int($0.key)!, $0.value) })
        vowelVocab = Dictionary(uniqueKeysWithValues: vv.map { (Int($0.key)!, $0.value) })
        consonantIds = Dictionary(uniqueKeysWithValues: consonantVocab.map { ($0.value, $0.key) })
        vowelIds = Dictionary(uniqueKeysWithValues: vowelVocab.map { ($0.value, $0.key) })
        clsId = Int64(meta["cls_token_id"].flatMap { Int($0) } ?? 1)
        sepId = Int64(meta["sep_token_id"].flatMap { Int($0) } ?? 2)
        guard let lc = try json("letter_consonant_constraints") as? [String: [Int]] else {
            throw ConfigError(description: "letter_consonant_constraints")
        }
        var lcs: [Unicode.Scalar: [Int]] = [:]
        for (k, ids) in lc { if let u = k.unicodeScalars.first, k.unicodeScalars.count == 1 { lcs[u] = ids } }
        letterConstraints = lcs
        var gm: [Unicode.Scalar: String] = [:]
        if meta["geresh_map"] != nil, let g = try json("geresh_map") as? [String: String] {
            for (k, val) in g { if let u = k.unicodeScalars.first { gm[u] = val } }
        }
        gereshMap = gm
        let inputs = session.inputNames
        supportsGender = inputs.contains("speaker") && inputs.contains("target_speaker")

        let condKeys = ["vowel_cond_consonant", "stress_cond_consonant", "stress_cond_vowel"]
        supportsExactMap = condKeys.allSatisfy { meta[$0] != nil }
        if supportsExactMap {
            func matrix(_ key: String) throws -> [[Double]] {
                guard let m = try json(key) as? [[Double]] else { throw ConfigError(description: key) }
                return m
            }
            let a = try matrix("vowel_cond_consonant"), b = try matrix("stress_cond_consonant")
            let c = try matrix("stress_cond_vowel")
            nC = a.count
            nV = a.first?.count ?? 0
            wvc = a.flatMap { $0.map { Float($0) } }
            wsc = b.flatMap { $0.map { Float($0) } }
            wsv = c.flatMap { $0.map { Float($0) } }
            condSoftmax = (meta["cascade_cond"] ?? "softmax") == "softmax"
            var fb = [[Bool]](repeating: [Bool](repeating: true, count: nC),
                              count: Int(Self.tafOrd - Self.alefOrd + 1))
            for (letter, allowed) in lcs where letter.value >= Self.alefOrd && letter.value <= Self.tafOrd {
                for id in allowed where id < nC { fb[Int(letter.value - Self.alefOrd)][id] = false }
            }
            forbidden = fb
        } else {
            nC = consonantVocab.count
            nV = vowelVocab.count
            wvc = []; wsc = []; wsv = []
            condSoftmax = true
        }
    }

    // MARK: helpers

    static func isHebrewLetter(_ u: Unicode.Scalar) -> Bool { u.value >= alefOrd && u.value <= tafOrd }

    static let gereshLikeRe = PyRegex("[׳'`´]")
    static let gershayimLikeRe = PyRegex("[״\"\"]")

    static func normalizeGraphemes(_ text: String) -> String {
        gershayimLikeRe.sub(gereshLikeRe.sub(text, "'"), "\"")
    }

    static func isNiqqud(_ u: Unicode.Scalar) -> Bool {
        let v = u.value
        return (v >= 0x0591 && v <= 0x05BD) || v == 0x05BF || v == 0x05C1 || v == 0x05C2
            || v == 0x05C4 || v == 0x05C5 || v == 0x05C7
    }

    static func stripNiqqud(_ s: [Unicode.Scalar]) -> [Unicode.Scalar] { s.filter { !isNiqqud($0) } }

    static let sentenceEnds: Set<Unicode.Scalar> = Set(".!?;\n\r…׃".unicodeScalars)
    static let clauseEnds: Set<Unicode.Scalar> = Set(",:–—".unicodeScalars)

    static func splitAfter(_ t: ArraySlice<Unicode.Scalar>, _ term: Set<Unicode.Scalar>) -> [ArraySlice<Unicode.Scalar>] {
        var pieces: [ArraySlice<Unicode.Scalar>] = []
        var start = t.startIndex, i = t.startIndex
        let n = t.endIndex
        while i < n {
            if term.contains(t[i]) {
                var j = i + 1
                while j < n && term.contains(t[j]) { j += 1 }
                while j < n && Py.isSpace(t[j]) { j += 1 }
                pieces.append(t[start..<j])
                start = j
                i = j
            } else {
                i += 1
            }
        }
        if start < n { pieces.append(t[start..<n]) }
        return pieces
    }

    static func splitWords(_ t: ArraySlice<Unicode.Scalar>) -> [ArraySlice<Unicode.Scalar>] {
        var pieces: [ArraySlice<Unicode.Scalar>] = []
        var start = t.startIndex, i = t.startIndex
        let n = t.endIndex
        while i < n {
            if Py.isSpace(t[i]) {
                var j = i
                while j < n && Py.isSpace(t[j]) { j += 1 }
                pieces.append(t[start..<j])
                start = j
                i = j
            } else {
                i += 1
            }
        }
        if start < n { pieces.append(t[start..<n]) }
        return pieces
    }

    static func pack(_ pieces: [ArraySlice<Unicode.Scalar>], _ limit: Int) -> [[Unicode.Scalar]] {
        var out: [[Unicode.Scalar]] = []
        var cur: [Unicode.Scalar] = []
        for p in pieces {
            if !cur.isEmpty && cur.count + p.count > limit {
                out.append(cur)
                cur = Array(p)
            } else {
                cur += p
            }
        }
        if !cur.isEmpty { out.append(cur) }
        return out
    }

    /// `split_for_decode`: lossless windows of at most `limit` code points.
    static func splitForDecode(_ text: [Unicode.Scalar], limit: Int) -> [[Unicode.Scalar]] {
        if text.count <= limit { return [text] }
        var out: [[Unicode.Scalar]] = []
        for sent in pack(splitAfter(text[...], sentenceEnds), limit) {
            if sent.count <= limit { out.append(sent); continue }
            for clause in pack(splitAfter(sent[...], clauseEnds), limit) {
                if clause.count <= limit { out.append(clause); continue }
                for word in pack(splitWords(clause[...]), limit) {
                    if word.count <= limit { out.append(word); continue }
                    var i = 0
                    while i < word.count {
                        out.append(Array(word[i..<min(i + limit, word.count)]))
                        i += limit
                    }
                }
            }
        }
        return out
    }

    // MARK: public entry points

    /// `G2P.phonemize`.
    func phonemize(_ text0: String, speaker: Int = 0, targetSpeaker: Int = 0,
                   niqqud: NiqqudMode? = nil) throws -> String {
        var text = text0
        if HebrewNumberNormalizer.containsDigit(text) {
            text = HebrewNumberNormalizer.normalize(text)
        }
        text = Self.normalizeGraphemes(text)
        let (normalized, constraints) = readInput(Py.scalars(text.decomposedStringWithCanonicalMapping),
                                                  niqqud ?? self.niqqud)
        let windows = chunkChars.map { Self.splitForDecode(normalized, limit: $0) } ?? [normalized]
        var result = ""
        var offset = 0
        for w in windows {
            let c = constraints.map { all in
                all.filter { $0.key >= offset && $0.key < offset + w.count }
                    .reduce(into: [Int: Constraint]()) { $0[$1.key - offset] = $1.value }
            }
            result += try phonemizeWindow(w, speaker: speaker, targetSpeaker: targetSpeaker, constraints: c)
            offset += w.count
        }
        return result
    }

    /// `G2P.vocalize`: the same decode rendered as niqqud instead of IPA.
    func vocalize(_ text0: String, speaker: Int = 0, targetSpeaker: Int = 0,
                  niqqud: NiqqudMode? = nil) throws -> String {
        var text = text0
        if HebrewNumberNormalizer.containsDigit(text) {
            text = HebrewNumberNormalizer.normalize(text)
        }
        text = Self.normalizeGraphemes(text)
        let (normalized, constraints) = readInput(Py.scalars(text.decomposedStringWithCanonicalMapping),
                                                  niqqud ?? self.niqqud)
        let windows = chunkChars.map { Self.splitForDecode(normalized, limit: $0) } ?? [normalized]
        var result = ""
        var offset = 0
        for w in windows {
            let c = constraints.map { all in
                all.filter { $0.key >= offset && $0.key < offset + w.count }
                    .reduce(into: [Int: Constraint]()) { $0[$1.key - offset] = $1.value }
            }
            result += try vocalizeWindow(w, speaker: speaker, targetSpeaker: targetSpeaker, constraints: c)
            offset += w.count
        }
        return result
    }

    typealias Constraint = (cons: [String]?, vows: [String]?)

    private func readInput(_ normalized: [Unicode.Scalar], _ mode: NiqqudMode) -> ([Unicode.Scalar], [Int: Constraint]?) {
        switch mode {
        case .strip: return (Self.stripNiqqud(normalized), nil)
        case .use:
            let (bare, c) = NiqqudReader.parse(normalized)
            return (bare, c)
        }
    }

    // MARK: forward + decode

    private struct Decode {
        var consonantPreds: [Int]
        var vowelPreds: [Int]
        var stressed: Set<Int>
        var consonantLogits: [Float]  // [S, C]
    }

    private func forward(_ text: [Unicode.Scalar], speaker: Int, targetSpeaker: Int,
                         constraints: [Int: Constraint]?) throws -> (offsets: [(Int, Int)], Decode) {
        // `_tokenize`: the window is already NFD.
        var ids: [Int64] = [clsId]
        var offsets: [(Int, Int)] = [(0, 0)]
        for (i, c) in text.enumerated() {
            ids.append(vocab[c] ?? unkId)
            offsets.append((i, i + 1))
        }
        ids.append(sepId)
        offsets.append((0, 0))
        let s = ids.count
        var feeds: [String: OrtSession.Input] = [
            "input_ids": .int64(Tensor(shape: [1, s], data: ids)),
            "attention_mask": .int64(Tensor(shape: [1, s], data: [Int64](repeating: 1, count: s))),
        ]
        if supportsGender {
            feeds["speaker"] = .int64(Tensor(shape: [1], data: [Int64(speaker)]))
            feeds["target_speaker"] = .int64(Tensor(shape: [1], data: [Int64(targetSpeaker)]))
        }
        let out = try session.run(feeds, outputs: ["consonant_logits", "vowel_logits", "stress_logits"])
        let cl = out["consonant_logits"]!.data, vl = out["vowel_logits"]!.data, sl = out["stress_logits"]!.data
        let C = out["consonant_logits"]!.shape[2], V = out["vowel_logits"]!.shape[2]
        if supportsExactMap {
            precondition(C == nC && V == nV, "cascade matrix shape mismatch")
            let d = exactMap(offsets: offsets, text: text, cl: cl, vl: vl, sl: sl, S: s, constraints: constraints)
            return (offsets, d)
        }
        if constraints != nil {
            throw ConfigError(description: "niqqud=use needs the exact-MAP decode, which this model lacks")
        }
        // Greedy fallback: argmax + margin stress per word.
        var cp = [Int](repeating: 0, count: s), vp = [Int](repeating: 0, count: s)
        for t in 0..<s {
            cp[t] = argmax(cl, t * C, C)
            vp[t] = argmax(vl, t * V, V)
        }
        let stressed = bestStressPerWord(offsets: offsets, text: text, sl: sl, vowelPreds: vp)
        return (offsets, Decode(consonantPreds: cp, vowelPreds: vp, stressed: stressed, consonantLogits: cl))
    }

    private func argmax(_ a: [Float], _ off: Int, _ n: Int) -> Int {
        var best = 0
        var bv = a[off]
        for i in 1..<n where a[off + i] > bv {
            bv = a[off + i]
            best = i
        }
        return best
    }

    /// Word spans of `re.finditer(r"\S+", text)` as code-point ranges.
    static func wordSpans(_ text: [Unicode.Scalar]) -> [Range<Int>] {
        var spans: [Range<Int>] = []
        var i = 0
        while i < text.count {
            if Py.isSpace(text[i]) { i += 1; continue }
            var j = i
            while j < text.count && !Py.isSpace(text[j]) { j += 1 }
            spans.append(i..<j)
            i = j
        }
        return spans
    }

    private func bestStressPerWord(offsets: [(Int, Int)], text: [Unicode.Scalar], sl: [Float],
                                   vowelPreds: [Int]) -> Set<Int> {
        let spans = Self.wordSpans(text)
        var words = [[Int]](repeating: [], count: spans.count)
        for (t, (start, end)) in offsets.enumerated() where end - start == 1 {
            for (w, sp) in spans.enumerated() where sp.contains(start) {
                words[w].append(t)
                break
            }
        }
        var stressed = Set<Int>()
        for toks in words where !toks.isEmpty {
            let vt = toks.filter { (vowelVocab[vowelPreds[$0]] ?? "∅") != "∅" }
            guard var best = vt.first else { continue }
            var bv = sl[best * 2 + 1] - sl[best * 2]
            for t in vt.dropFirst() {
                let m = sl[t * 2 + 1] - sl[t * 2]
                if m > bv { bv = m; best = t }
            }
            stressed.insert(best)
        }
        return stressed
    }

    private static func softmaxRows(_ x: [Float], rows: Int, cols: Int) -> [Float] {
        var out = [Float](repeating: 0, count: x.count)
        for r in 0..<rows {
            let o = r * cols
            var m = x[o]
            for c in 1..<cols where x[o + c] > m { m = x[o + c] }
            var sum: Float = 0
            for c in 0..<cols {
                let e = expf(x[o + c] - m)
                out[o + c] = e
                sum += e
            }
            for c in 0..<cols { out[o + c] /= sum }
        }
        return out
    }

    private static func logSoftmax(_ x: inout [Float], _ o: Int, _ n: Int) {
        var m = x[o]
        for i in 1..<n where x[o + i] > m { m = x[o + i] }
        var sum: Float = 0
        for i in 0..<n {
            x[o + i] -= m
            sum += expf(x[o + i])
        }
        let l = logf(sum)
        for i in 0..<n { x[o + i] -= l }
    }

    /// `[rows, k] @ [k, cols]`.
    private static func matmul(_ a: [Float], _ b: [Float], rows: Int, k: Int, cols: Int) -> [Float] {
        var out = [Float](repeating: 0, count: rows * cols)
        for r in 0..<rows {
            for c in 0..<cols {
                var acc: Float = 0
                for i in 0..<k { acc += a[r * k + i] * b[i * cols + c] }
                out[r * cols + c] = acc
            }
        }
        return out
    }

    /// `_exact_map`: closed-form MAP over E(c, v, s) = log P(c) + log P(v|c) + log P(s|c,v).
    private func exactMap(offsets: [(Int, Int)], text: [Unicode.Scalar], cl: [Float], vl: [Float], sl: [Float],
                          S: Int, constraints: [Int: Constraint]?) -> Decode {
        let C = nC, V = nV
        let condC = condSoftmax ? Self.softmaxRows(cl, rows: S, cols: C) : onehotRows(cl, S, C)
        let cw = Self.matmul(condC, wvc, rows: S, k: C, cols: V)
        var baseV = [Float](repeating: 0, count: S * V)
        for i in 0..<(S * V) { baseV[i] = vl[i] - cw[i] }
        let condV = condSoftmax ? Self.softmaxRows(vl, rows: S, cols: V) : onehotRows(vl, S, V)
        let cs = Self.matmul(condC, wsc, rows: S, k: C, cols: 2)
        let vs = Self.matmul(condV, wsv, rows: S, k: V, cols: 2)
        var baseS = [Float](repeating: 0, count: S * 2)
        for i in 0..<(S * 2) { baseS[i] = (sl[i] - cs[i]) - vs[i] }

        var logc = cl
        for t in 0..<S { Self.logSoftmax(&logc, t * C, C) }

        // E[t, c, v, k], flattened as ((t*C + c)*V + v)*2 + k
        var E = [Float](repeating: 0, count: S * C * V * 2)
        var tmpV = [Float](repeating: 0, count: V)
        var tmpS = [Float](repeating: 0, count: 2)
        for t in 0..<S {
            for c in 0..<C {
                for v in 0..<V { tmpV[v] = baseV[t * V + v] + wvc[c * V + v] }
                Self.logSoftmax(&tmpV, 0, V)
                let lc = logc[t * C + c]
                for v in 0..<V {
                    for k in 0..<2 {
                        tmpS[k] = (baseS[t * 2 + k] + wsc[c * 2 + k]) + wsv[v * 2 + k]
                    }
                    Self.logSoftmax(&tmpS, 0, 2)
                    let base = ((t * C + c) * V + v) * 2
                    let lv = lc + tmpV[v]
                    E[base] = lv + tmpS[0]
                    E[base + 1] = lv + tmpS[1]
                }
            }
        }

        // Per-letter consonant legality.
        for (t, (start, end)) in offsets.enumerated() where end - start == 1 {
            let u = text[start]
            guard Self.isHebrewLetter(u) else { continue }
            let row = forbidden[Int(u.value - Self.alefOrd)]
            for c in 0..<C where row[c] {
                let base = (t * C + c) * V * 2
                for i in 0..<(V * 2) { E[base + i] = Self.neg }
            }
        }

        // Niqqud constraints (niqqud="use").
        if let constraints, !constraints.isEmpty {
            var charToTok: [Int: Int] = [:]
            for (t, (start, end)) in offsets.enumerated() where end - start == 1 { charToTok[start] = t }
            for (idx, con) in constraints {
                guard let t = charToTok[idx] else { continue }
                let base = t * C * V * 2
                let saved = Array(E[base..<(base + C * V * 2)])
                if let cons = con.cons {
                    let keep = Set(cons.compactMap { consonantIds[$0] })
                    for c in 0..<C where !keep.contains(c) {
                        for i in 0..<(V * 2) { E[base + c * V * 2 + i] = Self.neg }
                    }
                }
                if let vows = con.vows {
                    let keep = Set(vows.compactMap { vowelIds[$0] })
                    for c in 0..<C {
                        for v in 0..<V where !keep.contains(v) {
                            E[base + (c * V + v) * 2] = Self.neg
                            E[base + (c * V + v) * 2 + 1] = Self.neg
                        }
                    }
                }
                var mx = -Float.infinity
                for i in 0..<(C * V * 2) { mx = max(mx, E[base + i]) }
                if mx < Self.neg / 2 {
                    for i in 0..<(C * V * 2) { E[base + i] = saved[i] }
                }
            }
        }

        // Stress needs a vowel.
        for t in 0..<S {
            for c in 0..<C { E[((t * C + c) * V + 0) * 2 + 1] = Self.neg }
        }

        var argU = [Int](repeating: 0, count: S), argS = [Int](repeating: 0, count: S)
        var bestU = [Float](repeating: 0, count: S), bestS = [Float](repeating: 0, count: S)
        for t in 0..<S {
            var bu = -Float.infinity, bs = -Float.infinity
            var au = 0, as_ = 0
            for j in 0..<(C * V) {
                let eu = E[(t * C * V + j) * 2], es = E[(t * C * V + j) * 2 + 1]
                if eu > bu { bu = eu; au = j }
                if es > bs { bs = es; as_ = j }
            }
            argU[t] = au; argS[t] = as_; bestU[t] = bu; bestS[t] = bs
        }

        var charTok: [Int: Int] = [:]
        for (t, (start, end)) in offsets.enumerated() where end - start == 1 && Self.isHebrewLetter(text[start]) {
            charTok[start] = t
        }
        var stressed = Set<Int>()
        for span in Self.wordSpans(text) {
            let toks = span.compactMap { charTok[$0] }
            let cands = toks.filter { bestS[$0] > Self.neg / 2 }
            guard var best = cands.first else { continue }
            var bg = bestS[best] - bestU[best]
            for t in cands.dropFirst() {
                let g = bestS[t] - bestU[t]
                if g > bg { bg = g; best = t }
            }
            stressed.insert(best)
        }
        var cp = [Int](repeating: 0, count: S), vp = [Int](repeating: 0, count: S)
        for t in 0..<S {
            let flat = stressed.contains(t) ? argS[t] : argU[t]
            cp[t] = flat / V
            vp[t] = flat % V
        }
        return Decode(consonantPreds: cp, vowelPreds: vp, stressed: stressed, consonantLogits: cl)
    }

    private func onehotRows(_ x: [Float], _ rows: Int, _ cols: Int) -> [Float] {
        var out = [Float](repeating: 0, count: rows * cols)
        for r in 0..<rows { out[r * cols + argmax(x, r * cols, cols)] = 1 }
        return out
    }

    private func labelsAt(_ char: Unicode.Scalar, _ t: Int, _ d: Decode) -> (String, String) {
        var cid = d.consonantPreds[t]
        if let allowed = letterConstraints[char], !allowed.contains(cid), let first = allowed.first {
            var best = first
            var bv = d.consonantLogits[t * nC + first]
            for x in allowed.dropFirst() where d.consonantLogits[t * nC + x] > bv {
                bv = d.consonantLogits[t * nC + x]
                best = x
            }
            cid = best
        }
        return (consonantVocab[cid] ?? "∅", vowelVocab[d.vowelPreds[t]] ?? "∅")
    }

    private func phonemizeWindow(_ normalized: [Unicode.Scalar], speaker: Int, targetSpeaker: Int,
                                 constraints: [Int: Constraint]?) throws -> String {
        let (offsets, d) = try forward(normalized, speaker: speaker, targetSpeaker: targetSpeaker,
                                       constraints: constraints)
        var result = ""
        var prevEnd = 0
        let n = normalized.count
        for (t, (start, end)) in offsets.enumerated() {
            if end - start != 1 {
                if end > start { prevEnd = end }
                continue
            }
            if start > prevEnd { result += Py.string(normalized[prevEnd..<start]) }
            let char = normalized[start]
            prevEnd = end
            if !Self.isHebrewLetter(char) {
                if char != "'" && char != "\"" { result.unicodeScalars.append(char) }
                continue
            }
            var (consonant, vowel) = labelsAt(char, t, d)
            if let g = gereshMap[char], end < n, normalized[end] == "'" {
                consonant = g
            }
            let stress = d.stressed.contains(t)
            let wordFinal = end >= n || !Py.isAlpha(normalized[end])
            var chunk = ""
            if char == "ח" && wordFinal && vowel == "a" {
                if stress { chunk += Self.stressMark }
                chunk += "aχ"
            } else {
                if consonant != "∅" { chunk += consonant }
                if stress && vowel != "∅" { chunk += Self.stressMark }
                if vowel != "∅" { chunk += vowel }
            }
            result += chunk
        }
        if prevEnd < n { result += Py.string(normalized[prevEnd...]) }
        return result
    }

    private static let niqqudVowel: [String: Unicode.Scalar] = [
        "a": "\u{05B7}", "e": "\u{05B6}", "i": "\u{05B4}", "o": "\u{05B9}", "u": "\u{05BB}",
    ]
    private static let dagesh: Unicode.Scalar = "\u{05BC}"
    private static let shinDot: Unicode.Scalar = "\u{05C1}"
    private static let sinDot: Unicode.Scalar = "\u{05C2}"

    private static func consonantPoint(_ letter: Unicode.Scalar, _ consonant: String) -> [Unicode.Scalar] {
        if letter == "ש" { return [consonant == "ʃ" ? shinDot : sinDot] }
        switch (letter, consonant) {
        case ("ב", "b"), ("כ", "k"), ("ך", "k"), ("פ", "p"), ("ף", "p"): return [dagesh]
        default: return []
        }
    }

    private func vocalizeWindow(_ normalized: [Unicode.Scalar], speaker: Int, targetSpeaker: Int,
                                constraints: [Int: Constraint]?) throws -> String {
        let (offsets, d) = try forward(normalized, speaker: speaker, targetSpeaker: targetSpeaker,
                                       constraints: constraints)
        var out: [String] = []
        // [char, consonant, vowel, outIndex, start]
        var records: [(Unicode.Scalar, String, String, Int, Int)] = []
        var prevEnd = 0
        for (t, (start, end)) in offsets.enumerated() {
            if end - start != 1 {
                if end > start { prevEnd = end }
                continue
            }
            if start > prevEnd { out.append(Py.string(normalized[prevEnd..<start])) }
            let char = normalized[start]
            prevEnd = end
            if !Self.isHebrewLetter(char) {
                out.append(String(char))
                continue
            }
            let (c, v) = labelsAt(char, t, d)
            records.append((char, c, v, out.count, start))
            out.append("")
        }
        if prevEnd < normalized.count { out.append(Py.string(normalized[prevEnd...])) }
        for i in records.indices where i > 0 {
            let (char, consonant, vowel, _, start) = records[i]
            let adjacent = records[i - 1].4 + 1 == start
            if (char == "ה" || char == "א") && consonant == "∅" && vowel != "∅" {
                if records[i - 1].2 == "∅" && adjacent {
                    records[i - 1].2 = vowel
                    records[i].2 = "∅"
                }
            } else if char == "ו" && consonant == "∅" && vowel == "∅" {
                if adjacent && (records[i - 1].2 == "o" || records[i - 1].2 == "u") {
                    records[i].2 = records[i - 1].2
                    records[i - 1].2 = "∅"
                }
            }
        }
        for (char, consonant, vowel, idx, _) in records {
            var sc: [Unicode.Scalar] = [char]
            if char == "ו" && consonant == "∅" && (vowel == "o" || vowel == "u") {
                sc.append(vowel == "u" ? Self.dagesh : Self.niqqudVowel["o"]!)
            } else {
                sc += Self.consonantPoint(char, consonant)
                if let p = Self.niqqudVowel[vowel] { sc.append(p) }
            }
            out[idx] = Py.string(sc).precomposedStringWithCanonicalMapping
        }
        return out.joined()
    }
}

/// `parse_niqqud`: pointed text -> skeleton + per-letter label constraints.
enum NiqqudReader {
    static let pointVowels: [Unicode.Scalar: [String]] = [
        "\u{05B7}": ["a"], "\u{05B2}": ["a"], "\u{05B8}": ["a", "o"], "\u{05C7}": ["o"], "\u{05B3}": ["o"],
        "\u{05B6}": ["e"], "\u{05B5}": ["e"], "\u{05B1}": ["e"], "\u{05B4}": ["i"], "\u{05B9}": ["o"],
        "\u{05BA}": ["o"], "\u{05BB}": ["u"], "\u{05B0}": ["∅", "e"],
    ]
    static let dageshHard: [Unicode.Scalar: String] = ["ב": "b", "כ": "k", "ך": "k", "פ": "p", "ף": "p"]
    static let dageshSoft: [Unicode.Scalar: String] = ["ב": "v", "כ": "χ", "ך": "χ", "פ": "f", "ף": "f"]

    static func parse(_ text: [Unicode.Scalar]) -> ([Unicode.Scalar], [Int: RenikudG2P.Constraint]) {
        var bare: [Unicode.Scalar] = []
        var letters: [(idx: Int, letter: Unicode.Scalar, marks: [Unicode.Scalar])] = []
        for ch in text {
            if RenikudG2P.isNiqqud(ch) {
                if let last = letters.last, last.idx == bare.count - 1 {
                    letters[letters.count - 1].marks.append(ch)
                }
                continue
            }
            if RenikudG2P.isHebrewLetter(ch) { letters.append((bare.count, ch, [])) }
            bare.append(ch)
        }
        var wordOf: [Int: Int] = [:]
        var wordPointed: [Int: Bool] = [:]
        var word = 0
        for (i, ch) in bare.enumerated() {
            if Py.isSpace(ch) { word += 1 }
            wordOf[i] = word
        }
        for l in letters where l.marks.contains(where: { pointVowels[$0] != nil }) {
            wordPointed[wordOf[l.idx]!] = true
        }
        var cons: [Int: [String]] = [:]
        var vows: [Int: [String]] = [:]
        var mater: [(Int, String)] = []
        for (ri, l) in letters.enumerated() {
            let signs = l.marks.filter { pointVowels[$0] != nil }
            let dagesh = l.marks.contains("\u{05BC}")
            if l.letter == "ש" {
                if l.marks.contains("\u{05C1}") { cons[l.idx] = ["ʃ"] }
                else if l.marks.contains("\u{05C2}") { cons[l.idx] = ["s"] }
            } else if l.letter == "ה" && dagesh {
                cons[l.idx] = ["h"]
            } else if let hard = dageshHard[l.letter] {
                if dagesh { cons[l.idx] = [hard] } else if !signs.isEmpty { cons[l.idx] = [dageshSoft[l.letter]!] }
            }
            if l.letter == "ו" && signs.isEmpty && dagesh { mater.append((ri, "u")); continue }
            if l.letter == "ו" && signs.count == 1 && pointVowels[signs[0]]! == ["o"] { mater.append((ri, "o")); continue }
            if !signs.isEmpty {
                var allowed = Set(pointVowels[signs[0]]!)
                for s in signs.dropFirst() { allowed.formIntersection(pointVowels[s]!) }
                if !allowed.isEmpty { vows[l.idx] = allowed.sorted() }
            }
        }
        for (ri, l) in letters.enumerated() {
            if !l.marks.isEmpty || !(wordPointed[wordOf[l.idx]!] ?? false) { continue }
            let prev = ri > 0 ? letters[ri - 1] : nil
            let nxt = ri + 1 < letters.count ? letters[ri + 1] : nil
            let sameWord = nxt != nil && wordOf[nxt!.idx] == wordOf[l.idx]
            if l.letter == "ו" {
                cons[l.idx] = ["v", "w"]
            } else if l.letter == "י", let p = prev, p.idx == l.idx - 1,
                      vows[p.idx] == ["i"] || vows[p.idx] == ["e"] {
                cons[l.idx] = ["∅"]
                vows[l.idx] = ["∅"]
            } else if (l.letter == "א" || l.letter == "ה") && !sameWord {
                cons[l.idx] = ["∅"]
            }
        }
        for (ri, quality) in mater {
            let idx = letters[ri].idx
            let prev = ri > 0 ? letters[ri - 1] : nil
            if let p = prev, p.idx == idx - 1, vows[p.idx] == nil {
                vows[p.idx] = [quality]
                vows[idx] = ["∅"]
            } else {
                vows[idx] = [quality]
            }
            cons[idx] = ["∅"]
        }
        var constraints: [Int: RenikudG2P.Constraint] = [:]
        for idx in Set(cons.keys).union(vows.keys) {
            constraints[idx] = (cons[idx], vows[idx])
        }
        return (bare, constraints)
    }
}
