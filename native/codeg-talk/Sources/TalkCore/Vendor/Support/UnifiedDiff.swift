import Foundation

/// One rendered line of a diff.
struct DiffRow: Identifiable {
    enum Kind { case context, added, deleted }
    let id = UUID()
    let kind: Kind
    let oldLine: Int?
    let newLine: Int?
    let text: String
}

/// A contiguous block of changes within a file (a `@@ … @@` hunk).
struct DiffHunk: Identifiable {
    let id = UUID()
    let header: String?
    var rows: [DiffRow]
}

/// A single file's worth of changes inside a unified diff.
struct DiffFile: Identifiable {
    enum Mode { case added, modified, deleted, renamed }
    let id = UUID()
    let path: String
    let oldPath: String?
    let mode: Mode
    let additions: Int
    let deletions: Int
    let hunks: [DiffHunk]

    var isNewFile: Bool { mode == .added }
}

/// A dependency-free unified-diff parser. Accepts the three shapes the codeg
/// backend can hand us:
/// - git unified diffs (`diff --git`, `--- `/`+++ `, `@@ -a,b +c,d @@`) — what
///   Claude persists in `output_preview`,
/// - codex `apply_patch` blocks (`*** Begin Patch`, `*** Update File:` …) — what
///   other agents keep in `input_preview`,
/// - the minimal `--- path / +++ path / -old / +new` form (no `@@`, no line
///   numbers) the live ACP stream emits in a tool call's `content`.
///
/// Returns nil when the text isn't a diff, so callers can fall back to plain
/// text output.
enum UnifiedDiff {

