import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Per-type upload caps: video and audio take the server's media cap (they are
 * linked by path, never inlined), everything else the 20 MiB file cap. The
 * web client reads the caps from `/api/upload_limits`; a desktop window on a
 * remote workspace proxies uploads as base64 and keeps 20 MiB for all.
 */

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  isDesktop: vi.fn(() => false),
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: mocks.call }),
  getShellTransport: () => ({ call: vi.fn() }),
  isDesktop: mocks.isDesktop,
  isRemoteDesktopMode: () => false,
  getActiveRemoteConnectionId: () => null,
  notifyRemoteDesktopUnauthorized: vi.fn(),
}))

const MiB = 1024 * 1024

/** A fresh `api` module, so its once-per-page limits cache starts empty. */
async function loadApi() {
  vi.resetModules()
  return import("@/lib/api")
}

const file = (name: string, type = "") => ({ name, type })

describe("upload limits", () => {
  beforeEach(() => {
    mocks.call.mockReset()
    mocks.isDesktop.mockReset()
    mocks.isDesktop.mockReturnValue(false)
  })

  it("recognises video and audio by type, then by extension", async () => {
    const { isLinkedMediaFile } = await loadApi()
    expect(isLinkedMediaFile(file("take.mp4", "video/mp4"))).toBe(true)
    expect(isLinkedMediaFile(file("x", "audio/mpeg"))).toBe(true)
    expect(isLinkedMediaFile(file("clip.MOV"))).toBe(true)
    expect(isLinkedMediaFile(file("memo.m4a"))).toBe(true)
    expect(isLinkedMediaFile(file("shot.png", "image/png"))).toBe(false)
    expect(isLinkedMediaFile(file("notes.txt", "text/plain"))).toBe(false)
    expect(isLinkedMediaFile(file(".mp4"))).toBe(false)
  })

  it("asks the server once and applies its media cap to video only", async () => {
    mocks.call.mockResolvedValue({
      maxFileBytes: 20 * MiB,
      maxMediaBytes: 1024 * MiB,
      maxTotalBytes: null,
      remainingTotalBytes: null,
    })
    const { getUploadLimits, uploadLimitFor } = await loadApi()
    const limits = await getUploadLimits()
    await getUploadLimits()
    expect(mocks.call).toHaveBeenCalledTimes(1)
    expect(mocks.call).toHaveBeenCalledWith("upload_limits")
    expect(uploadLimitFor(file("take.mp4", "video/mp4"), limits)).toBe(
      1024 * MiB
    )
    expect(uploadLimitFor(file("shot.png", "image/png"), limits)).toBe(20 * MiB)
  })

  it("keeps 20 MiB for everything when the server has no limits endpoint", async () => {
    mocks.call.mockRejectedValueOnce({ code: "not_found", message: "HTTP 404" })
    const { getUploadLimits, uploadLimitFor } = await loadApi()
    const limits = await getUploadLimits()
    expect(uploadLimitFor(file("take.mp4", "video/mp4"), limits)).toBe(20 * MiB)
    // A failed answer is not cached: the next upload asks again.
    mocks.call.mockResolvedValueOnce({
      maxFileBytes: 20 * MiB,
      maxMediaBytes: 500 * MiB,
    })
    const retried = await getUploadLimits()
    expect(retried.maxMediaBytes).toBe(500 * MiB)
  })

  it("keeps 20 MiB in a desktop window, whose uploads go through IPC", async () => {
    mocks.isDesktop.mockReturnValue(true)
    const { getUploadLimits } = await loadApi()
    const limits = await getUploadLimits()
    expect(limits.maxMediaBytes).toBe(20 * MiB)
    expect(mocks.call).not.toHaveBeenCalled()
  })
})

describe("statPaths", () => {
  it("sends the paths with their roots", async () => {
    mocks.call.mockReset().mockResolvedValue([])
    const { statPaths } = await loadApi()
    await statPaths(["/w/a.png"], ["/w"])
    expect(mocks.call).toHaveBeenCalledWith("stat_paths", {
      paths: ["/w/a.png"],
      rootPaths: ["/w"],
    })
  })
})
