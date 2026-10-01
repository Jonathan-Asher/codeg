import { render, screen, act, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppUpdateState, BusySessionsReport } from "@/lib/updater"
import type { RemoteWorkspaceConnection } from "@/lib/types"

// A remote-desktop window (this Mac's app bound to a remote) whose remote runs
// the codeg desktop app: the update asks first, and the remote restarts by
// itself. Everything goes through the mocked remote transport.

let snapshot: AppUpdateState = { seq: 0, status: "idle" }
let running = "0.21.7"
let busy: BusySessionsReport = { sessions: [], autoResume: true }
// Successive /health answers; an Error entry means "unreachable".
let healthQueue: Array<{ version: string } | Error> = []
const reconnectCbs = new Set<() => void>()
let liveHandler: ((s: AppUpdateState) => void) | null = null

const call = vi.fn(async (endpoint: string, args?: unknown) => {
  switch (endpoint) {
    case "app_update_state":
      return snapshot
    case "app_update_status":
      return {
        currentVersion: running,
        selfUpdateSupported: true,
        capability: "desktop",
        runtime: "desktop",
        restartDelayMs: 4000,
        rollbackAvailable: false,
        liveProgress: true,
      }
    case "check_app_update":
      return {
        currentVersion: running,
        update: { version: "0.21.9", body: "", date: null },
        selfUpdateSupported: true,
        capability: "desktop",
        runtime: "desktop",
        restartDelayMs: 4000,
        rollbackAvailable: false,
        liveProgress: true,
      }
    case "app_update_busy_sessions":
      return busy
    case "perform_app_update":
      return {
        seq: 2,
        status: "downloading",
        downloaded: 0,
        mode: (args as { mode?: string } | undefined)?.mode,
      }
    case "cancel_app_update":
      return snapshot
    case "health": {
      const next =
        healthQueue.length > 1 ? healthQueue.shift()! : healthQueue[0]
      if (!next || next instanceof Error) throw next ?? new Error("down")
      return next
    }
  }
  throw new Error(`unexpected endpoint: ${endpoint}`)
})

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({
    call,
    subscribe: async (_event: string, handler: (s: AppUpdateState) => void) => {
      liveHandler = handler
      return () => {}
    },
    onReconnect: (cb: () => void) => {
      reconnectCbs.add(cb)
      return () => reconnectCbs.delete(cb)
    },
  }),
  isDesktop: () => true,
  isRemoteDesktopMode: () => true,
  getActiveRemoteConnectionId: () => 7,
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { toast } from "sonner"
import { UpdateProvider, useAppUpdate } from "./update-provider"
import { RemoteConnectionContext } from "@/contexts/remote-connection-value"
import enMessages from "@/i18n/messages/en.json"

function Probe() {
  const u = useAppUpdate()
  return (
    <div>
      <div data-testid="status">{u?.state.status}</div>
      <div data-testid="capability">{u?.capability ?? "none"}</div>
      <div data-testid="name">{u?.remoteName ?? "none"}</div>
      <div data-testid="current">{u?.currentVersion}</div>
      <div data-testid="updated">{u?.updatedTo ?? "none"}</div>
      <div data-testid="restarting">{String(u?.isRestarting)}</div>
      <button onClick={() => void u?.startUpdate()}>start</button>
      <button onClick={() => void u?.cancelUpdate()}>cancel</button>
    </div>
  )
}

const connection = {
  id: 7,
  name: "studio",
  base_url: "http://studio:3080",
} as RemoteWorkspaceConnection

function renderRemote() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RemoteConnectionContext.Provider
        value={{ connection, expired: false, markExpired: () => {} }}
      >
        <UpdateProvider>
          <Probe />
        </UpdateProvider>
      </RemoteConnectionContext.Provider>
    </NextIntlClientProvider>
  )
}

const text = (id: string) => screen.getByTestId(id).textContent

async function emit(state: AppUpdateState) {
  await act(async () => {
    liveHandler?.(state)
  })
}

beforeEach(() => {
  call.mockClear()
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
  reconnectCbs.clear()
  liveHandler = null
  snapshot = { seq: 0, status: "idle" }
  running = "0.21.7"
  busy = { sessions: [], autoResume: true }
  healthQueue = [{ version: "0.21.7" }]
  localStorage.clear()
})

