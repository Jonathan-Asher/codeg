import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import type { UpdateContextValue } from "@/components/providers/update-provider"

// The two controllers a window can carry: the window's backend ("active") and,
// in a remote workspace window, this machine's own app ("local").
let active: Partial<UpdateContextValue> | null = null
let local: Partial<UpdateContextValue> | null = null
vi.mock("@/components/providers/update-provider", () => ({
  useAppUpdate: (target: "active" | "local" = "active") =>
    target === "local" ? local : active,
}))

import { useRunningVersionsLine } from "./running-versions"
import enMessages from "@/i18n/messages/en.json"

function Line() {
  return <div data-testid="line">{useRunningVersionsLine() ?? "none"}</div>
}

const line = () => {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <Line />
    </NextIntlClientProvider>
  )
  return screen.getByTestId("line").textContent
}

describe("useRunningVersionsLine", () => {
  it("names this app and the server in a remote window", () => {
    // The settings window of a remote workspace: only the remote's controller
    // is mounted, and it carries this app's version alongside.
    active = {
      serverName: "Johnnysclawd",
      currentVersion: "0.32.3-fork.224",
      appVersion: "0.32.3-fork.229",
    }
    local = null
    expect(line()).toBe(
      "This app: v0.32.3-fork.229 · Server Johnnysclawd: v0.32.3-fork.224"
    )
  })

  it("falls back to the local controller for this app's version", () => {
    active = {
      serverName: "Johnnysclawd",
      currentVersion: "0.32.3-fork.224",
      appVersion: null,
    }
    local = { currentVersion: "0.32.3-fork.229" }
    expect(line()).toBe(
      "This app: v0.32.3-fork.229 · Server Johnnysclawd: v0.32.3-fork.224"
    )
  })

  it("shows a dash for a version not read yet", () => {
    active = { serverName: "studio", currentVersion: "", appVersion: "1.0.0" }
    local = null
    expect(line()).toBe("This app: v1.0.0 · Server studio: —")
  })

  it("leaves a window with one build to its own single-version line", () => {
    active = {
      serverName: null,
      currentVersion: "0.32.3-fork.229",
      appVersion: "0.32.3-fork.229",
    }
    local = null
    expect(line()).toBe("none")
  })
})
