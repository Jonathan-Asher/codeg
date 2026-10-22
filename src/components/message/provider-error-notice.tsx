"use client"

import { useState } from "react"
import { ChevronRightIcon, OctagonAlert } from "lucide-react"
import { useTranslations } from "next-intl"

import { BrowserLink } from "@/components/ui/browser-link"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/instant-collapsible"
import type { ProviderError } from "@/lib/provider-errors"
import { cn } from "@/lib/utils"

/**
 * A provider's refusal or error (see `lib/provider-errors`), told compactly:
 * one line saying who stopped and why, the provider's own link, and the raw
 * message folded under "Details" — never the message dumped as a reply.
 *
 * `scope` says who stopped: a sub-agent (on its Agent card) or the turn the
 * transcript shows (an API-error line in the main agent's reply).
 */
export function ProviderErrorNotice({
  error,
  scope,
  className,
}: {
  error: ProviderError
  scope: "subagent" | "turn"
  className?: string
}) {
  const t = useTranslations("Folder.chat.providerError")
  const [detailsOpen, setDetailsOpen] = useState(false)
  const reason = t(`reason.${error.kind}`)
  const title =
    scope === "subagent"
      ? t("subagentStopped", { reason })
      : t("turnStopped", { reason })
  return (
    <div
      data-provider-error={error.kind}
      className={cn(
        "rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs",
        className
      )}
    >
      <div className="flex items-start gap-2 font-medium text-destructive">
        <OctagonAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
        <span>{title}</span>
      </div>
      {error.link && (
        <div className="mt-1 ps-5.5 text-muted-foreground">
          {t("learnMore")}{" "}
          <BrowserLink
            href={error.link}
            className="break-all text-foreground underline underline-offset-2 hover:text-primary"
          >
            {error.link}
          </BrowserLink>
        </div>
      )}
      <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
        <CollapsibleTrigger className="mt-1 ms-5.5 flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground">
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-3 transition-transform",
              detailsOpen && "rotate-90"
            )}
          />
          {t("details")}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="mt-1.5 ms-5.5 whitespace-pre-wrap break-words rounded bg-background/60 p-2 font-mono text-3xs text-muted-foreground">
            {error.raw}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
