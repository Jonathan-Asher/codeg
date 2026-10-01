import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { UpdateContextValue } from "@/components/providers/update-provider"
import type { AppUpdateState } from "@/lib/updater"

// Drive the component straight off the context value: the provider's own
// behaviour (checking, scheduling, seq guards) is covered in its test.
let ctx: UpdateContextValue | null = null
vi.mock("@/components/providers/update-provider", () => ({
  useAppUpdate: () => ctx,
}))

const openUrl = vi.fn()
vi.mock("@/lib/platform", () => ({ openUrl: (u: string) => openUrl(u) }))

// The popover pulls the markdown stack in lazily; keep the test off the ESM
// markdown pipeline (its rendering is the settings page's concern).
vi.mock("@/components/settings/release-notes", () => ({
  ReleaseNotes: ({
    notes,
    emptyLabel,
  }: {
    notes: string
    emptyLabel: string
  }) => <div data-testid="notes">{notes || emptyLabel}</div>,
}))

import { StatusBarUpdate } from "./status-bar-update"
import enMessages from "@/i18n/messages/en.json"

const startUpdate = vi.fn(async (_opts?: { mode?: "now" | "when_idle" }) => {})
const cancelUpdate = vi.fn(async () => {})
const restart = vi.fn(async () => {})
const dismissAvailable = vi.fn()

function makeCtx(overrides: Partial<UpdateContextValue>): UpdateContextValue {
  const state: AppUpdateState = overrides.state ?? { seq: 1, status: "idle" }
  return {
    target: "active",
    remoteName: null,
    capability: undefined,
    updatedTo: null,
    state,
    isUpdating:
      state.status === "downloading" ||
      state.status === "waiting_for_idle" ||
      state.status === "installing",
    restartCountdown: null,
    isRollingBack: false,
    isRestarting: false,
    hydrated: true,
    isBusy: false,
    available: null,
    currentVersion: "0.21.7",
    checking: false,
    checkError: null,
    lastCheckedAt: new Date("2026-07-24T10:00:00Z"),
    selfUpdateSupported: false,
    liveProgress: false,
    runtime: undefined,
    rollbackAvailable: false,
    selfUpdateBlocker: null,
    canInstallInPlace: true,
    dismissedVersion: null,
    checkNow: vi.fn(async () => {}),
    dismissAvailable,
    refreshLocalStatus: vi.fn(async () => {}),
    startUpdate,
    cancelUpdate,
    restart,
    rollback: vi.fn(async () => {}),
    ...overrides,
  }
}

function renderWith(overrides: Partial<UpdateContextValue>) {
  ctx = makeCtx(overrides)
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StatusBarUpdate />
    </NextIntlClientProvider>
  )
}

const RELEASE = { version: "0.21.9", body: "## Fixes", date: "2026-07-24" }

// What the server reports for an install directory it can't write.
const UNWRITABLE_BIN = {
  code: "permission_denied",
  message: "Update target is not writable: /usr/local/bin",
  detail: "Permission denied (os error 13)",
  i18n_key: "SystemSettings.updateErrors.permissionDenied",
  i18n_params: { path: "/usr/local/bin" },
}

beforeEach(() => {
  startUpdate.mockClear()
  cancelUpdate.mockClear()
  restart.mockClear()
  dismissAvailable.mockClear()
  openUrl.mockClear()
})

