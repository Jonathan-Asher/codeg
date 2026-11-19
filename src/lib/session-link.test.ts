import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  shellCall: vi.fn(),
  isDesktop: vi.fn(() => true),
  resolve: vi.fn(),
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: mocks.call }),
  getShellTransport: () => ({ call: mocks.shellCall }),
  isDesktop: mocks.isDesktop,
  onActiveTransportChange: () => () => {},
}))
vi.mock("@/lib/deep-link", () => ({
  resolveSessionLink: (args: unknown) => mocks.resolve(args),
}))

import {
  __setInstanceIdentityForTests,
  isOwnServer,
  loadInstanceIdentity,
  openSessionLink,
  parseSessionLink,
  sessionLinkUri,
} from "./session-link"

const BOX = { instanceId: "0123456789abcdef", name: "Johnnyss-MacBook-Pro" }
const MAC = { instanceId: "fedcba9876543210", name: "Jonathans-MacBook-Pro" }

describe("parseSessionLink", () => {
  it("reads the session and the server it names", () => {
    expect(
      parseSessionLink(`codeg://session/319?server=${BOX.instanceId}`)
    ).toEqual({ sessionRef: "319", server: BOX.instanceId })
    expect(parseSessionLink("codeg://session/319")).toEqual({
      sessionRef: "319",
      server: null,
    })
    expect(
      parseSessionLink("codeg:SESSION/codex_AbC/?utm=1&server=My+Box#top")
    ).toEqual({ sessionRef: "codex_AbC", server: "My Box" })
    expect(
      parseSessionLink("codeg://session/codex_abc%20123?server=My%20Box")
    ).toEqual({ sessionRef: "codex_abc 123", server: "My Box" })
    expect(parseSessionLink("codeg://session/7?server=")).toEqual({
      sessionRef: "7",
      server: null,
    })
  })

  it.each([
    "codeg://session/",
    "codeg://session/../etc/passwd",
    "codeg://session/a%2Fb",
    "codeg://agent/codex",
    "https://example.com/session/1",
    "codeg://session/7?server=box%07",
    `codeg://session/7?server=${"a".repeat(256)}`,
    `codeg://session/${"1".repeat(257)}`,
  ])("refuses %s", (uri) => {
    expect(parseSessionLink(uri)).toBeNull()
  })
})

describe("sessionLinkUri", () => {
  afterEach(() => __setInstanceIdentityForTests(null))

  it("names the server it is given, or none", () => {
    expect(sessionLinkUri(42, BOX.instanceId)).toBe(
      `codeg://session/42?server=${BOX.instanceId}`
    )
    expect(sessionLinkUri(42, "My Box")).toBe(
      "codeg://session/42?server=My%20Box"
    )
    expect(sessionLinkUri(42, null)).toBe("codeg://session/42")
    expect(sessionLinkUri(42, "  ")).toBe("codeg://session/42")
  })

  it("names this window's instance by default, once it is known", () => {
    expect(sessionLinkUri(42)).toBe("codeg://session/42")
    __setInstanceIdentityForTests(BOX)
    expect(sessionLinkUri(42)).toBe(
      `codeg://session/42?server=${BOX.instanceId}`
    )
    // And what is written reads back.
    expect(parseSessionLink(sessionLinkUri(42))).toEqual({
      sessionRef: "42",
      server: BOX.instanceId,
    })
  })
})

describe("loadInstanceIdentity", () => {
  beforeEach(() => {
    __setInstanceIdentityForTests(null)
    mocks.call.mockReset()
  })

  it("asks once, and remembers", async () => {
    mocks.call.mockResolvedValue(BOX)
    await expect(loadInstanceIdentity()).resolves.toEqual(BOX)
    await expect(loadInstanceIdentity()).resolves.toEqual(BOX)
    expect(mocks.call).toHaveBeenCalledTimes(1)
    expect(mocks.call).toHaveBeenCalledWith("get_instance_identity")
    expect(sessionLinkUri(1)).toBe(`codeg://session/1?server=${BOX.instanceId}`)
  })

  it("asks again after a failure, and takes silence for no identity", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {})
    mocks.call.mockRejectedValueOnce(new Error("offline"))
    await expect(loadInstanceIdentity()).resolves.toBeNull()
    mocks.call.mockResolvedValueOnce(null)
    await expect(loadInstanceIdentity()).resolves.toBeNull()
    expect(mocks.call).toHaveBeenCalledTimes(2)
    expect(sessionLinkUri(1)).toBe("codeg://session/1")
  })
})

