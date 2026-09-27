import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { FileWorkspaceTab } from "@/contexts/workspace-context"

vi.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/api", () => ({
  openWorkspaceMediaStream: vi.fn(),
  revokeWorkspaceMediaStream: vi.fn(),
  downloadWorkspaceFile: vi.fn(),
}))
vi.mock("@/lib/platform", () => ({
  isDesktop: vi.fn(),
  isLocalDesktop: vi.fn(),
  openPath: vi.fn(),
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
}))

import {
  downloadWorkspaceFile,
  openWorkspaceMediaStream,
  revokeWorkspaceMediaStream,
} from "@/lib/api"
import { isDesktop, isLocalDesktop, openPath } from "@/lib/platform"
import { VideoPreview } from "./video-preview"

const mockOpen = vi.mocked(openWorkspaceMediaStream)
const mockRevoke = vi.mocked(revokeWorkspaceMediaStream)
const mockDownload = vi.mocked(downloadWorkspaceFile)
const mockIsDesktop = vi.mocked(isDesktop)
const mockIsLocalDesktop = vi.mocked(isLocalDesktop)
const mockOpenPath = vi.mocked(openPath)

function videoTab(path: string): FileWorkspaceTab {
  const title = path.split("/").pop() ?? path
  return {
    id: `file:${path}`,
    kind: "file",
    title,
    path,
    language: "video",
    content: "",
    loading: false,
  } as unknown as FileWorkspaceTab
}

function minted(token: string) {
  return {
    token,
    url: `/api/workspace_media/${token}/clip.mp4`,
    filename: "clip.mp4",
    size: 5 * 1024 * 1024,
    contentType: "video/mp4",
    expiresInSecs: 900,
    src: `https://srv.example/api/workspace_media/${token}/clip.mp4`,
  }
}

function renderClip(path = "/w/clip.mp4") {
  const relPath = path.split("/").pop() ?? path
  return render(
    <VideoPreview tab={videoTab(path)} rootPath="/w" relPath={relPath} />
  )
}

function setMediaError(video: HTMLElement, code: number) {
  Object.defineProperty(video, "error", {
    configurable: true,
    value: { code, message: "" },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIsDesktop.mockReturnValue(false)
  mockIsLocalDesktop.mockReturnValue(false)
  mockRevoke.mockResolvedValue(undefined)
  mockOpenPath.mockResolvedValue(undefined)
  mockOpen.mockResolvedValue(minted("a".repeat(32)))
})
afterEach(() => cleanup())

describe("VideoPreview", () => {
  it("streams a playable video from its capability URL", async () => {
    renderClip()
    await waitFor(() => expect(mockOpen).toHaveBeenCalledWith("/w", "clip.mp4"))
    const video = await screen.findByLabelText("clip.mp4")
    expect(video.tagName).toBe("VIDEO")
    expect(video.getAttribute("src")).toBe(minted("a".repeat(32)).src)
    expect(video.hasAttribute("controls")).toBe(true)
    // Metadata only: a big file must not be fetched eagerly.
    expect(video.getAttribute("preload")).toBe("metadata")
    expect(screen.getByText("5.0 MB")).toBeTruthy()
  })

  it("goes straight to the notice for a format no browser plays", () => {
    renderClip("/w/old.avi")
    expect(screen.getByText("unsupportedTitle")).toBeTruthy()
    expect(mockOpen).not.toHaveBeenCalled()
    // The way out stays available.
    expect(screen.getByText("download")).toBeTruthy()
  })

  it("turns a decode / format error into the unsupported notice", async () => {
    renderClip("/w/clip.mkv")
    const video = await screen.findByLabelText("clip.mkv")
    setMediaError(video, 4)
    fireEvent.error(video)
    expect(await screen.findByText("unsupportedTitle")).toBeTruthy()
  })

  it("offers a retry after a network failure", async () => {
    renderClip()
    const video = await screen.findByLabelText("clip.mp4")
    setMediaError(video, 2)
    fireEvent.error(video)
    expect(await screen.findByText("loadFailed")).toBeTruthy()
    mockOpen.mockResolvedValueOnce(minted("b".repeat(32)))
    fireEvent.click(screen.getByText("retry"))
    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(2))
    const again = await screen.findByLabelText("clip.mp4")
    expect(again.getAttribute("src")).toContain("b".repeat(32))
  })

  it("re-mints silently when a playing stream's link lapses", async () => {
    renderClip()
    const video = await screen.findByLabelText("clip.mp4")
    fireEvent.loadedMetadata(video)
    mockOpen.mockResolvedValueOnce(minted("c".repeat(32)))
    setMediaError(video, 2)
    fireEvent.error(video)
    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(2))
    expect(screen.queryByText("loadFailed")).toBeNull()
    const again = await screen.findByLabelText("clip.mp4")
    expect(again.getAttribute("src")).toContain("c".repeat(32))
    // The lapsed capability is released.
    expect(mockRevoke).toHaveBeenCalledWith("a".repeat(32))
  })

  it("shows why minting failed", async () => {
    mockOpen.mockRejectedValue({
      code: "not_found",
      message: "File does not exist",
    })
    renderClip()
    expect(await screen.findByText("loadFailed")).toBeTruthy()
    expect(screen.getByText("File does not exist")).toBeTruthy()
  })

  it("revokes its capability when closed", async () => {
    const { unmount } = renderClip()
    await screen.findByLabelText("clip.mp4")
    unmount()
    expect(mockRevoke).toHaveBeenCalledWith("a".repeat(32))
  })

  it("local desktop: opens the file in its own app instead of downloading", async () => {
    mockIsDesktop.mockReturnValue(true)
    mockIsLocalDesktop.mockReturnValue(true)
    renderClip()
    await screen.findByLabelText("clip.mp4")
    expect(screen.queryByText("download")).toBeNull()
    fireEvent.click(screen.getByText("openExternally"))
    await waitFor(() =>
      expect(mockOpenPath).toHaveBeenCalledWith("/w/clip.mp4")
    )
  })

  it("remote workspace: downloads through the tracked transfer", async () => {
    mockIsDesktop.mockReturnValue(true)
    mockIsLocalDesktop.mockReturnValue(false)
    mockDownload.mockResolvedValue({ status: "done", reported: true })
    renderClip()
    await screen.findByLabelText("clip.mp4")
    // No "open in new tab" in the desktop webview.
    expect(screen.queryByText("openInNewTab")).toBeNull()
    fireEvent.click(screen.getByText("download"))
    await waitFor(() =>
      expect(mockDownload).toHaveBeenCalledWith("/w", "clip.mp4", "clip.mp4")
    )
  })
})
