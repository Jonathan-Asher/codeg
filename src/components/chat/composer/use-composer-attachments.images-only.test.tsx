import { act, renderHook, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { DragEvent as ReactDragEvent, ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

/**
 * The attachment hook in the images-only mode Quick Ask uses (a plain text
 * box, no editor for file badges): what a drop, a paste or an OS drop turns
 * into, on each transport.
 */

const h = vi.hoisted(() => ({
  desktop: false,
  remoteId: null as number | null,
  /** Tauri webview listeners by event name, as the hook registers them. */
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  uploadAttachment: vi.fn(),
  uploadLocalPathToRemote: vi.fn(),
  readFileBase64: vi.fn(),
  readLocalFileBase64: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  isDesktop: () => h.desktop,
  openFileDialog: vi.fn(),
}))
vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => h.remoteId,
}))
vi.mock("@/lib/api", () => ({
  isEmptyAttachmentError: () => false,
  readFileBase64: (...args: unknown[]) => h.readFileBase64(...args),
  uploadAttachment: (...args: unknown[]) => h.uploadAttachment(...args),
  uploadLocalPathToRemote: (...args: unknown[]) =>
    h.uploadLocalPathToRemote(...args),
  UPLOAD_I18N_KEY_NOT_A_FILE: "errors.upload.notAFile",
  UPLOAD_I18N_KEY_QUOTA_EXCEEDED: "errors.upload.quotaExceeded",
  UPLOAD_I18N_KEY_TOO_LARGE: "errors.upload.tooLarge",
  UPLOAD_MAX_BYTES: 20 * 1024 * 1024,
}))
vi.mock("@/lib/tauri", () => ({
  readFileBase64: (...args: unknown[]) => h.readLocalFileBase64(...args),
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
// jsdom lays nothing out, so every OS drop position "misses" the host; the
// hit test itself has its own tests.
vi.mock("@/components/chat/composer/attachment-files", async (orig) => ({
  ...(await orig<
    typeof import("@/components/chat/composer/attachment-files")
  >()),
  pointWithinElement: () => true,
}))
vi.mock("@tauri-apps/api/event", () => ({
  TauriEvent: {
    DRAG_ENTER: "tauri://drag-enter",
    DRAG_OVER: "tauri://drag-over",
    DRAG_DROP: "tauri://drag-drop",
    DRAG_LEAVE: "tauri://drag-leave",
  },
}))
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    listen: async (
      event: string,
      cb: (event: { payload: unknown }) => void
    ) => {
      h.listeners.set(event, cb)
      return () => h.listeners.delete(event)
    },
  }),
}))

import {
  useComposerAttachments,
  type UnattachableFiles,
} from "./use-composer-attachments"
import type { RichComposerHandle } from "./rich-composer"

const BUCKET = "quick-ask-0123456789abcdef0123456789abcdef"
const PNG_BASE64 = "iVBORw0KGgo="

function png(name = "square.png"): File {
  return new File(
    [Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0))],
    name,
    {
      type: "image/png",
    }
  )
}

function text(name = "notes.txt"): File {
  return new File(["hello"], name, { type: "text/plain" })
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {children}
    </NextIntlClientProvider>
  )
}

function setup(
  caps: { image: boolean; embedded_context: boolean } = {
    image: true,
    embedded_context: true,
  }
) {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const containerRef = { current: host }
  const editorRef = { current: null as RichComposerHandle | null }
  const onUnattachable = vi.fn<(event: UnattachableFiles) => void>()
  const hook = renderHook(
    () =>
      useComposerAttachments({
        editorRef,
        containerRef,
        promptCapabilities: caps,
        attachmentTabId: BUCKET,
        logLabel: "QuickAsk",
        onUnattachable,
      }),
    { wrapper }
  )
  return { ...hook, onUnattachable }
}

/** A browser drop event carrying `files`, as React hands it over. */
function dropEvent(files: File[]) {
  return {
    dataTransfer: { types: ["Files"], files },
    preventDefault: vi.fn(),
    clientX: 0,
    clientY: 0,
  } as unknown as ReactDragEvent<HTMLElement>
}

function fireTauri(event: string, payload: unknown) {
  const listener = h.listeners.get(event)
  if (!listener) throw new Error(`no listener for ${event}`)
  act(() => listener({ payload }))
}

