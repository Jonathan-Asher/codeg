// Runs every test* method of every XCTestCase subclass linked into this binary.
// Async tests (exposed to Objective-C as testXWithCompletionHandler:) run with
// a completion block while the main run loop spins.
import Foundation
import ObjectiveC
import XCTest

let filter = CommandLine.arguments.dropFirst().first
var testClasses: [XCTestCase.Type] = allTestClasses
testClasses.sort { NSStringFromClass($0) < NSStringFromClass($1) }
var ran = 0
for cls in testClasses {
    var methodCount: UInt32 = 0
    guard let methods = class_copyMethodList(cls, &methodCount) else { continue }
    var names: [String] = []
    for j in 0..<Int(methodCount) {
        let name = NSStringFromSelector(method_getName(methods[j]))
        if name.hasPrefix("test"),
           !name.contains(":") || name.hasSuffix("AndReturnError:") || name.hasSuffix("WithCompletionHandler:") {
            names.append(name)
        }
    }
    free(methods)
    for name in names.sorted() {
        let full = "\(NSStringFromClass(cls)).\(name)"
        if let filter, !full.contains(filter) { continue }
        _currentTest = full
        let instance = cls.init()
        instance.setUp()
        try? instance.setUpWithError()
        if name.hasSuffix("WithCompletionHandler:") {
            var done = false
            let block: @convention(block) () -> Void = { done = true }
            _ = instance.perform(NSSelectorFromString(name), with: block)
            let deadline = Date().addingTimeInterval(30)
            while !done, Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.002)) }
            if !done { _failures.append("\(full): timed out") }
        } else if name.hasSuffix(":") {
            _ = instance.perform(NSSelectorFromString(name), with: nil)
        } else {
            _ = instance.perform(NSSelectorFromString(name))
        }
        instance.tearDown()
        try? instance.tearDownWithError()
        ran += 1
    }
}
for f in _failures { print("FAIL", f) }
print("ran \(ran) tests, \(_failures.count) failures")
exit(_failures.isEmpty ? 0 : 1)
