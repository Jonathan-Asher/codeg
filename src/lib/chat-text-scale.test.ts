import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  CHAT_TEXT_SCALE_LEVELS,
  CHAT_TEXT_SCALE_PROPERTY,
  DEFAULT_CHAT_TEXT_SCALE,
  MAX_CHAT_TEXT_SCALE,
  MIN_CHAT_TEXT_SCALE,
  STORAGE_KEY_CHAT_TEXT_SCALE,
  applyChatTextScale,
  isChatTextScaleLevel,
  normalizeChatTextScale,
  persistChatTextScale,
  readStoredChatTextScale,
  stepChatTextScale,
} from "./chat-text-scale"

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute("style")
})

afterEach(() => {
  vi.restoreAllMocks()
  document.documentElement.removeAttribute("style")
})

describe("chat text size rungs", () => {
  it("runs from 80% to 200% with 100% as the default", () => {
    expect(MIN_CHAT_TEXT_SCALE).toBe(80)
    expect(MAX_CHAT_TEXT_SCALE).toBe(200)
    expect(DEFAULT_CHAT_TEXT_SCALE).toBe(100)
    expect(CHAT_TEXT_SCALE_LEVELS).toContain(100)
    expect([...CHAT_TEXT_SCALE_LEVELS]).toEqual(
      [...CHAT_TEXT_SCALE_LEVELS].sort((a, b) => a - b)
    )
  })

  it("steps one rung at a time and stops at either end", () => {
    expect(stepChatTextScale(100, 1)).toBe(110)
    expect(stepChatTextScale(110, -1)).toBe(100)
    expect(stepChatTextScale(200, 1)).toBe(200)
    expect(stepChatTextScale(80, -1)).toBe(80)
  })
})

describe("normalizeChatTextScale", () => {
  it("keeps a rung as it is, from a number or the stored string", () => {
    for (const level of CHAT_TEXT_SCALE_LEVELS) {
      expect(normalizeChatTextScale(level)).toBe(level)
      expect(normalizeChatTextScale(String(level))).toBe(level)
    }
  })

  it("clamps to the range", () => {
    expect(normalizeChatTextScale(10)).toBe(80)
    expect(normalizeChatTextScale(-5)).toBe(80)
    expect(normalizeChatTextScale(500)).toBe(200)
    expect(normalizeChatTextScale("1000")).toBe(200)
  })

  it("snaps an in-between value to the nearest rung, the lower on a tie", () => {
    expect(normalizeChatTextScale(130)).toBe(125)
    expect(normalizeChatTextScale(140)).toBe(150)
    expect(normalizeChatTextScale(137.5)).toBe(125)
  })

  it("falls back to 100% for anything unreadable", () => {
    expect(normalizeChatTextScale(null)).toBe(100)
    expect(normalizeChatTextScale(undefined)).toBe(100)
    expect(normalizeChatTextScale("")).toBe(100)
    expect(normalizeChatTextScale("huge")).toBe(100)
    expect(normalizeChatTextScale(Number.NaN)).toBe(100)
    expect(normalizeChatTextScale({})).toBe(100)
  })

  it("only calls the rungs themselves levels", () => {
    expect(isChatTextScaleLevel(125)).toBe(true)
    expect(isChatTextScaleLevel(130)).toBe(false)
    expect(isChatTextScaleLevel("125")).toBe(false)
  })
})

describe("persistence", () => {
  it("round-trips through localStorage", () => {
    persistChatTextScale(150)
    expect(localStorage.getItem(STORAGE_KEY_CHAT_TEXT_SCALE)).toBe("150")
    expect(readStoredChatTextScale()).toBe(150)
  })

  it("reads 100% for a fresh profile and snaps a stored off-rung value", () => {
    expect(readStoredChatTextScale()).toBe(100)
    localStorage.setItem(STORAGE_KEY_CHAT_TEXT_SCALE, "130")
    expect(readStoredChatTextScale()).toBe(125)
    localStorage.setItem(STORAGE_KEY_CHAT_TEXT_SCALE, "garbage")
    expect(readStoredChatTextScale()).toBe(100)
  })

  it("survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied")
    })
    expect(readStoredChatTextScale()).toBe(100)
    expect(() => persistChatTextScale(125)).not.toThrow()
  })
})

describe("applyChatTextScale", () => {
  it("writes the scale as a plain number on the element", () => {
    const root = document.documentElement
    applyChatTextScale(root, 125)
    expect(root.style.getPropertyValue(CHAT_TEXT_SCALE_PROPERTY)).toBe("1.25")
    applyChatTextScale(root, 80)
    expect(root.style.getPropertyValue(CHAT_TEXT_SCALE_PROPERTY)).toBe("0.8")
  })

  it("removes the property at 100% rather than writing 1", () => {
    const root = document.documentElement
    applyChatTextScale(root, 175)
    applyChatTextScale(root, 100)
    expect(root.style.getPropertyValue(CHAT_TEXT_SCALE_PROPERTY)).toBe("")
  })
})
