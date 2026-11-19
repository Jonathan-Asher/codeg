import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  shellCall: vi.fn(),
  isDesktop: vi.fn(() => true),
  isRemoteDesktopMode: vi.fn(() => false),
}))

// The window's own transport (the remote server in a remote workspace
// window) and the local shell are told apart, as in the app.
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: mocks.call }),
  getShellTransport: () => ({ call: mocks.shellCall }),
  isDesktop: mocks.isDesktop,
  isRemoteDesktopMode: mocks.isRemoteDesktopMode,
}))

import {
  parsePendingDeepLink,
  resolveSessionLink,
  takePendingDeepLink,
  takePendingHarnessLink,
} from "./deep-link"

describe("takePendingDeepLink", () => {
  beforeEach(() => {
    mocks.call.mockReset()
    mocks.shellCall.mockReset()
    mocks.isDesktop.mockReturnValue(true)
    mocks.isRemoteDesktopMode.mockReturnValue(false)
  })

  it("returns the parked target, from the local shell", async () => {
    mocks.shellCall.mockResolvedValue({
      kind: "focus",
      folderId: 3,
      conversationId: 9,
      agent: "grok",
    })
    await expect(takePendingDeepLink()).resolves.toEqual({
      kind: "focus",
      folderId: 3,
      conversationId: 9,
      agent: "grok",
    })
    expect(mocks.shellCall).toHaveBeenCalledWith("take_pending_deep_link")
    expect(mocks.call).not.toHaveBeenCalled()
  })

  // The desktop app parks a link for a remote server in that server's window,
  // and the window claims it through the local shell — never its server.
  it("claims a remote workspace window's link through the local shell", async () => {
    mocks.isRemoteDesktopMode.mockReturnValue(true)
    mocks.shellCall.mockResolvedValue({
      kind: "session",
      sessionRef: "319",
      folderId: null,
      agent: null,
      serverName: "Johnnysclawd",
    })
    await expect(takePendingDeepLink()).resolves.toEqual({
      kind: "session",
      sessionRef: "319",
      folderId: null,
      agent: null,
      serverName: "Johnnysclawd",
    })
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it("returns null when nothing was parked", async () => {
    mocks.shellCall.mockResolvedValue(null)
    await expect(takePendingDeepLink()).resolves.toBeNull()
  })

  it("rejects a half-formed target rather than opening tab NaN", async () => {
    mocks.shellCall.mockResolvedValue({ folderId: 3, conversationId: 9 })
    await expect(takePendingDeepLink()).resolves.toBeNull()
  })

  // Browser-only mode has no OS scheme: it stays off the wire rather than
  // failing a call on every workspace mount.
  it("does not call the backend outside the desktop app", async () => {
    mocks.isDesktop.mockReturnValue(false)
    await expect(takePendingDeepLink()).resolves.toBeNull()
    expect(mocks.call).not.toHaveBeenCalled()
    expect(mocks.shellCall).not.toHaveBeenCalled()
  })

  it("swallows a transport failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.shellCall.mockRejectedValue(new Error("no such command"))
    await expect(takePendingDeepLink()).resolves.toBeNull()
  })
})

describe("parsePendingDeepLink", () => {
  it("reads a target with no kind as one, the shape before servers", () => {
    expect(
      parsePendingDeepLink({ folderId: 3, conversationId: 9, agent: "grok" })
    ).toEqual({ kind: "focus", folderId: 3, conversationId: 9, agent: "grok" })
  })

  it("reads a notice", () => {
    expect(
      parsePendingDeepLink({
        kind: "notice",
        reason: "unknown_server",
        server: "Elsewhere",
        sessionRef: "319",
      })
    ).toEqual({
      kind: "notice",
      reason: "unknown_server",
      server: "Elsewhere",
      sessionRef: "319",
    })
    expect(
      parsePendingDeepLink({ kind: "notice", reason: "not_found" })
    ).toEqual({
      kind: "notice",
      reason: "not_found",
      server: null,
      sessionRef: null,
    })
  })

  it.each([
    null,
    "focus",
    42,
    { kind: "focus", folderId: "3", conversationId: 9, agent: "grok" },
    { kind: "focus", folderId: 0, conversationId: 9, agent: "grok" },
    { kind: "focus", folderId: 3, conversationId: 9, agent: "" },
    { kind: "session", sessionRef: "  " },
    { kind: "session" },
    { kind: "notice", reason: "because" },
    { kind: "notice" },
    { kind: "harness", ref: "acme/pdf-tools" },
  ])("refuses %j", (raw) => {
    expect(parsePendingDeepLink(raw)).toBeNull()
  })

  it("keeps a session's optional folder and agent only when they are real", () => {
    expect(
      parsePendingDeepLink({
        kind: "session",
        sessionRef: "codex_thread",
        folderId: -1,
        agent: 7,
      })
    ).toEqual({
      kind: "session",
      sessionRef: "codex_thread",
      folderId: null,
      agent: null,
      serverName: "",
    })
  })
})

describe("resolveSessionLink", () => {
  beforeEach(() => {
    mocks.call.mockReset()
    mocks.shellCall.mockReset()
  })

  // Asked of the window's own server, which is where the session lives.
  it("asks this window's backend, and reads what it found", async () => {
    mocks.call.mockResolvedValue({
      folderId: 4,
      conversationId: 319,
      agent: "codex",
    })
    await expect(
      resolveSessionLink({ sessionRef: "319", folderId: 4 })
    ).resolves.toEqual({
      status: "found",
      target: { folderId: 4, conversationId: 319, agent: "codex" },
    })
    expect(mocks.call).toHaveBeenCalledWith("resolve_session_link", {
      sessionRef: "319",
      folderId: 4,
      agent: null,
    })
    expect(mocks.shellCall).not.toHaveBeenCalled()
  })

  it("is missing when the backend found nothing", async () => {
    mocks.call.mockResolvedValue(null)
    await expect(resolveSessionLink({ sessionRef: "1" })).resolves.toEqual({
      status: "missing",
    })
  })

  it("tells a server without the endpoint from one that failed", async () => {
    mocks.call.mockRejectedValue({
      code: "not_implemented",
      message: "API endpoint 'resolve_session_link' is not available",
    })
    await expect(resolveSessionLink({ sessionRef: "1" })).resolves.toEqual({
      status: "unsupported",
    })
    mocks.call.mockRejectedValue(new Error("offline"))
    await expect(resolveSessionLink({ sessionRef: "1" })).rejects.toThrow(
      "offline"
    )
  })
})

describe("takePendingHarnessLink", () => {
  beforeEach(() => {
    mocks.call.mockReset()
    mocks.isDesktop.mockReturnValue(true)
    mocks.isRemoteDesktopMode.mockReturnValue(false)
  })
  afterEach(() => vi.restoreAllMocks())

  it("returns the parked item address", async () => {
    mocks.call.mockResolvedValue("acme/pdf-tools")
    await expect(takePendingHarnessLink()).resolves.toBe("acme/pdf-tools")
    // Its own slot, and no arguments.
    expect(mocks.call).toHaveBeenCalledWith("take_pending_harness_link")
    expect(mocks.call).not.toHaveBeenCalledWith("take_pending_deep_link")
  })

  it("returns null when nothing was parked", async () => {
    mocks.call.mockResolvedValue(null)
    await expect(takePendingHarnessLink()).resolves.toBeNull()
  })

  // The backend validates it already; what reaches the Harness page is still
  // checked here.
  it.each([
    "acme",
    "../../other/name",
    "acme/pdf/extra",
    "https://spacering.net/harness/acme/pdf",
    "",
    42,
    { ref: "acme/pdf-tools" },
  ])("refuses %j, which is not an item address", async (value) => {
    mocks.call.mockResolvedValue(value)
    await expect(takePendingHarnessLink()).resolves.toBeNull()
  })

  // A link opens the item on this computer: a remote workspace window never
  // claims one, and browser-only mode has no OS scheme to claim from.
  it("does not call the backend outside a local desktop window", async () => {
    mocks.isDesktop.mockReturnValue(false)
    await expect(takePendingHarnessLink()).resolves.toBeNull()

    mocks.isDesktop.mockReturnValue(true)
    mocks.isRemoteDesktopMode.mockReturnValue(true)
    await expect(takePendingHarnessLink()).resolves.toBeNull()

    expect(mocks.call).not.toHaveBeenCalled()
  })

  // Until the desktop half has the command, Tauri answers with exactly this.
  it("takes a backend without the command for one with nothing parked, quietly", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {})
    mocks.call.mockRejectedValue("Command take_pending_harness_link not found")

    await expect(takePendingHarnessLink()).resolves.toBeNull()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledTimes(1)
  })

  it("swallows any other failure, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.call.mockRejectedValue(new Error("ipc closed"))
    await expect(takePendingHarnessLink()).resolves.toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