describe("useComposerAttachments, images only", () => {
  beforeEach(() => {
    h.desktop = false
    h.remoteId = null
    h.listeners.clear()
    h.uploadAttachment
      .mockReset()
      .mockImplementation(async (file: File, bucket: string) => ({
        path: `/srv/uploads/${bucket}/${file.name}`,
        name: file.name,
        size: file.size,
        mimeType: file.type,
      }))
    h.uploadLocalPathToRemote
      .mockReset()
      .mockImplementation(async (path: string, bucket: string) => {
        const name = path.split("/").pop() ?? path
        return {
          path: `/srv/uploads/${bucket}/${name}`,
          name,
          size: 8,
          mimeType: "image/png",
        }
      })
    h.readFileBase64.mockReset().mockResolvedValue(PNG_BASE64)
    h.readLocalFileBase64.mockReset().mockResolvedValue(PNG_BASE64)
  })

  describe("browser drop and paste (web / remote)", () => {
    it("attaches a dropped image, uploaded into the question's bucket", async () => {
      const { result, onUnattachable } = setup()
      const file = png()
      await act(async () => {
        result.current.containerDragProps.onDrop(dropEvent([file]))
      })
      await waitFor(() =>
        expect(result.current.imageAttachments).toEqual([
          expect.objectContaining({
            name: "square.png",
            mimeType: "image/png",
            data: PNG_BASE64,
            uri: `file:///srv/uploads/${BUCKET}/square.png`,
            uploading: false,
          }),
        ])
      )
      expect(h.uploadAttachment).toHaveBeenCalledWith(file, BUCKET)
      expect(onUnattachable).not.toHaveBeenCalled()
      expect(result.current.hasUploadingImage).toBe(false)
    })

    it("turns other files away by name and uploads nothing for them", async () => {
      const { result, onUnattachable } = setup()
      await act(async () => {
        result.current.containerDragProps.onDrop(
          dropEvent([png(), text("notes.txt"), text("todo.md")])
        )
      })
      await waitFor(() =>
        expect(result.current.imageAttachments).toHaveLength(1)
      )
      expect(onUnattachable).toHaveBeenCalledWith({
        reason: "not_image",
        names: ["notes.txt", "todo.md"],
      })
      expect(h.uploadAttachment).toHaveBeenCalledTimes(1)
    })

    it("shows the drop overlay while files hover the window", () => {
      const { result } = setup()
      act(() => {
        result.current.containerDragProps.onDragOver({
          dataTransfer: { types: ["Files"], dropEffect: "none" },
          preventDefault: vi.fn(),
        } as unknown as ReactDragEvent<HTMLElement>)
      })
      expect(result.current.isDragActive).toBe(true)
      act(() => {
        result.current.containerDragProps.onDragLeave({
          relatedTarget: null,
          currentTarget: document.body,
        } as unknown as ReactDragEvent<HTMLElement>)
      })
      expect(result.current.isDragActive).toBe(false)
    })

    it("attaches a pasted screenshot", async () => {
      const { result } = setup()
      let consumed = false
      act(() => {
        consumed = result.current.handlePasteFiles({
          clipboardData: {
            files: [png("Screenshot.png")],
            items: [],
            getData: () => "",
          },
        } as unknown as ClipboardEvent)
      })
      expect(consumed).toBe(true)
      await waitFor(() =>
        expect(result.current.imageAttachments).toEqual([
          expect.objectContaining({
            name: "Screenshot.png",
            uri: `file:///srv/uploads/${BUCKET}/Screenshot.png`,
          }),
        ])
      )
    })

    it("leaves a text paste to the text box", () => {
      const { result } = setup()
      let consumed = true
      act(() => {
        consumed = result.current.handlePasteFiles({
          clipboardData: { files: [], items: [], getData: () => "hello" },
        } as unknown as ClipboardEvent)
      })
      expect(consumed).toBe(false)
      expect(result.current.imageAttachments).toEqual([])
    })

    it("reports images an agent cannot take instead of attaching them", async () => {
      const { result, onUnattachable } = setup({
        image: false,
        embedded_context: false,
      })
      await act(async () => {
        result.current.containerDragProps.onDrop(dropEvent([png()]))
      })
      expect(onUnattachable).toHaveBeenCalledWith({
        reason: "images_unsupported",
        names: ["square.png"],
      })
      expect(result.current.imageAttachments).toEqual([])
      expect(h.uploadAttachment).not.toHaveBeenCalled()
    })

    it("removes a staged image", async () => {
      const { result } = setup()
      await act(async () => {
        result.current.containerDragProps.onDrop(
          dropEvent([png("a.png"), png("b.png")])
        )
      })
      await waitFor(() =>
        expect(result.current.imageAttachments).toHaveLength(2)
      )
      const first = result.current.imageAttachments[0]
      act(() => result.current.removeAttachment(first.id))
      expect(result.current.imageAttachments.map((a) => a.name)).toEqual([
        "b.png",
      ])
    })
  })

  describe("OS drop on the desktop (Tauri drag-drop events)", () => {
    const position = { x: 40, y: 40 }

    it("attaches dropped image paths on a local desktop, inline", async () => {
      h.desktop = true
      const { result, onUnattachable } = setup()
      await waitFor(() => expect(h.listeners.size).toBe(4))

      fireTauri("tauri://drag-enter", {
        paths: ["/Users/me/square.png"],
        position,
      })
      expect(result.current.isDragActive).toBe(true)

      fireTauri("tauri://drag-drop", {
        paths: ["/Users/me/square.png", "/Users/me/notes.txt"],
        position,
      })
      expect(result.current.isDragActive).toBe(false)
      await waitFor(() =>
        expect(result.current.imageAttachments).toEqual([
          expect.objectContaining({
            name: "square.png",
            data: PNG_BASE64,
            uri: "file:///Users/me/square.png",
          }),
        ])
      )
      expect(h.readFileBase64).toHaveBeenCalledWith(
        "/Users/me/square.png",
        expect.any(Number)
      )
      expect(onUnattachable).toHaveBeenCalledWith({
        reason: "not_image",
        names: ["notes.txt"],
      })
      // A local agent reads the bytes inline: nothing is uploaded.
      expect(h.uploadLocalPathToRemote).not.toHaveBeenCalled()
    })

    it("uploads only the images to a remote workspace", async () => {
      h.desktop = true
      h.remoteId = 7
      const { result, onUnattachable } = setup()
      await waitFor(() => expect(h.listeners.size).toBe(4))

      fireTauri("tauri://drag-drop", {
        paths: ["/Users/me/square.png", "/Users/me/notes.txt"],
        position,
      })
      await waitFor(() =>
        expect(result.current.imageAttachments).toEqual([
          expect.objectContaining({
            name: "square.png",
            uri: `file:///srv/uploads/${BUCKET}/square.png`,
          }),
        ])
      )
      expect(h.uploadLocalPathToRemote).toHaveBeenCalledTimes(1)
      expect(h.uploadLocalPathToRemote).toHaveBeenCalledWith(
        "/Users/me/square.png",
        BUCKET
      )
      // The thumbnail is read from this machine, the agent reads the upload.
      expect(h.readLocalFileBase64).toHaveBeenCalledWith(
        "/Users/me/square.png",
        expect.any(Number)
      )
      expect(onUnattachable).toHaveBeenCalledWith({
        reason: "not_image",
        names: ["notes.txt"],
      })
    })

    it("explains a drop that carried no file", async () => {
      h.desktop = true
      const { result, onUnattachable } = setup()
      await waitFor(() => expect(h.listeners.size).toBe(4))
      fireTauri("tauri://drag-drop", { paths: [], position })
      expect(onUnattachable).toHaveBeenCalledWith({
        reason: "no_files",
        names: [],
      })
      expect(result.current.imageAttachments).toEqual([])
    })

    it("clears the overlay when the drag leaves", async () => {
      h.desktop = true
      const { result } = setup()
      await waitFor(() => expect(h.listeners.size).toBe(4))
      fireTauri("tauri://drag-enter", { paths: ["/a.png"], position })
      expect(result.current.isDragActive).toBe(true)
      fireTauri("tauri://drag-leave", {})
      expect(result.current.isDragActive).toBe(false)
    })
  })
})
