import { describe, expect, it } from "vitest"

import {
  MEDIA_URI_SCHEME,
  mediaSchemePath,
  resolveMediaSrc,
  type WorkspaceMediaCapability,
} from "./workspace-media"

const capability: WorkspaceMediaCapability = {
  token: "0123456789abcdef0123456789abcdef",
  url: "/api/workspace_media/0123456789abcdef0123456789abcdef/clip%20one.mp4",
  filename: "clip one.mp4",
  size: 1234,
  contentType: "video/mp4",
  expiresInSecs: 900,
}

// Mirrors Tauri's `convertFileSrc` on macOS/Linux.
const convertFileSrc = (path: string, protocol: string) =>
  `${protocol}://localhost/${encodeURIComponent(path)}`

describe("mediaSchemePath", () => {
  it("addresses a local capability", () => {
    expect(mediaSchemePath(capability, null)).toBe(
      `local/${capability.token}/clip one.mp4`
    )
  })

  it("addresses a capability on a saved remote connection", () => {
    expect(mediaSchemePath(capability, 7)).toBe(
      `remote/7/${capability.token}/clip one.mp4`
    )
  })

  it("never lets a file name add path segments", () => {
    expect(
      mediaSchemePath({ token: capability.token, filename: "a/../b.mp4" }, null)
    ).toBe(`local/${capability.token}/a_.._b.mp4`)
  })
})

describe("resolveMediaSrc", () => {
  it("web mode loads the server's range endpoint directly", () => {
    expect(
      resolveMediaSrc(capability, {
        desktop: false,
        remoteConnectionId: null,
        serverBaseUrl: "https://box.example/",
      })
    ).toBe(`https://box.example${capability.url}`)
  })

  it("local desktop goes through the codeg-media scheme", () => {
    const src = resolveMediaSrc(capability, {
      desktop: true,
      remoteConnectionId: null,
      serverBaseUrl: "tauri://localhost",
      convertFileSrc,
    })
    expect(src.startsWith(`${MEDIA_URI_SCHEME}://localhost/`)).toBe(true)
    expect(decodeURIComponent(src.split("localhost/")[1])).toBe(
      `local/${capability.token}/clip one.mp4`
    )
  })

  it("a remote-workspace window proxies through the scheme, not the remote origin", () => {
    const src = resolveMediaSrc(capability, {
      desktop: true,
      remoteConnectionId: 3,
      serverBaseUrl: "http://remote-box:3080",
      convertFileSrc,
    })
    expect(src).not.toContain("remote-box")
    expect(decodeURIComponent(src.split("localhost/")[1])).toBe(
      `remote/3/${capability.token}/clip one.mp4`
    )
    // The URL still ends in the real extension (players sniff it).
    expect(src.endsWith(".mp4")).toBe(true)
  })
})