describe("UpdateProvider — remote desktop app", () => {
  it("names the remote and asks before updating it", async () => {
    busy = {
      autoResume: true,
      sessions: [
        { conversationId: 1, title: "Long refactor", reason: "working" },
        { conversationId: 2, title: "Waiting on me", reason: "needs_you" },
      ],
    }
    renderRemote()
    await waitFor(() => expect(text("capability")).toBe("desktop"))
    expect(text("name")).toBe("studio")

    fireEvent.click(screen.getByRole("button", { name: "start" }))

    // The confirm dialog, not an update: it lists what the restart cuts off.
    expect(await screen.findByText("2 sessions are mid-turn")).toBeVisible()
    expect(screen.getByText("Long refactor")).toBeVisible()
    expect(call).not.toHaveBeenCalledWith(
      "perform_app_update",
      expect.anything()
    )

    fireEvent.click(screen.getByRole("button", { name: "Update when idle" }))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("perform_app_update", {
        mode: "when_idle",
      })
    )
    await waitFor(() => expect(text("status")).toBe("downloading"))
  })

  it("can go ahead right away from the dialog", async () => {
    renderRemote()
    await waitFor(() => expect(text("capability")).toBe("desktop"))
    fireEvent.click(screen.getByRole("button", { name: "start" }))
    expect(
      await screen.findByText("No session is mid-turn right now.")
    ).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Update now" }))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("perform_app_update", { mode: "now" })
    )
  })

  it("cancels a remote update that is waiting for idle", async () => {
    renderRemote()
    await waitFor(() => expect(text("capability")).toBe("desktop"))
    await emit({
      seq: 4,
      status: "waiting_for_idle",
      version: "0.21.9",
      mode: "when_idle",
      busySessions: [],
      quietSecsLeft: 30,
      quietSecs: 60,
    })
    expect(text("status")).toBe("waiting_for_idle")

    snapshot = { seq: 5, status: "idle" }
    fireEvent.click(screen.getByRole("button", { name: "cancel" }))
    await waitFor(() => expect(call).toHaveBeenCalledWith("cancel_app_update"))
    await waitFor(() => expect(text("status")).toBe("idle"))
  })

  it(
    "follows the remote through its restart and reconnect, then confirms the new version",
    { timeout: 20_000 },
    async () => {
      renderRemote()
      await waitFor(() => expect(text("current")).toBe("0.21.7"))
      await waitFor(() => expect(text("capability")).toBe("desktop"))

      await emit({
        seq: 3,
        status: "downloading",
        downloaded: 42,
        total: 100,
        version: "0.21.9",
        mode: "now",
      })
      await emit({ seq: 4, status: "installing", version: "0.21.9" })

      // The remote goes away, then answers on the new version.
      healthQueue = [new Error("down"), { version: "0.21.9" }]
      await emit({ seq: 6, status: "restarting", version: "0.21.9" })
      await waitFor(() => expect(text("restarting")).toBe("true"))

      // The transport reconnects to the new process, whose seq starts over.
      running = "0.21.9"
      snapshot = { seq: 1, status: "idle" }
      await act(async () => {
        for (const cb of [...reconnectCbs]) cb()
      })
      await waitFor(() => expect(text("status")).toBe("idle"))

      await waitFor(() => expect(text("updated")).toBe("0.21.9"), {
        timeout: 10_000,
      })
      expect(text("current")).toBe("0.21.9")
      expect(text("restarting")).toBe("false")
      expect(toast.success).toHaveBeenCalledWith(
        "The remote is now on v0.21.9."
      )
    }
  )

  it(
    "reports a remote that came back on the same version",
    { timeout: 20_000 },
    async () => {
      renderRemote()
      await waitFor(() => expect(text("current")).toBe("0.21.7"))
      await waitFor(() => expect(text("capability")).toBe("desktop"))

      healthQueue = [new Error("down"), { version: "0.21.7" }]
      await emit({ seq: 6, status: "restarting", version: "0.21.9" })

      await waitFor(
        () =>
          expect(toast.error).toHaveBeenCalledWith(
            "The remote restarted but is still on v0.21.7."
          ),
        { timeout: 10_000 }
      )
      expect(text("updated")).toBe("none")
    }
  )
})
