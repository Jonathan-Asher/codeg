"use client"

import { useTranslations } from "next-intl"
import { useAppUpdate } from "@/components/providers/update-provider"

/**
 * Which codeg builds a window runs on, as the update controllers read them
 * from the running processes (never from a cached check).
 *
 * A remote-desktop window involves two: this app, which draws the window, and
 * the remote codeg server it works against. Each has its own version, and the
 * update surfaces are about one of them at a time, so a single unlabelled
 * number is ambiguous there — it read as this app's version when it was the
 * server's. Everywhere else there is one build to speak of: a local window's
 * app is its own backend, and a browser runs the frontend its server serves.
 */
export interface RunningVersions {
  /** This app's own version: the desktop shell's in a remote window, the
   * window's backend's otherwise. */
  app: string | null
  /** The remote codeg server, in a remote-desktop window only. */
  server: { name: string; version: string | null } | null
}

export function useRunningVersions(): RunningVersions {
  const active = useAppUpdate("active")
  const local = useAppUpdate("local")
  if (active?.serverName != null) {
    return {
      // The local controller, mounted next to the remote's in a workspace
      // window, reads the same app; the settings window only has the remote's.
      app: active.appVersion ?? (local?.currentVersion || null),
      server: {
        name: active.serverName,
        version: active.currentVersion || null,
      },
    }
  }
  return {
    app: active?.currentVersion || local?.currentVersion || null,
    server: null,
  }
}

/** `v1.2.3`, or a dash while the version has not been read. */
export function formatVersion(version: string | null | undefined): string {
  return version ? `v${version}` : "—"
}

/**
 * The versions as one line — "This app: v… · Server <name>: v…" — for a
 * remote-desktop window; null anywhere else, where the caller's own
 * single-version line already says it without ambiguity.
 */
export function useRunningVersionsLine(): string | null {
  const t = useTranslations("SystemSettings")
  const versions = useRunningVersions()
  if (!versions.server) return null
  return t("runningVersions", {
    app: formatVersion(versions.app),
    name: versions.server.name,
    server: formatVersion(versions.server.version),
  })
}
