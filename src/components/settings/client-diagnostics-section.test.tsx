import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import en from "@/i18n/messages/en.json"
import type { ClientDiagnosticSummary } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  listClientDiagnostics: vi.fn(),
  getClientDiagnostic: vi.fn(),
}))

vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils")>()),
  copyTextToClipboard: vi.fn(async () => true),
}))

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock("@/lib/app-error", () => ({
  toErrorMessage: (e: unknown) => String(e),
}))

import { getClientDiagnostic, listClientDiagnostics } from "@/lib/api"
import { copyTextToClipboard } from "@/lib/utils"
import { toast } from "sonner"
import {
  ClientDiagnosticsSection,
  diagnosticHeadline,
} from "./client-diagnostics-section"

const crash: ClientDiagnosticSummary = {
  id: "A1B2",
  receivedAtMs: Date.UTC(2026, 9, 19, 13, 16),
  kind: "uncaught_exception",
  source: "exception_handler",
  occurredAt: "2026-10-19T13:15:06.033Z",
  appVersion: "1.3.17",
  appBuild: "105",
  deviceModel: "iPhone18,2",
  os: "iOS 27.2 (24B5089g)",
  exceptionType: "EXC_CRASH",
  signal: "SIGABRT",
  exceptionName: "com.apple.coreaudio.avfaudio",
  reason:
    "required condition is false: format.sampleRate == hwFormat.sampleRate",
  context: null,
  topFrames: ["AVFAudio +458544", "AVFAudio +934844", "Codeg +2437700"],
  breadcrumbCount: 12,
  sizeBytes: 4096,
}

function renderSection() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ClientDiagnosticsSection />
    </NextIntlClientProvider>
  )
}

describe("ClientDiagnosticsSection", () => {
  beforeEach(() => {
    vi.mocked(listClientDiagnostics).mockReset()
    vi.mocked(getClientDiagnostic).mockReset()
    vi.mocked(copyTextToClipboard).mockClear()
  })

  it("lists the reports with their build, reason and top frames", async () => {
    vi.mocked(listClientDiagnostics).mockResolvedValue([crash])
    renderSection()
    expect(
      await screen.findByText(
        "com.apple.coreaudio.avfaudio · EXC_CRASH (SIGABRT)"
      )
    ).toBeTruthy()
    expect(screen.getByText(/1\.3\.17 \(105\)/)).toBeTruthy()
    expect(screen.getByText(crash.reason!)).toBeTruthy()
    expect(screen.getByText(/Codeg \+2437700/)).toBeTruthy()
    expect(listClientDiagnostics).toHaveBeenCalledWith(50)
  })

  it("copies the whole report", async () => {
    vi.mocked(listClientDiagnostics).mockResolvedValue([crash])
    const full = { receivedAtMs: 1, report: { id: "A1B2", kind: "crash" } }
    vi.mocked(getClientDiagnostic).mockResolvedValue(full)
    renderSection()
    fireEvent.click(await screen.findByRole("button", { name: /Copy report/ }))
    await waitFor(() =>
      expect(copyTextToClipboard).toHaveBeenCalledWith(
        JSON.stringify(full, null, 2)
      )
    )
    expect(getClientDiagnostic).toHaveBeenCalledWith("A1B2")
    expect(toast.success).toHaveBeenCalledWith("Crash report copied")
  })

  it("says so when there are none", async () => {
    vi.mocked(listClientDiagnostics).mockResolvedValue([])
    renderSection()
    expect(
      await screen.findByText("No crash reports from the iPhone app yet.")
    ).toBeTruthy()
  })

  it("names a report without an exception by its kind", () => {
    expect(
      diagnosticHeadline({
        ...crash,
        exceptionName: null,
        exceptionType: null,
        signal: null,
        kind: "hang",
      })
    ).toBe("hang")
    expect(
      diagnosticHeadline({ ...crash, exceptionName: null, signal: null })
    ).toBe("EXC_CRASH")
  })
})
