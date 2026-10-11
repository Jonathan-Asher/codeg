"use client"

// Next's last-resort boundary: an error in the root layout itself (one of
// its providers), which no boundary inside the layout can catch. It replaces
// the whole document, so it brings its own <html>, renders without the
// app's providers or stylesheet, and stays in English.
//
// Instead of Next's bare "Application error" it reports the error to the
// backend's log, tries the layout again a few times by itself (a provider
// that failed while the server was unreachable usually renders once it is
// back), and offers a reload.

import { useEffect } from "react"

import { reportBoundaryError } from "@/lib/client-error-report"

const AUTO_RETRY_DELAYS_MS = [3_000, 10_000, 30_000]
// Module scope: this component remounts on every failed retry.
let autoRetries = 0

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    reportBoundaryError("global", error)
  }, [error])

  useEffect(() => {
    const delay = AUTO_RETRY_DELAYS_MS[autoRetries]
    if (delay === undefined) return
    const id = setTimeout(() => {
      autoRetries++
      reset()
    }, delay)
    return () => clearTimeout(id)
  }, [reset])

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          background: "#09090b",
          color: "#fafafa",
        }}
      >
        <div
          role="alert"
          style={{ maxWidth: 360, textAlign: "center", padding: 24 }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
            codeg hit an unexpected error
          </div>
          <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 16px" }}>
            It will try again by itself in a moment. If the server was
            restarting, this usually clears once it is back.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button type="button" onClick={() => reset()}>
              Try again
            </button>
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </body>
    </html>
  )
}
