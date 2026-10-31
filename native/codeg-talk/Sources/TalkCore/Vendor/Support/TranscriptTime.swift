import Foundation

/// RFC 3339 timestamps read the way the codeg server counts them. The shared
/// date decoder drops 6- and 9-digit fractions altogether, so the transcript
/// keeps each turn's exact milliseconds alongside its `Date`.
enum TranscriptTime {
    /// Epoch milliseconds of `text`, as chrono's `timestamp_millis()` gives
    /// them: the fraction cut (not rounded) to milliseconds. `nil` for
    /// anything that isn't `YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)`.
    static func millis(_ text: String) -> Int64? {
        var utf8 = text.utf8.makeIterator()
        var bytes: [UInt8] = []
        bytes.reserveCapacity(40)
        while let b = utf8.next() {
            bytes.append(b)
            if bytes.count > 64 { return nil }
        }
        guard bytes.count >= 20 else { return nil }

        func digits(_ start: Int, _ count: Int) -> Int? {
            guard start + count <= bytes.count else { return nil }
            var value = 0
            for i in start..<(start + count) {
                let b = bytes[i]
                guard b >= 48, b <= 57 else { return nil }
                value = value * 10 + Int(b - 48)
            }
            return value
        }

        guard let year = digits(0, 4), bytes[4] == 45,
              let month = digits(5, 2), bytes[7] == 45,
              let day = digits(8, 2),
              bytes[10] == 84 || bytes[10] == 116 || bytes[10] == 32,
              let hour = digits(11, 2), bytes[13] == 58,
              let minute = digits(14, 2), bytes[16] == 58,
              let second = digits(17, 2),
              (1...12).contains(month), (1...31).contains(day),
              (0...23).contains(hour), (0...59).contains(minute), (0...59).contains(second)
        else { return nil }

        var i = 19
        var fraction = 0
        if i < bytes.count, bytes[i] == 46 {
            i += 1
            var count = 0
            while i < bytes.count, bytes[i] >= 48, bytes[i] <= 57 {
                if count < 3 { fraction = fraction * 10 + Int(bytes[i] - 48) }
                count += 1
                i += 1
            }
            guard count > 0 else { return nil }
            if count < 3 {
                for _ in count..<3 { fraction *= 10 }
            }
        }

        guard i < bytes.count else { return nil }
        var offsetSeconds = 0
        switch bytes[i] {
        case 90, 122:
            i += 1
        case 43, 45:
            guard let oh = digits(i + 1, 2), i + 3 < bytes.count, bytes[i + 3] == 58,
                  let om = digits(i + 4, 2) else { return nil }
            offsetSeconds = (oh * 3600 + om * 60) * (bytes[i] == 45 ? -1 : 1)
            i += 6
        default:
            return nil
        }
        guard i == bytes.count else { return nil }

        let days = daysFromCivil(year: year, month: month, day: day)
        let seconds = Int64(days) * 86_400 + Int64(hour * 3600 + minute * 60 + second) - Int64(offsetSeconds)
        return seconds * 1000 + Int64(fraction)
    }

    /// Days since 1970-01-01 in the proleptic Gregorian calendar
    /// (Howard Hinnant's `days_from_civil`).
    static func daysFromCivil(year: Int, month: Int, day: Int) -> Int {
        let y = month <= 2 ? year - 1 : year
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let mp = (month + 9) % 12
        let doy = (153 * mp + 2) / 5 + day - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }

    /// `millis` as RFC 3339 in UTC with three fraction digits, which
    /// `millis(_:)` reads back to the same value.
    static func string(millis: Int64) -> String {
        var seconds = millis / 1000
        var ms = millis % 1000
        if ms < 0 { ms += 1000; seconds -= 1 }
        var days = seconds / 86_400
        var rest = seconds % 86_400
        if rest < 0 { rest += 86_400; days -= 1 }
        let (y, m, d) = civil(fromDays: Int(days))
        let h = Int(rest / 3600), mi = Int(rest % 3600 / 60), s = Int(rest % 60)
        return String(format: "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", y, m, d, h, mi, s, Int(ms))
    }

    /// `date` to the nearest millisecond (a date read from milliseconds
    /// comes back the same despite floating-point error).
    static func string(date: Date) -> String {
        string(millis: Int64((date.timeIntervalSince1970 * 1000).rounded()))
    }

    /// Inverse of `daysFromCivil`.
    static func civil(fromDays z0: Int) -> (Int, Int, Int) {
        let z = z0 + 719_468
        let era = (z >= 0 ? z : z - 146_096) / 146_097
        let doe = z - era * 146_097
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365
        let y = yoe + era * 400
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let d = doy - (153 * mp + 2) / 5 + 1
        let m = mp < 10 ? mp + 3 : mp - 9
        return (m <= 2 ? y + 1 : y, m, d)
    }
}
