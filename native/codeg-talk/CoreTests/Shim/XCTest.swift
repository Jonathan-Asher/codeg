// A minimal stand-in for XCTest so the unit tests can be compiled and run with
// the command-line tools (no Xcode on this machine). Only what the tests use.
@_exported import Foundation

nonisolated(unsafe) public var _failures: [String] = []
nonisolated(unsafe) public var _currentTest = ""

@objcMembers
open class XCTestCase: NSObject {
    public required override init() { super.init() }
    open func setUp() {}
    open func tearDown() {}
    open func setUpWithError() throws {}
    open func tearDownWithError() throws {}
}

public struct XCTSkip: Error { public init(_ message: String = "") {} }

@inline(never)
public func _record(_ message: String, _ file: StaticString, _ line: UInt) {
    _failures.append("\(_currentTest) \(URL(fileURLWithPath: "\(file)").lastPathComponent):\(line): \(message)")
}

public func XCTFail(_ message: String = "", file: StaticString = #filePath, line: UInt = #line) {
    _record("XCTFail \(message)", file, line)
}

public func XCTAssertEqual<T: Equatable>(_ a: @autoclosure () throws -> T, _ b: @autoclosure () throws -> T,
                                         _ message: @autoclosure () -> String = "",
                                         file: StaticString = #filePath, line: UInt = #line) {
    do {
        let x = try a(), y = try b()
        if x != y { _record("XCTAssertEqual failed: (\"\(x)\") is not equal to (\"\(y)\") \(message())", file, line) }
    } catch { _record("threw \(error)", file, line) }
}

public func XCTAssertEqual<T: FloatingPoint>(_ a: @autoclosure () throws -> T, _ b: @autoclosure () throws -> T,
                                             accuracy: T, _ message: @autoclosure () -> String = "",
                                             file: StaticString = #filePath, line: UInt = #line) {
    do {
        let x = try a(), y = try b()
        if abs(x - y) > accuracy { _record("XCTAssertEqual failed: \(x) vs \(y) ± \(accuracy) \(message())", file, line) }
    } catch { _record("threw \(error)", file, line) }
}

public func XCTAssertNotEqual<T: Equatable>(_ a: @autoclosure () throws -> T, _ b: @autoclosure () throws -> T,
                                            _ message: @autoclosure () -> String = "",
                                            file: StaticString = #filePath, line: UInt = #line) {
    do {
        let x = try a(), y = try b()
        if x == y { _record("XCTAssertNotEqual failed: \(x) \(message())", file, line) }
    } catch { _record("threw \(error)", file, line) }
}

public func XCTAssertTrue(_ e: @autoclosure () throws -> Bool, _ message: @autoclosure () -> String = "",
                          file: StaticString = #filePath, line: UInt = #line) {
    do { if !(try e()) { _record("XCTAssertTrue failed \(message())", file, line) } } catch { _record("threw \(error)", file, line) }
}

public func XCTAssertFalse(_ e: @autoclosure () throws -> Bool, _ message: @autoclosure () -> String = "",
                           file: StaticString = #filePath, line: UInt = #line) {
    do { if try e() { _record("XCTAssertFalse failed \(message())", file, line) } } catch { _record("threw \(error)", file, line) }
}

public func XCTAssert(_ e: @autoclosure () throws -> Bool, _ message: @autoclosure () -> String = "",
                      file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertTrue(try e(), message(), file: file, line: line)
}

public func XCTAssertNil(_ e: @autoclosure () throws -> Any?, _ message: @autoclosure () -> String = "",
                         file: StaticString = #filePath, line: UInt = #line) {
    do { if let v = try e() { _record("XCTAssertNil failed: \(v) \(message())", file, line) } } catch { _record("threw \(error)", file, line) }
}

public func XCTAssertNotNil(_ e: @autoclosure () throws -> Any?, _ message: @autoclosure () -> String = "",
                            file: StaticString = #filePath, line: UInt = #line) {
    do { if try e() == nil { _record("XCTAssertNotNil failed \(message())", file, line) } } catch { _record("threw \(error)", file, line) }
}

public struct XCTUnwrapError: Error {}
public func XCTUnwrap<T>(_ e: @autoclosure () throws -> T?, _ message: @autoclosure () -> String = "",
                         file: StaticString = #filePath, line: UInt = #line) throws -> T {
    guard let v = try e() else { _record("XCTUnwrap failed \(message())", file, line); throw XCTUnwrapError() }
    return v
}

public func XCTAssertGreaterThan<T: Comparable>(_ a: @autoclosure () throws -> T, _ b: @autoclosure () throws -> T,
                                                _ message: @autoclosure () -> String = "",
                                                file: StaticString = #filePath, line: UInt = #line) {
    do { let x = try a(), y = try b(); if !(x > y) { _record("XCTAssertGreaterThan failed: \(x) <= \(y) \(message())", file, line) } } catch { _record("threw \(error)", file, line) }
}

public func XCTAssertGreaterThanOrEqual<T: Comparable>(_ a: @autoclosure () throws -> T, _ b: @autoclosure () throws -> T,
                                                       _ message: @autoclosure () -> String = "",
                                                       file: StaticString = #filePath, line: UInt = #line) {
    do { let x = try a(), y = try b(); if !(x >= y) { _record("XCTAssertGreaterThanOrEqual failed: \(x) < \(y) \(message())", file, line) } } catch { _record("threw \(error)", file, line) }
}

public func XCTAssertLessThan<T: Comparable>(_ a: @autoclosure () throws -> T, _ b: @autoclosure () throws -> T,
                                             _ message: @autoclosure () -> String = "",
                                             file: StaticString = #filePath, line: UInt = #line) {
    do { let x = try a(), y = try b(); if !(x < y) { _record("XCTAssertLessThan failed: \(x) >= \(y) \(message())", file, line) } } catch { _record("threw \(error)", file, line) }
}

public func XCTAssertLessThanOrEqual<T: Comparable>(_ a: @autoclosure () throws -> T, _ b: @autoclosure () throws -> T,
                                                    _ message: @autoclosure () -> String = "",
                                                    file: StaticString = #filePath, line: UInt = #line) {
    do { let x = try a(), y = try b(); if !(x <= y) { _record("XCTAssertLessThanOrEqual failed: \(x) > \(y) \(message())", file, line) } } catch { _record("threw \(error)", file, line) }
}
