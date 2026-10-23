import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import { DELEGATION_PAUSED_CODE, StatusBadge } from "./delegation-status-badge"
import enMessages from "@/i18n/messages/en.json"

const status = enMessages.Folder.chat.delegation.status

function badge(errorCode?: string) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StatusBadge status="err" errorCode={errorCode} />
    </NextIntlClientProvider>
  )
}

describe("StatusBadge", () => {
  it("shows a delegation a usage limit paused as paused, not failed", () => {
    badge(DELEGATION_PAUSED_CODE)
    expect(screen.getByText(status.paused)).toBeInTheDocument()
    expect(screen.queryByText(status.err.default)).toBeNull()
  })

  it("keeps a real failure a failure", () => {
    badge("child_refusal")
    expect(screen.getByText(status.err.child_refusal)).toBeInTheDocument()
    expect(screen.queryByText(status.paused)).toBeNull()
  })
})