    static func parse(_ raw: String) -> [DiffFile]? {
        let text = raw.replacingOccurrences(of: "\r\n", with: "\n")
        let isApplyPatch = text.contains("*** Begin Patch")
            || text.range(of: #"(?m)^\*\*\* (Add|Update|Delete|Move) "#, options: .regularExpression) != nil
        let files = isApplyPatch ? parseApplyPatch(text) : parseGitUnified(text)
        let nonEmpty = files.filter { file in file.hunks.contains { !$0.rows.isEmpty } }
        return nonEmpty.isEmpty ? nil : nonEmpty
    }

    /// Cheap pre-check so callers only run the full parse when the text plausibly
    /// is a diff (avoids treating ordinary output that happens to start with `-`
    /// as a deletion).
    static func looksLikeDiff(_ raw: String) -> Bool {
        if raw.contains("diff --git") || raw.contains("*** Begin Patch") { return true }
        if raw.range(of: #"(?m)^@@+ -\d"#, options: .regularExpression) != nil { return true }
        if raw.range(of: #"(?m)^\*\*\* (Add|Update|Delete|Move) "#, options: .regularExpression) != nil { return true }
        if raw.range(of: #"(?m)^--- "#, options: .regularExpression) != nil,
           raw.range(of: #"(?m)^\+\+\+ "#, options: .regularExpression) != nil { return true }
        return false
    }

    // MARK: - git / bare unified

    private static func parseGitUnified(_ text: String) -> [DiffFile] {
        var files: [DiffFile] = []

        var path: String?
        var oldPath: String?
        var mode: DiffFile.Mode = .modified
        var hunks: [DiffHunk] = []
        var adds = 0, dels = 0

        var rows: [DiffRow] = []
        var header: String?
        var inHunk = false
        var oldNo = 0, newNo = 0
        var haveNumbers = false

        func flushHunk() {
            if inHunk || !rows.isEmpty { hunks.append(DiffHunk(header: header, rows: rows)) }
            rows = []; header = nil; inHunk = false
        }
        func flushFile() {
            flushHunk()
            if let p = path, !hunks.isEmpty {
                files.append(DiffFile(path: p, oldPath: oldPath, mode: mode,
                                      additions: adds, deletions: dels, hunks: hunks))
            }
            path = nil; oldPath = nil; mode = .modified; hunks = []; adds = 0; dels = 0
            oldNo = 0; newNo = 0; haveNumbers = false
        }

        for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if line.hasPrefix("diff --git") {
                flushFile()
                let parts = line.dropFirst("diff --git".count)
                    .split(separator: " ").map(String.init)
                if parts.count >= 2 {
                    oldPath = stripABPrefix(parts[parts.count - 2])
                    path = stripABPrefix(parts[parts.count - 1])
                }
                continue
            }
            if line.hasPrefix("new file mode") { mode = .added; continue }
            if line.hasPrefix("deleted file mode") { mode = .deleted; continue }
            if line.hasPrefix("rename from ") { oldPath = String(line.dropFirst(12)); mode = .renamed; continue }
            if line.hasPrefix("rename to ") { path = String(line.dropFirst(10)); mode = .renamed; continue }
            if line.hasPrefix("index ") || line.hasPrefix("similarity index")
                || line.hasPrefix("old mode") || line.hasPrefix("new mode")
                || line.hasPrefix("copy from") || line.hasPrefix("copy to") { continue }
            if line.hasPrefix("--- ") {
                let p = String(line.dropFirst(4)).trimmingCharacters(in: .whitespaces)
                if p == "/dev/null" { mode = .added }
                else if path == nil { path = stripABPrefix(p) }
                else if oldPath == nil { oldPath = stripABPrefix(p) }
                continue
            }
            if line.hasPrefix("+++ ") {
                let p = String(line.dropFirst(4)).trimmingCharacters(in: .whitespaces)
                if p == "/dev/null" { mode = .deleted }
                else if path == nil { path = stripABPrefix(p) }
                continue
            }
            if line.hasPrefix("@@") {
                flushHunk()
                header = line
                inHunk = true
                if let (o, n) = parseHunkHeader(line) { oldNo = o; newNo = n; haveNumbers = true }
                else { haveNumbers = false }
                continue
            }
            if line.hasPrefix("\\") { continue } // "\ No newline at end of file"

            if line.hasPrefix("+") {
                if !inHunk { inHunk = true; header = nil }
                rows.append(DiffRow(kind: .added, oldLine: nil, newLine: haveNumbers ? newNo : nil, text: String(line.dropFirst())))
                if haveNumbers { newNo += 1 }
                adds += 1
                continue
            }
            if line.hasPrefix("-") {
                if !inHunk { inHunk = true; header = nil }
                rows.append(DiffRow(kind: .deleted, oldLine: haveNumbers ? oldNo : nil, newLine: nil, text: String(line.dropFirst())))
                if haveNumbers { oldNo += 1 }
                dels += 1
                continue
            }
            if line.hasPrefix(" ") {
                guard inHunk else { continue }
                rows.append(DiffRow(kind: .context, oldLine: haveNumbers ? oldNo : nil, newLine: haveNumbers ? newNo : nil, text: String(line.dropFirst())))
                if haveNumbers { oldNo += 1; newNo += 1 }
                continue
            }
            if line.isEmpty, inHunk {
                rows.append(DiffRow(kind: .context, oldLine: haveNumbers ? oldNo : nil, newLine: haveNumbers ? newNo : nil, text: ""))
                if haveNumbers { oldNo += 1; newNo += 1 }
                continue
            }
            // Any other line (commit subject, etc.) is ignored.
        }
        flushFile()
        return files
    }

    // MARK: - codex apply_patch

    private static func parseApplyPatch(_ text: String) -> [DiffFile] {
        var files: [DiffFile] = []

        var path: String?
        var oldPath: String?
        var mode: DiffFile.Mode = .modified
        var hunks: [DiffHunk] = []
        var adds = 0, dels = 0
        var rows: [DiffRow] = []
        var header: String?
        var inHunk = false

        func flushHunk() {
            if inHunk || !rows.isEmpty { hunks.append(DiffHunk(header: header, rows: rows)) }
            rows = []; header = nil; inHunk = false
        }
        func flushFile() {
            flushHunk()
            if let p = path, !hunks.isEmpty {
                files.append(DiffFile(path: p, oldPath: oldPath, mode: mode,
                                      additions: adds, deletions: dels, hunks: hunks))
            }
            path = nil; oldPath = nil; mode = .modified; hunks = []; adds = 0; dels = 0
        }

        for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if line.hasPrefix("*** Begin Patch") || line.hasPrefix("*** End Patch") { continue }
            if line.hasPrefix("*** Add File: ") { flushFile(); path = trimPath(String(line.dropFirst(14))); mode = .added; continue }
            if line.hasPrefix("*** Update File: ") { flushFile(); path = trimPath(String(line.dropFirst(17))); mode = .modified; continue }
            if line.hasPrefix("*** Delete File: ") { flushFile(); path = trimPath(String(line.dropFirst(17))); mode = .deleted; continue }
            if line.hasPrefix("*** Move to: ") { oldPath = path; path = trimPath(String(line.dropFirst(13))); mode = .renamed; continue }
            if line.hasPrefix("@@") { flushHunk(); header = line == "@@" ? nil : line; inHunk = true; continue }

            if line.hasPrefix("+") { inHunk = true; rows.append(DiffRow(kind: .added, oldLine: nil, newLine: nil, text: String(line.dropFirst()))); adds += 1; continue }
            if line.hasPrefix("-") { inHunk = true; rows.append(DiffRow(kind: .deleted, oldLine: nil, newLine: nil, text: String(line.dropFirst()))); dels += 1; continue }
            if line.hasPrefix(" ") { inHunk = true; rows.append(DiffRow(kind: .context, oldLine: nil, newLine: nil, text: String(line.dropFirst()))); continue }
            if line.isEmpty, inHunk { rows.append(DiffRow(kind: .context, oldLine: nil, newLine: nil, text: "")); continue }
        }
        flushFile()
        return files
    }

    // MARK: - Helpers

    private static let hunkRegex = try! NSRegularExpression(pattern: #"^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@"#)

    private static func parseHunkHeader(_ line: String) -> (Int, Int)? {
        let ns = line as NSString
        guard let m = hunkRegex.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)),
              m.numberOfRanges >= 3 else { return nil }
        let o = Int(ns.substring(with: m.range(at: 1))) ?? 1
        let n = Int(ns.substring(with: m.range(at: 2))) ?? 1
        return (o, n)
    }

    private static func stripABPrefix(_ p: String) -> String {
        var s = p.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("\""), s.hasSuffix("\""), s.count >= 2 { s = String(s.dropFirst().dropLast()) }
        if s.hasPrefix("a/") || s.hasPrefix("b/") { s = String(s.dropFirst(2)) }
        return s
    }

    private static func trimPath(_ p: String) -> String {
        p.trimmingCharacters(in: .whitespaces)
    }
}
