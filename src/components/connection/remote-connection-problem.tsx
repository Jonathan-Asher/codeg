"use client"

import { useRef, useState, type ReactNode } from "react"
import { Loader2, PlugZap, ShieldAlert } from "lucide-react"
import { useTranslations } from "next-intl"
import { RemoteWorkspaceManageDialog } from "@/components/layout/remote-workspace-manage-dialog"
import { Button } from "@/components/ui/button"
import { toErrorMessage } from "@/lib/app-error"
import { closeCurrentWindow } from "@/lib/platform"
import {
  getRemoteWorkspaceConnection,
  testRemoteWorkspaceConnection,
} from "@/lib/remote-workspace"
import type { RemoteWorkspaceConnection } from "@/lib/types"

interface RemoteConnectionProblemProps {
  /** The saved connection this window is bound to, when it could be read. */
  connection: RemoteWorkspaceConnection | null
  /** Set when the saved connection could not be read at all. */
  loadError: string | null
  /** Read the saved connection again (the `loadError` case). */
  onRetryLoad: () => void
}

/**
 * Full-window screen of a remote-workspace window that cannot carry on by
 * itself: the server rejected the window's access token, or the saved
 * connection could not be read. Every way out is a button — reconnect,
 * edit the connection (a new token, a moved server), or close the window.
 * A plain network drop never lands here: the connection dialog covers it,
 * and it recovers on its own.
 */
export function RemoteConnectionProblem({
  connection,
  loadError,
  onRetryLoad,
}: RemoteConnectionProblemProps) {
  const t = useTranslations("RemoteWorkspace")
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const editedRef = useRef(false)

  // Check that the server takes the saved details before reloading: a reload
  // into the same rejection would only come back to this screen. The
  // connection is read fresh, since it may have been edited since this
  // window opened — here or in another window.
  const reconnect = async () => {
    if (!connection) return
    setBusy(true)
    setProblem(null)
    try {
      const saved = await getRemoteWorkspaceConnection(connection.id)
      await testRemoteWorkspaceConnection({
        name: saved.name,
        baseUrl: saved.base_url,
        token: saved.token,
        headers: saved.headers,
      })
      window.location.reload()
    } catch (err) {
      setProblem(toErrorMessage(err))
      setBusy(false)
    }
  }

  const closeWindow = (
    <Button variant="ghost" onClick={() => void closeCurrentWindow()}>
      {t("closeWindow")}
    </Button>
  )

  if (loadError !== null) {
    return (
      <ProblemCard
        icon={<PlugZap className="h-5 w-5 text-muted-foreground" />}
        title={t("loadFailedTitle")}
        description={t("connectionLoadFailed", { message: loadError })}
      >
        {closeWindow}
        <Button onClick={onRetryLoad}>{t("tryAgain")}</Button>
      </ProblemCard>
    )
  }

  return (
    <>
      <ProblemCard
        icon={<ShieldAlert className="h-5 w-5 text-destructive" />}
        title={t("disconnectedTitle", { name: connection?.name ?? "" })}
        description={t("tokenRejected")}
        problem={
          problem ? t("stillCantConnect", { message: problem }) : undefined
        }
      >
        {closeWindow}
        {connection && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              editedRef.current = false
              setEditing(true)
            }}
          >
            {t("editConnection")}
          </Button>
        )}
        <Button disabled={busy || !connection} onClick={() => void reconnect()}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {busy ? t("reconnecting") : t("reconnect")}
        </Button>
      </ProblemCard>
      {connection && (
        <RemoteWorkspaceManageDialog
          open={editing}
          initialSelectedId={connection.id}
          onOpenChange={(open) => {
            setEditing(open)
            // Saved a change (a new token, most likely): reconnect with it as
            // soon as the editor closes.
            if (!open && editedRef.current) void reconnect()
          }}
          onChanged={() => {
            editedRef.current = true
          }}
        />
      )}
    </>
  )
}

function ProblemCard({
  icon,
  title,
  description,
  problem,
  children,
}: {
  icon: ReactNode
  title: string
  description: string
  problem?: string
  children: ReactNode
}) {
  return (
    <div className="flex h-screen items-center justify-center bg-background p-6">
      <div
        role="alert"
        className="w-full max-w-md rounded-xl border bg-card p-6 text-card-foreground shadow-sm"
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 shrink-0">{icon}</div>
          <div className="min-w-0 space-y-1.5">
            <h1 className="text-base font-semibold">{title}</h1>
            <p className="text-sm text-muted-foreground">{description}</p>
            {problem && (
              <p className="text-sm break-words text-destructive">{problem}</p>
            )}
          </div>
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">{children}</div>
      </div>
    </div>
  )
}
