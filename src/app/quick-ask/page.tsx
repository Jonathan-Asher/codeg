"use client"

import { Suspense } from "react"
import { QuickAskShell } from "./_components/QuickAskShell"

// Route loaded inside the desktop-only `quick-ask` window (opened by the
// global shortcut). A window bound to a remote workspace carries
// `remoteConnectionId` / `remoteWindowId` query params, like every other
// remote-bound window; the gate inside the shell reads them.
export default function QuickAskPage() {
  return (
    <Suspense fallback={null}>
      <QuickAskShell />
    </Suspense>
  )
}
