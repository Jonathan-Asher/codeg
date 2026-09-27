/**
 * Where a `<video>` element loads a workspace file from, per runtime.
 *
 * The backend mints a short-lived capability for one file
 * (`workspace_media_capability`); how the element reaches the bytes depends
 * on the window:
 *
 * - **web / server**: the server's own `/api/workspace_media/<token>/<name>`
 *   endpoint, which streams from disk with HTTP Range support.
 * - **local desktop**: the app's `codeg-media://` URI scheme reads the file.
 * - **remote-workspace desktop window**: the same URI scheme, addressed at the
 *   saved connection, forwards every Range request to the remote server's
 *   byte endpoint. The webview can't load the remote origin itself (an
 *   `http://` remote is mixed content in the desktop webview, and custom
 *   connection headers can't ride on a `<video src>`).
 *
 * MUST match `MEDIA_URI_SCHEME` / `parse_media_scheme_path` in
 * `src-tauri/src/workspace_media.rs`.
 */

export const MEDIA_URI_SCHEME = "codeg-media"

export interface WorkspaceMediaCapability {
  token: string
  /** Server-relative byte endpoint, e.g. `/api/workspace_media/<token>/a.mp4`. */
  url: string
  filename: string
  size: number
  contentType: string
  /** Idle lifetime; each request extends it. */
  expiresInSecs: number
}

/** Path (before `convertFileSrc` encodes it) the desktop URI scheme parses. */
export function mediaSchemePath(
  capability: Pick<WorkspaceMediaCapability, "token" | "filename">,
  remoteConnectionId: number | null
): string {
  const name = capability.filename.replace(/[\\/]/g, "_")
  return remoteConnectionId === null
    ? `local/${capability.token}/${name}`
    : `remote/${remoteConnectionId}/${capability.token}/${name}`
}

/** The `src` for a `<video>` element in the current runtime. */
export function resolveMediaSrc(
  capability: WorkspaceMediaCapability,
  env: {
    desktop: boolean
    remoteConnectionId: number | null
    serverBaseUrl: string
    /** Tauri's `convertFileSrc` (desktop only). */
    convertFileSrc?: (path: string, protocol: string) => string
  }
): string {
  if (env.desktop && env.convertFileSrc) {
    return env.convertFileSrc(
      mediaSchemePath(capability, env.remoteConnectionId),
      MEDIA_URI_SCHEME
    )
  }
  return `${env.serverBaseUrl.replace(/\/+$/, "")}${capability.url}`
}
