import { type ReactNode } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/ai-elements/link-safety", () => ({
  FilePathLink: ({ children }: { children: ReactNode }) => <>{children}</>,
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))
vi.mock("@/components/ai-elements/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}))
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => (
    <div data-testid="reply-text">{children}</div>
  ),
}))

import { ContentPartsRenderer } from "./content-parts-renderer"
import { ProviderErrorNotice } from "./provider-error-notice"
import enMessages from "@/i18n/messages/en.json"
import { detectProviderError } from "@/lib/provider-errors"

// Synthesized in the shape Claude Code writes; not copied from any session.
const BLOCKED =
  "API Error: 400 This request was blocked as it seems to violate the provider's terms of service on example misuse. To learn more, visit https://example.com/legal/terms."
const P = enMessages.Folder.chat.providerError

function renderEn(ui: ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("ProviderErrorNotice", () => {
  it("says who stopped and why, links the provider's page, folds the raw text", () => {
    renderEn(
      <ProviderErrorNotice error={detectProviderError(BLOCKED)!} scope="turn" />
    )
    expect(
      screen.getByText(P.turnStopped.replace("{reason}", P.reason.policy_block))
    ).toBeInTheDocument()
    expect(
      screen.getByRole("link", { name: "https://example.com/legal/terms" })
    ).toHaveAttribute("href", "https://example.com/legal/terms")
    expect(screen.queryByText(BLOCKED)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: P.details }))
    expect(screen.getByText(BLOCKED)).toBeInTheDocument()
  })

  it("has no link line when the provider gave none", () => {
    renderEn(
      <ProviderErrorNotice
        error={detectProviderError("API Error: 429 Too many requests")!}
        scope="subagent"
      />
    )
    expect(
      screen.getByText(
        P.subagentStopped.replace("{reason}", P.reason.rate_limit)
      )
    ).toBeInTheDocument()
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
  })
})

describe("ContentPartsRenderer: the agent's own API-error line", () => {
  it("renders the line as a compact stopped state, not as reply text", () => {
    renderEn(
      <ContentPartsRenderer
        role="assistant"
        parts={[{ type: "text", text: BLOCKED }]}
      />
    )
    expect(
      screen.getByText(P.turnStopped.replace("{reason}", P.reason.policy_block))
    ).toBeInTheDocument()
    expect(screen.queryByTestId("reply-text")).not.toBeInTheDocument()
  })

  it("leaves an ordinary reply alone", () => {
    renderEn(
      <ContentPartsRenderer
        role="assistant"
        parts={[{ type: "text", text: "Here is what I found." }]}
      />
    )
    expect(screen.getByTestId("reply-text")).toHaveTextContent(
      "Here is what I found."
    )
  })

  it("leaves a user's message alone even when it pastes one", () => {
    renderEn(
      <ContentPartsRenderer
        role="user"
        parts={[{ type: "text", text: BLOCKED }]}
      />
    )
    expect(
      screen.queryByText(
        P.turnStopped.replace("{reason}", P.reason.policy_block)
      )
    ).not.toBeInTheDocument()
  })
})