describe("isOwnServer", () => {
  it("matches the id or the name, in any case", () => {
    expect(isOwnServer(BOX.instanceId, BOX)).toBe(true)
    expect(isOwnServer(BOX.instanceId.toUpperCase(), BOX)).toBe(true)
    expect(isOwnServer("johnnyss-macbook-pro", BOX)).toBe(true)
    expect(isOwnServer(MAC.instanceId, BOX)).toBe(false)
    expect(isOwnServer("Johnnysclawd", BOX)).toBe(false)
    expect(isOwnServer(BOX.instanceId, null)).toBe(false)
    expect(isOwnServer("", { instanceId: "x".repeat(16), name: "" })).toBe(
      false
    )
  })
})

describe("openSessionLink", () => {
  const deps = () => ({ openHere: vi.fn(), notify: vi.fn() })

  beforeEach(() => {
    mocks.call.mockReset()
    mocks.shellCall.mockReset()
    mocks.resolve.mockReset()
    mocks.isDesktop.mockReturnValue(true)
    __setInstanceIdentityForTests(null)
    // This window talks to the box.
    mocks.call.mockResolvedValue(BOX)
  })

  it("opens a link for this window's own server in place", async () => {
    mocks.resolve.mockResolvedValue({
      status: "found",
      target: { folderId: 4, conversationId: 319, agent: "codex" },
    })
    for (const uri of [
      `codeg://session/319?server=${BOX.instanceId}`,
      "codeg://session/319?server=Johnnyss-MacBook-Pro",
      // No server is this window's, as it always was.
      "codeg://session/319",
    ]) {
      const d = deps()
      await expect(openSessionLink(uri, d)).resolves.toBe("here")
      expect(d.openHere).toHaveBeenCalledWith({
        folderId: 4,
        conversationId: 319,
        agent: "codex",
      })
    }
    expect(mocks.resolve).toHaveBeenCalledWith({ sessionRef: "319" })
    expect(mocks.shellCall).not.toHaveBeenCalled()
  })

  it("hands a link for another server to the desktop app", async () => {
    mocks.shellCall.mockResolvedValue(undefined)
    const d = deps()
    const uri = `codeg://session/7?server=${MAC.instanceId}`
    await expect(openSessionLink(uri, d)).resolves.toBe("elsewhere")
    expect(mocks.shellCall).toHaveBeenCalledWith("open_deep_link", { url: uri })
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(d.openHere).not.toHaveBeenCalled()
  })

  // A server that does not say who it is cannot be told from another: the
  // desktop app, which knows the saved connections, decides.
  it("lets the desktop app decide when this server does not say who it is", async () => {
    mocks.call.mockResolvedValue(null)
    mocks.shellCall.mockResolvedValue(undefined)
    await expect(
      openSessionLink(`codeg://session/7?server=${BOX.instanceId}`, deps())
    ).resolves.toBe("elsewhere")
    expect(mocks.shellCall).toHaveBeenCalledTimes(1)
  })

  it("only says so in a browser, which has no other window to open", async () => {
    mocks.isDesktop.mockReturnValue(false)
    const d = deps()
    await expect(
      openSessionLink(`codeg://session/7?server=${MAC.instanceId}`, d)
    ).resolves.toBe("elsewhere")
    expect(d.notify).toHaveBeenCalledWith({
      key: "otherServer",
      values: { server: MAC.instanceId },
    })
    expect(mocks.shellCall).not.toHaveBeenCalled()
  })

  it("says why nothing opened here", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const missing = deps()
    mocks.resolve.mockResolvedValueOnce({ status: "missing" })
    await expect(openSessionLink("codeg://session/9", missing)).resolves.toBe(
      "missing"
    )
    expect(missing.notify).toHaveBeenCalledWith({
      key: "notFound",
      values: { session: "9" },
    })

    const failed = deps()
    mocks.resolve.mockRejectedValueOnce(new Error("offline"))
    await expect(openSessionLink("codeg://session/9", failed)).resolves.toBe(
      "failed"
    )
    expect(failed.notify).toHaveBeenCalledWith({
      key: "lookupFailedHere",
      values: { session: "9" },
    })

    const invalid = deps()
    await expect(openSessionLink("codeg://agent/codex", invalid)).resolves.toBe(
      "invalid"
    )
    expect(invalid.notify).not.toHaveBeenCalled()
  })
})
