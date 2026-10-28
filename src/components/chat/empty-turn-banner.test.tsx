import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { EmptyTurnBanner } from "./empty-turn-banner"

describe("EmptyTurnBanner", () => {
  it("says the turn ended without a reply and retries on click", () => {
    const onRetry = vi.fn()
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <EmptyTurnBanner agent="Pi" onRetry={onRetry} />
      </NextIntlClientProvider>
    )
    expect(
      screen.getByText(
        "Pi ended the turn without a reply. Your message may not have reached it."
      )
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