describe("StatusBarUpdate — trigger", () => {
  it("renders nothing when idle with no release on offer", () => {
    const { container } = renderWith({})
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing outside a provider", () => {
    ctx = null
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <StatusBarUpdate />
      </NextIntlClientProvider>
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("badges a newly available release", () => {
    renderWith({ available: RELEASE })
    expect(screen.getByRole("button", { name: /New v0\.21\.9/ })).toBeVisible()
  })

  it("keeps a dismissed release reachable as a muted, label-less icon", () => {
    // Hiding it outright would leave the settings page as the only way back to
    // a release waved away by mistake. The icon stops asking for attention
    // (no accent colour, no label) but still opens the panel.
    renderWith({ available: RELEASE, dismissedVersion: "0.21.9" })

    const trigger = screen.getByRole("button", { name: /New v0\.21\.9/ })
    expect(trigger).toBeVisible()
    // No visible label, and not accented.
    expect(trigger.textContent).toBe("")
    expect(trigger.className).not.toContain("text-primary")
  })

  it("accents the badge with its label while the release is undismissed", () => {
    renderWith({ available: RELEASE })
    const trigger = screen.getByRole("button", { name: /New v0\.21\.9/ })
    expect(trigger.textContent).toContain("New v0.21.9")
    expect(trigger.className).toContain("text-primary")
  })

  it("still shows a dismissed release once its download is staged", () => {
    // Dismissing hides the invitation, not an update the user then chose to
    // install — that one still needs its restart prompt.
    renderWith({
      available: RELEASE,
      dismissedVersion: "0.21.9",
      state: { seq: 4, status: "ready_to_restart", version: "0.21.9" },
    })
    expect(
      screen.getByRole("button", { name: /Restart to update/ })
    ).toBeVisible()
  })

  it("shows download percent while downloading", () => {
    renderWith({
      state: { seq: 2, status: "downloading", downloaded: 50, total: 200 },
    })
    expect(screen.getByRole("button", { name: /25%/ })).toBeVisible()
  })

  it("shows the restart countdown while relaunching", () => {
    renderWith({
      state: { seq: 6, status: "restarting" },
      restartCountdown: 3,
    })
    expect(
      screen.getByRole("button", { name: /Restarting in 3s/ })
    ).toBeVisible()
  })
})

describe("StatusBarUpdate — popover", () => {
  it("shows the version delta, notes and starts the in-place update", async () => {
    renderWith({ available: RELEASE })
    fireEvent.click(screen.getByRole("button", { name: /New v0\.21\.9/ }))

    expect(await screen.findByText("Update available")).toBeVisible()
    expect(screen.getByText("v0.21.7 → v0.21.9")).toBeVisible()
    await waitFor(() =>
      expect(screen.getByTestId("notes").textContent).toBe("## Fixes")
    )

    fireEvent.click(
      screen.getByRole("button", { name: /Upgrade to v0\.21\.9/ })
    )
    expect(startUpdate).toHaveBeenCalledTimes(1)
  })

  it("links to the release page when this client can't install in place", async () => {
    // Older remote server: driving the detached flow against it would hang on
    // its legacy blocking endpoint.
    renderWith({ available: RELEASE, canInstallInPlace: false })
    fireEvent.click(screen.getByRole("button", { name: /New v0\.21\.9/ }))

    const link = await screen.findByRole("button", {
      name: /View v0\.21\.9 release/,
    })
    fireEvent.click(link)
    expect(openUrl).toHaveBeenCalledWith(
      "https://github.com/Jonathan-Asher/codeg/releases/latest"
    )
    expect(startUpdate).not.toHaveBeenCalled()
  })

  it("relaunches from the staged-update prompt", async () => {
    renderWith({
      available: RELEASE,
      state: { seq: 4, status: "ready_to_restart", version: "0.21.9" },
    })
    fireEvent.click(screen.getByRole("button", { name: /Restart to update/ }))

    // Trigger and popover action share the label, so wait for the second one
    // to appear and click that.
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /Restart to update/ })
      ).toHaveLength(2)
    )
    const actions = screen.getAllByRole("button", { name: /Restart to update/ })
    fireEvent.click(actions[actions.length - 1])
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it("still offers the upgrade after a dismissal, without the Later button", async () => {
    // The muted icon must not be a dead end: the action survives, only the
    // nagging goes away — and "Later" is pointless once already dismissed.
    renderWith({ available: RELEASE, dismissedVersion: "0.21.9" })
    fireEvent.click(screen.getByRole("button", { name: /New v0\.21\.9/ }))

    expect(
      await screen.findByRole("button", { name: /Upgrade to v0\.21\.9/ })
    ).toBeVisible()
    expect(screen.getByText("Update available")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Later" })).toBeNull()
  })

  it("dismisses the release and closes", async () => {
    renderWith({ available: RELEASE })
    fireEvent.click(screen.getByRole("button", { name: /New v0\.21\.9/ }))

    fireEvent.click(await screen.findByRole("button", { name: "Later" }))
    expect(dismissAvailable).toHaveBeenCalledTimes(1)
  })

  it("explains a failed install and offers a retry", async () => {
    renderWith({
      available: RELEASE,
      state: {
        seq: 7,
        status: "error",
        error: "error sending request for url",
      },
    })
    fireEvent.click(screen.getByRole("button", { name: /New v0\.21\.9/ }))

    expect(await screen.findByText(/Check your network or proxy/)).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(startUpdate).toHaveBeenCalled()
  })

  it("offers the release page, and says why, when the server can't install in place", async () => {
    // A root-owned install run by an unprivileged service: the server reports
    // it up front, so the popover must not offer an upgrade certain to fail.
    renderWith({
      available: RELEASE,
      selfUpdateBlocker: UNWRITABLE_BIN,
      canInstallInPlace: false,
    })
    fireEvent.click(screen.getByRole("button", { name: /New v0\.21\.9/ }))

    expect(
      await screen.findByText(
        "Cannot write to /usr/local/bin, so updates can't be installed in place. Update manually with administrator privileges or check installation permissions."
      )
    ).toBeVisible()
    expect(
      screen.getByRole("button", { name: /View v0\.21\.9 release/ })
    ).toBeVisible()
    expect(screen.queryByRole("button", { name: /Upgrade to/ })).toBeNull()
  })

  it("names the directory once when the failed install hit that wall", async () => {
    renderWith({
      available: RELEASE,
      state: {
        seq: 7,
        status: "error",
        error: UNWRITABLE_BIN.message,
        errorInfo: UNWRITABLE_BIN,
      },
      selfUpdateBlocker: UNWRITABLE_BIN,
      canInstallInPlace: false,
    })
    fireEvent.click(screen.getByRole("button", { name: /New v0\.21\.9/ }))

    expect(
      await screen.findByText(
        /^Update error: Cannot write to \/usr\/local\/bin/
      )
    ).toBeVisible()
    // Not repeated as a separate hint, and no retry that would fail again.
    expect(
      screen.getAllByText(/Cannot write to \/usr\/local\/bin/)
    ).toHaveLength(1)
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
    expect(
      screen.getByRole("button", { name: /View v0\.21\.9 release/ })
    ).toBeVisible()
  })

  it("reports transferred bytes while downloading", async () => {
    renderWith({
      state: {
        seq: 2,
        status: "downloading",
        downloaded: 1024 * 1024,
        total: 4 * 1024 * 1024,
      },
    })
    fireEvent.click(screen.getByRole("button", { name: /25%/ }))
    expect(await screen.findByText("1.0 MB / 4.0 MB")).toBeVisible()
  })
})

// A remote-desktop window bound to a machine running the desktop app: its
// update asks first, can wait for idle, and restarts by itself.
describe("StatusBarUpdate — remote desktop app", () => {
  const remote = (overrides: Partial<UpdateContextValue>) =>
    renderWith({
      remoteName: "studio",
      capability: "desktop",
      ...overrides,
    })

  it("labels the remote's release and offers to update the remote", async () => {
    remote({ available: RELEASE })
    const trigger = screen.getByRole("button", {
      name: /Remote: studio · New v0\.21\.9/,
    })
    fireEvent.click(trigger)

    expect(await screen.findByText("Remote: studio")).toBeVisible()
    expect(screen.getByText("v0.21.7 → v0.21.9")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: /Update remote/ }))
    // No mode: the provider asks first (the confirm dialog).
    expect(startUpdate).toHaveBeenCalledWith()
  })

  it("shows download progress as updating the remote, and can cancel it", async () => {
    remote({
      state: {
        seq: 3,
        status: "downloading",
        downloaded: 42,
        total: 100,
        version: "0.21.9",
        mode: "when_idle",
      },
    })
    fireEvent.click(
      screen.getByRole("button", { name: "Updating remote… downloading 42%" })
    )
    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel update" })
    )
    expect(cancelUpdate).toHaveBeenCalledTimes(1)
  })

  it("lists the sessions a waiting update holds for, with update-now and cancel", async () => {
    remote({
      state: {
        seq: 5,
        status: "waiting_for_idle",
        version: "0.21.9",
        mode: "when_idle",
        quietSecs: 60,
        busySessions: [
          {
            conversationId: 1,
            title: "Fix the parser",
            agentType: "claude_code",
            reason: "working",
          },
          { conversationId: 2, title: "Review", reason: "needs_you" },
        ],
      },
    })
    fireEvent.click(
      screen.getByRole("button", { name: "Remote update waits for 2 sessions" })
    )

    expect(await screen.findByText("2 sessions are mid-turn")).toBeVisible()
    expect(screen.getByText("Fix the parser")).toBeVisible()
    expect(screen.getByText("Needs you")).toBeVisible()
    expect(screen.getByText("Working")).toBeVisible()

    fireEvent.click(screen.getByRole("button", { name: "Update now" }))
    expect(startUpdate).toHaveBeenCalledWith({ mode: "now" })
    fireEvent.click(screen.getByRole("button", { name: "Cancel update" }))
    expect(cancelUpdate).toHaveBeenCalledTimes(1)
  })

  it("counts down the quiet window once nothing is mid-turn", () => {
    remote({
      state: {
        seq: 6,
        status: "waiting_for_idle",
        busySessions: [],
        quietSecsLeft: 42,
        quietSecs: 60,
      },
    })
    expect(
      screen.getByRole("button", { name: "Remote update in 42s" })
    ).toBeVisible()
  })

  it("says the remote is restarting, then confirms the version it came back on", () => {
    const { unmount } = remote({
      state: { seq: 8, status: "restarting", version: "0.21.9" },
      isRestarting: true,
    })
    expect(
      screen.getByRole("button", { name: "Restarting remote…" })
    ).toBeVisible()
    unmount()

    remote({ currentVersion: "0.21.9", updatedTo: "0.21.9" })
    expect(
      screen.getByRole("button", { name: "Remote on v0.21.9" })
    ).toBeVisible()
  })

  it("explains why a remote that could not reconnect is offered as a link", async () => {
    remote({
      available: RELEASE,
      canInstallInPlace: false,
      selfUpdateBlocker: {
        code: "invalid_input",
        message: "A remote window can't update this app",
        i18n_key: "SystemSettings.updateErrors.remoteWontReconnect",
        i18n_params: {},
      },
    })
    fireEvent.click(
      screen.getByRole("button", { name: /Remote: studio · New v0\.21\.9/ })
    )
    expect(
      await screen.findByText(/couldn't reconnect after the restart/)
    ).toBeVisible()
    expect(screen.queryByRole("button", { name: /Update remote/ })).toBeNull()
  })
})

describe("StatusBarUpdate — this machine in a remote window", () => {
  it("labels the local app's release apart from the remote's", () => {
    const ua = vi
      .spyOn(navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")
    try {
      renderWith({ target: "local", available: RELEASE })
      expect(
        screen.getByRole("button", { name: /This Mac · New v0\.21\.9/ })
      ).toBeVisible()
    } finally {
      ua.mockRestore()
    }
  })
})
