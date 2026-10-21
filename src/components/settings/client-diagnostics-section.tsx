"use client"

import { useCallback, useEffect, useState } from "react"
import { Copy, RefreshCw, Smartphone } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { getClientDiagnostic, listClientDiagnostics } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { ClientDiagnosticSummary } from "@/lib/types"
import { copyTextToClipboard } from "@/lib/utils"

/** What a report is about, in one line: the exception, or the signal. */
export function diagnosticHeadline(report: ClientDiagnosticSummary): string {
  const parts = [
    report.exceptionName,
    report.exceptionType && report.signal
      ? `${report.exceptionType} (${report.signal})`
      : (report.exceptionType ?? report.signal),
  ].filter((p): p is string => !!p)
  return parts.length > 0 ? parts.join(" · ") : report.kind
}

/**
 * Settings › Logs: the crash reports the iPhone app (Codeg Plus) sent to this
 * server — when, which build, what broke and the top frames, with the whole
 * report one click away for pasting into a bug.
 */
export function ClientDiagnosticsSection() {
  const t = useTranslations("LogsSettings")
  const [reports, setReports] = useState<ClientDiagnosticSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copying, setCopying] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setReports(await listClientDiagnostics(50))
      setError(null)
    } catch (err) {
      setError(toErrorMessage(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const copy = async (id: string) => {
    setCopying(id)
    try {
      const full = await getClientDiagnostic(id)
      const ok = await copyTextToClipboard(JSON.stringify(full, null, 2))
      if (ok) toast.success(t("crashReportCopied"))
      else toast.error(t("crashReportCopyFailed"))
    } catch (err) {
      toast.error(toErrorMessage(err))
    } finally {
      setCopying(null)
    }
  }

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <Smartphone className="h-3.5 w-3.5" />
            {t("crashReportsTitle")}
          </h2>
          <p className="text-xs leading-5 text-muted-foreground">
            {t("crashReportsDescription")}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("crashReportsRefresh")}
          onClick={() => void load()}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>
      {error ? (
        <p className="text-2xs text-destructive">{error}</p>
      ) : reports === null ? null : reports.length === 0 ? (
        <p className="text-2xs text-muted-foreground">
          {t("crashReportsEmpty")}
        </p>
      ) : (
        <div className="space-y-1.5">
          {reports.map((report) => (
            <div
              key={report.id}
              className="space-y-1 rounded-md border px-3 py-2"
              data-testid="client-diagnostic-row"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 space-y-0.5">
                  <div className="truncate text-xs font-medium">
                    {diagnosticHeadline(report)}
                  </div>
                  <div className="text-2xs text-muted-foreground">
                    {[
                      new Date(
                        report.occurredAt
                          ? Date.parse(report.occurredAt) || report.receivedAtMs
                          : report.receivedAtMs
                      ).toLocaleString(),
                      report.appVersion &&
                        `${report.appVersion}${report.appBuild ? ` (${report.appBuild})` : ""}`,
                      report.os,
                      report.kind,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={copying === report.id}
                  onClick={() => void copy(report.id)}
                >
                  <Copy className="h-3.5 w-3.5" />
                  {t("crashReportCopy")}
                </Button>
              </div>
              {report.reason && (
                <p className="break-words font-mono text-2xs text-muted-foreground">
                  {report.reason}
                </p>
              )}
              {report.topFrames.length > 0 && (
                <pre className="overflow-x-auto font-mono text-3xs leading-4 text-muted-foreground">
                  {report.topFrames.slice(0, 6).join("\n")}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
