"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckCircle2, Copy, ExternalLink, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { toErrorMessage } from "@/lib/app-error"
import { openUrl } from "@/lib/platform"
import type {
  SignInFailure,
  SignInOutcome,
  SignInStart,
  SignInState,
} from "@/lib/types"
import { copyTextToClipboard } from "@/lib/utils"

/** How often a waiting sign-in is asked whether it finished by itself (a
 *  browser on the codeg host can complete it without a paste). */
const POLL_MS = 3_000

/**
 * A sign-in a CLI runs on the codeg host and the user finishes from wherever
 * they are: open the link, then paste back what the page shows (a code, or
 * the address the browser landed on). The host does the rest; this only ever
 * sees the link and a verdict.
 */
export interface PasteSignInFlow {
  start: () => Promise<SignInStart>
  finish: (handle: string, pasted: string) => Promise<SignInOutcome>
  state: (handle: string) => Promise<SignInState>
  cancel: (handle: string) => Promise<void>
}

type Phase =
  | { kind: "starting" }
  | { kind: "waiting"; start: SignInStart }
  | { kind: "finishing"; start: SignInStart }
  | { kind: "done" }
  | { kind: "error"; message: string }

export function PasteSignIn({
  flow,
  stepOpen,
  stepPaste,
  pastePlaceholder,
  onDone,
  onClose,
}: {
  flow: PasteSignInFlow
  /** "Open this link and sign in." */
  stepOpen: string
  /** "Paste the code the page shows." */
  stepPaste: string
  pastePlaceholder: string
  /** The sign-in succeeded. */
  onDone: () => void
  /** The user cancelled, or closed it after a failure. */
  onClose: () => void
}) {
  const t = useTranslations("PasteSignIn")
  const [phase, setPhase] = useState<Phase>({ kind: "starting" })
  const [pasted, setPasted] = useState("")
  const [failure, setFailure] = useState<SignInFailure | null>(null)
  // The handle of the sign-in this view still owns; cleared once it is over,
  // so unmounting doesn't cancel a finished one.
  const handleRef = useRef<string | null>(null)
  // A paste is being answered: a poll that lands meanwhile has nothing to say.
  const answeringRef = useRef(false)
  const doneRef = useRef(onDone)
  useEffect(() => {
    doneRef.current = onDone
  })

  // No state is set before the first await: this also runs from the mount
  // effect, and "starting" is where the view begins.
  const run = useCallback(async () => {
    try {
      const start = await flow.start()
      handleRef.current = start.handle
      setPhase({ kind: "waiting", start })
    } catch (err) {
      setPhase({ kind: "error", message: toErrorMessage(err) })
    }
  }, [flow])

  const begin = useCallback(() => {
    setPhase({ kind: "starting" })
    setFailure(null)
    setPasted("")
    void run()
  }, [run])

  useEffect(() => {
    void run()
    return () => {
      const handle = handleRef.current
      handleRef.current = null
      if (handle) void flow.cancel(handle).catch(() => {})
    }
    // Start once per mounted flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const succeed = useCallback(() => {
    handleRef.current = null
    setPhase({ kind: "done" })
    doneRef.current()
  }, [])

  // A sign-in can finish without a paste (the host's own browser reached its
  // callback); ask now and then while waiting.
  const waitingHandle = phase.kind === "waiting" ? phase.start.handle : null
  useEffect(() => {
    if (!waitingHandle) return
    const timer = setInterval(() => {
      void flow
        .state(waitingHandle)
        .then((state) => {
          if (answeringRef.current || handleRef.current !== waitingHandle)
            return
          if (state === "succeeded") succeed()
          else if (state === "failed" || state === "expired") {
            handleRef.current = null
            setFailure(state === "expired" ? "expired" : "rejected")
            setPhase({ kind: "error", message: "" })
          }
        })
        .catch(() => {})
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [flow, succeed, waitingHandle])

  const submit = useCallback(async () => {
    if (phase.kind !== "waiting" || !pasted.trim()) return
    const start = phase.start
    setPhase({ kind: "finishing", start })
    setFailure(null)
    answeringRef.current = true
    try {
      const outcome = await flow.finish(start.handle, pasted)
      if (outcome.ok) {
        succeed()
        return
      }
      setFailure(outcome.reason ?? "failed")
      if (outcome.retry) {
        setPhase({ kind: "waiting", start })
      } else {
        handleRef.current = null
        setPhase({ kind: "error", message: "" })
      }
    } catch (err) {
      handleRef.current = null
      setPhase({ kind: "error", message: toErrorMessage(err) })
    } finally {
      answeringRef.current = false
    }
  }, [flow, pasted, phase, succeed])

  const cancel = useCallback(() => {
    const handle = handleRef.current
    handleRef.current = null
    if (handle) void flow.cancel(handle).catch(() => {})
    onClose()
  }, [flow, onClose])

  const failureText = failure ? t(`failure.${failure}`) : null

  if (phase.kind === "starting") {
    return (
      <div
        data-slot="sign-in-starting"
        className="flex items-center gap-2 text-xs text-muted-foreground"
      >
        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        {t("starting")}
      </div>
    )
  }

  if (phase.kind === "done") {
    return (
      <div
        data-slot="sign-in-done"
        className="flex items-center gap-1.5 text-xs text-green-600"
      >
        <CheckCircle2 className="size-3" aria-hidden="true" />
        {t("done")}
      </div>
    )
  }

  if (phase.kind === "error") {
    return (
      <div data-slot="sign-in-error" className="min-w-0 space-y-2">
        <p role="alert" className="text-xs text-destructive">
          {failureText || phase.message || t("failure.failed")}
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={begin}>
            {t("tryAgain")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t("close")}
          </Button>
        </div>
      </div>
    )
  }

  const { start } = phase
  const busy = phase.kind === "finishing"
  return (
    <div
      data-slot="sign-in-waiting"
      className="min-w-0 space-y-3 rounded-md border p-3"
    >
      <div className="min-w-0 space-y-1.5">
        <p className="text-xs">{stepOpen}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => void openUrl(start.url)}
          >
            <ExternalLink className="size-3.5" aria-hidden="true" />
            {t("openLink")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="gap-1.5"
            onClick={async () => {
              if (await copyTextToClipboard(start.url)) {
                toast.success(t("linkCopied"))
              }
            }}
          >
            <Copy className="size-3.5" aria-hidden="true" />
            {t("copyLink")}
          </Button>
        </div>
        <p
          data-slot="sign-in-url"
          className="truncate font-mono text-[0.6875rem] text-muted-foreground"
          title={start.url}
        >
          {start.url}
        </p>
      </div>
      <div className="min-w-0 space-y-1.5">
        <label className="text-xs" htmlFor={`sign-in-paste-${start.handle}`}>
          {stepPaste}
        </label>
        <div className="flex gap-2">
          <Input
            id={`sign-in-paste-${start.handle}`}
            data-slot="sign-in-paste"
            value={pasted}
            autoComplete="off"
            spellCheck={false}
            placeholder={pastePlaceholder}
            disabled={busy}
            onChange={(e) => setPasted(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit()
            }}
            className="h-8 min-w-0 flex-1 font-mono text-xs"
          />
          <Button
            size="sm"
            disabled={busy || !pasted.trim()}
            onClick={() => void submit()}
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              t("submit")
            )}
          </Button>
        </div>
        {failureText && (
          <p role="alert" className="text-xs text-destructive">
            {failureText}
          </p>
        )}
      </div>
      <Button size="sm" variant="ghost" onClick={cancel} disabled={busy}>
        {t("cancel")}
      </Button>
    </div>
  )
}
