import { renderHook } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import { describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { isAttachingPhase } from "@/lib/attach-phase"

import { useAttachPhaseLabel } from "./use-attach-phase-label"

function wrapper({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {children}
    </NextIntlClientProvider>
  )
}

describe("useAttachPhaseLabel while waiting for the account pool", () => {
  it("counts as still opening", () => {
    expect(isAttachingPhase("pool_wait")).toBe(true)
  })

  it("says the subscriptions are out and when the next one frees", () => {
    const at = Math.floor(Date.now() / 1000) + 3600
    const { result } = renderHook(
      () =>
        useAttachPhaseLabel("Claude Code", "pool_wait", Date.now(), {
          resumesAt: at,
        }),
      { wrapper }
    )
    expect(result.current?.text).toMatch(
      /^All Claude subscriptions are at their limit — the next one frees at \d{1,2}:\d{2}/
    )
    expect(result.current?.slow).toBe(false)
  })

  it("says just that when the pool does not know when", () => {
    const { result } = renderHook(
      () =>
        useAttachPhaseLabel("Claude Code", "pool_wait", Date.now(), {
          resumesAt: null,
        }),
      { wrapper }
    )
    expect(result.current?.text).toBe(
      enMessages.Folder.chat.attachPhase.poolWait
    )
  })
})
