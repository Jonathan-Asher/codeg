"use client"

/**
 * "When codeg starts, open": the local workspace, or one of the saved remote
 * workspaces — for someone who always works on another machine and wants a
 * launch to land there instead of in the local workspace.
 *
 * Desktop-only, but shown in remote workspace windows too: the preference
 * belongs to the app on THIS machine, whichever window edits it. That is also
 * why every call goes to the local shell (`@/lib/remote-workspace` uses
 * `getShellTransport()`), never through the window's own transport — in a
 * remote window that one reaches the server the window is bound to.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { MonitorCloud } from "lucide-react"
import { toast } from "sonner"

import { SettingsSection } from "@/components/shared/settings-section"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toErrorMessage } from "@/lib/app-error"
import { isDesktop } from "@/lib/platform"
import {
  getStartupWorkspaceSettings,
  listRemoteWorkspaceConnections,
  updateStartupWorkspaceSettings,
} from "@/lib/remote-workspace"
import type { RemoteWorkspaceConnection } from "@/lib/types"

/** The picker's value for "no remote workspace". Connection ids are numbers. */
const LOCAL = "local"

function toValue(remoteConnectionId: number | null): string {
  return remoteConnectionId === null ? LOCAL : String(remoteConnectionId)
}

function toRemoteConnectionId(value: string): number | null {
  return value === LOCAL ? null : Number(value)
}

export function StartupWorkspaceSettingsSection() {
  const t = useTranslations("StartupWorkspaceSettings")
  const supported = isDesktop()

  const [connections, setConnections] = useState<
    RemoteWorkspaceConnection[] | null
  >(null)
  const [value, setValue] = useState(LOCAL)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!supported) return
    let cancelled = false

    Promise.all([
      listRemoteWorkspaceConnections(),
      getStartupWorkspaceSettings(),
    ])
      .then(([list, settings]) => {
        if (cancelled) return
        setConnections(list)
        setValue(toValue(settings.remote_connection_id))
      })
      .catch((err) => {
        console.error("[Settings] load startup workspace failed:", err)
      })

    return () => {
      cancelled = true
    }
  }, [supported])

  const save = useCallback(
    async (next: string, prev: string) => {
      setSaving(true)
      try {
        const result = await updateStartupWorkspaceSettings({
          remote_connection_id: toRemoteConnectionId(next),
        })
        setValue(toValue(result.remote_connection_id))
      } catch (err) {
        setValue(prev)
        toast.error(t("saveFailed", { message: toErrorMessage(err) }))
      } finally {
        setSaving(false)
      }
    },
    [t]
  )

  // Hidden until both reads are in: the picker names the stored choice, and a
  // guessed one would invite the user to "confirm" a launch they never chose.
  if (!supported || connections === null) return null

  const empty = connections.length === 0
  // A connection deleted after the list was read would leave the trigger
  // blank; it opens the local workspace now, so say that.
  const selected = connections.some((c) => toValue(c.id) === value)
    ? value
    : LOCAL

  return (
    <SettingsSection
      icon={MonitorCloud}
      title={t("title")}
      description={empty ? t("noRemote") : t("description")}
      htmlFor="startup-workspace"
      control={
        <Select
          value={selected}
          disabled={saving || empty}
          onValueChange={(next) => {
            const prev = selected
            setValue(next)
            void save(next, prev)
          }}
        >
          <SelectTrigger
            id="startup-workspace"
            size="sm"
            className="w-52 bg-background text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value={LOCAL}>{t("local")}</SelectItem>
            {connections.map((connection) => (
              <SelectItem key={connection.id} value={toValue(connection.id)}>
                {connection.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  )
}
