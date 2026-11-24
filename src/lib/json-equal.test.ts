import { describe, expect, it } from "vitest"
import { jsonEqual } from "./json-equal"

describe("jsonEqual", () => {
  it("compares nested tree nodes by value", () => {
    const tree = () => [
      {
        name: "src",
        path: "src",
        kind: "dir",
        children: [{ name: "a.ts", path: "src/a.ts", kind: "file" }],
      },
    ]
    expect(jsonEqual(tree(), tree())).toBe(true)
    const renamed = tree()
    renamed[0].children[0].name = "b.ts"
    expect(jsonEqual(tree(), renamed)).toBe(false)
  })

  it("tells arrays apart by length and order", () => {
    expect(jsonEqual([1, 2], [1, 2])).toBe(true)
    expect(jsonEqual([1, 2], [2, 1])).toBe(false)
    expect(jsonEqual([1, 2], [1, 2, 3])).toBe(false)
  })

  it("tells objects apart by keys, a missing key included", () => {
    expect(jsonEqual({ a: 1, b: null }, { b: null, a: 1 })).toBe(true)
    expect(jsonEqual({ a: 1, b: undefined }, { a: 1, c: undefined })).toBe(
      false
    )
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
  })

  it("never equates an array with an object, or null with an object", () => {
    expect(jsonEqual([], {})).toBe(false)
    expect(jsonEqual({}, [])).toBe(false)
    expect(jsonEqual(null, {})).toBe(false)
    expect(jsonEqual({}, null)).toBe(false)
  })

  it("compares primitives strictly", () => {
    expect(jsonEqual("1", 1)).toBe(false)
    expect(jsonEqual(0, -0)).toBe(true)
    expect(jsonEqual("M", "M")).toBe(true)
  })
})
