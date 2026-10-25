import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"

import {
  DEFAULT_SESSION_COLUMN_WIDTH,
  FULL_SESSION_COLUMN_MAX_WIDTH,
  MAX_CUSTOM_SESSION_COLUMN_WIDTH,
  MIN_CUSTOM_SESSION_COLUMN_WIDTH,
  SESSION_COLUMN_MAX_WIDTH_PROPERTY,
  STORAGE_KEY_SESSION_COLUMN_WIDTH,
  applySessionColumnWidth,
  clampCustomSessionColumnWidth,
  nextSessionColumnWidth,
  normalizeSessionColumnWidth,
  persistSessionColumnWidth,
  readStoredSessionColumnWidth,
  sessionColumnMaxWidthCss,
  sessionColumnWidthPx,
} from "./session-column-width"

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute("style")
})

describe("session column width values", () => {
  it("defaults to the standard 768px column, today's max-w-3xl", () => {
    expect(DEFAULT_SESSION_COLUMN_WIDTH).toBe("standard")
    expect(sessionColumnWidthPx("standard")).toBe(768)
    expect(sessionColumnMaxWidthCss("standard")).toBe("48rem")
  })

  it("maps every preset to a rem width, and Full to the panel", () => {
    expect(sessionColumnMaxWidthCss("wide")).toBe("64rem")
    expect(sessionColumnMaxWidthCss("extra-wide")).toBe("80rem")
    expect(sessionColumnWidthPx("full")).toBeNull()
    expect(sessionColumnMaxWidthCss("full")).toBe(FULL_SESSION_COLUMN_MAX_WIDTH)
    expect(sessionColumnMaxWidthCss(1100)).toBe("68.75rem")
  })

  it("keeps preset names and reads anything unreadable as the default", () => {
    for (const preset of ["standard", "wide", "extra-wide", "full"]) {
      expect(normalizeSessionColumnWidth(preset)).toBe(preset)
    }
    for (const junk of [null, undefined, "", "  ", "huge", {}, Number.NaN]) {
      expect(normalizeSessionColumnWidth(junk)).toBe("standard")
    }
  })

  it("clamps a custom width to the range and rounds it to whole px", () => {
    expect(normalizeSessionColumnWidth(100)).toBe(
      MIN_CUSTOM_SESSION_COLUMN_WIDTH
    )
    expect(normalizeSessionColumnWidth("99999")).toBe(
      MAX_CUSTOM_SESSION_COLUMN_WIDTH
    )
    expect(normalizeSessionColumnWidth("1100.4")).toBe(1100)
    expect(clampCustomSessionColumnWidth(Number.POSITIVE_INFINITY)).toBe(768)
  })

  it("folds a custom width that equals a preset into the preset", () => {
    expect(normalizeSessionColumnWidth(768)).toBe("standard")
    expect(normalizeSessionColumnWidth("1024")).toBe("wide")
    expect(normalizeSessionColumnWidth(1280)).toBe("extra-wide")
  })

  it("cycles Standard → Wide → Extra wide → Full and round again", () => {
    expect(nextSessionColumnWidth("standard")).toBe("wide")
    expect(nextSessionColumnWidth("wide")).toBe("extra-wide")
    expect(nextSessionColumnWidth("extra-wide")).toBe("full")
    expect(nextSessionColumnWidth("full")).toBe("standard")
  })

  it("cycles a custom width to the next preset wider than it", () => {
    expect(nextSessionColumnWidth(640)).toBe("standard")
    expect(nextSessionColumnWidth(900)).toBe("wide")
    expect(nextSessionColumnWidth(1100)).toBe("extra-wide")
    expect(nextSessionColumnWidth(2000)).toBe("full")
  })
})

describe("session column width storage and DOM", () => {
  const property = () =>
    document.documentElement.style.getPropertyValue(
      SESSION_COLUMN_MAX_WIDTH_PROPERTY
    )

  it("round-trips presets and custom widths through localStorage", () => {
    expect(readStoredSessionColumnWidth()).toBe("standard")
    persistSessionColumnWidth("full")
    expect(localStorage.getItem(STORAGE_KEY_SESSION_COLUMN_WIDTH)).toBe("full")
    expect(readStoredSessionColumnWidth()).toBe("full")
    persistSessionColumnWidth(1100)
    expect(readStoredSessionColumnWidth()).toBe(1100)
  })

  it("writes the variable for a non-standard width and removes it for Standard", () => {
    applySessionColumnWidth(document.documentElement, "wide")
    expect(property()).toBe("64rem")
    applySessionColumnWidth(document.documentElement, 1100)
    expect(property()).toBe("68.75rem")
    applySessionColumnWidth(document.documentElement, "standard")
    expect(property()).toBe("")
  })
})

describe("the session column reads the variable", () => {
  function read(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf8")
  }

  /** Every wrapper of the conversation column, which must stay aligned. */
  const COLUMN_FILES: Array<[string, number]> = [
    ["src/components/chat/conversation-shell.tsx", 5],
    ["src/components/message/virtualized-message-thread.tsx", 2],
    ["src/components/conversations/conversation-detail-panel.tsx", 2],
    ["src/components/chat/pi-project-trust-banner.tsx", 1],
    ["src/components/chat/session-config-stale-banner.tsx", 1],
  ]

  it.each(COLUMN_FILES)("%s caps its column with the variable", (path, n) => {
    const source = read(path)
    expect(source).not.toContain("max-w-3xl")
    expect(source.split("max-w-(--session-column-max-width)").length - 1).toBe(
      n
    )
  })

  it("gives the variable the standard width when nothing is written", () => {
    const css = read("src/app/globals.css")
    expect(css).toMatch(/--session-column-max-width:\s*48rem;/)
  })
})
