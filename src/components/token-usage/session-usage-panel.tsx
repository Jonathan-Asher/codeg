"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronRight } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { tokenUsageSessions } from "@/lib/api"
import { formatTokenCount } from "@/lib/token-format"
import { formatUsd } from "@/lib/token-usage"
import { cn } from "@/lib/utils"
import {
  TOKEN_USAGE_NO_ACCOUNT,
  type TokenUsageAccountItem,
  type TokenUsageAccountShare,
  type TokenUsageConversationItem,
  type TokenUsageFilter,
  type TokenUsageSessionItem,
  type TokenUsageSessionsReport,
  type TokenUsageSlice,
} from "@/lib/types"
import { Panel } from "./panel"

/** Per-viewer settings: kept in this browser only, read and written
 *  defensively (a private window or blocked storage just means defaults). */
export const SPLIT_STORAGE_KEY = "codeg.tokenUsage.accountSplit"
export const ACCOUNTS_OFF_STORAGE_KEY = "codeg.tokenUsage.accountsOff"

const SESSION_LIMIT = 8
/** While the server is still reading Claude transcripts, ask again this
 *  often, a bounded number of times. */
const INDEXING_POLL_MS = 4_000
const INDEXING_POLLS = 15
const ACCOUNT_SLOTS = 6

function readStored<T>(
  key: string,
  fallback: T,
  valid: (v: unknown) => v is T
): T {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw == null) return fallback
    const parsed: unknown = JSON.parse(raw)
    return valid(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

function writeStored(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage unavailable: the setting lasts until the page closes.
  }
}

const isBool = (v: unknown): v is boolean => typeof v === "boolean"
const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string")

/** `0.42%`, `<0.01%`, `12.3%` — a share of a weekly limit. */
export function formatPct(pct: number): string {
  if (!Number.isFinite(pct) || pct <= 0) return "0%"
  if (pct < 0.01) return "<0.01%"
  if (pct < 10) return `${pct.toFixed(2)}%`
  return `${pct.toFixed(1)}%`
}

/** Each account keeps one colour whatever is switched off or filtered:
 *  slots go by name, and the unmatched bucket is neutral. */
export function accountColors(
  accounts: TokenUsageAccountItem[]
): Map<string, string> {
  const names = accounts
    .map((a) => a.account)
    .filter((a) => a !== TOKEN_USAGE_NO_ACCOUNT)
    .sort((a, b) => a.localeCompare(b))
  const map = new Map<string, string>()
  names.forEach((name, i) =>
    map.set(
      name,
      i < ACCOUNT_SLOTS ? `var(--tu-acct-${i + 1})` : "var(--tu-acct-none)"
    )
  )
  map.set(TOKEN_USAGE_NO_ACCOUNT, "var(--tu-acct-none)")
  return map
}

function UsageFigures({
  usage,
  detail,
  className,
}: {
  usage: TokenUsageSlice
  detail: boolean
  className?: string
}) {
  const t = useTranslations("TokenUsage")
  return (
    <span
      className={cn(
        "flex shrink-0 items-baseline gap-3 font-mono text-xs tabular-nums",
        className
      )}
    >
      {detail && usage.pct != null && (
        <span className="text-muted-foreground" title={t("pctOfWeekHint")}>
          {formatPct(usage.pct)}
        </span>
      )}
      {detail && usage.cost_usd != null && (
        <span className="text-muted-foreground" title={t("usdListHint")}>
          {formatUsd(usage.cost_usd)}
        </span>
      )}
      <span>{formatTokenCount(usage.tokens)}</span>
    </span>
  )
}

/** One row's split across accounts: segments in the legend's order (so
 *  neighbours are always the validated colour pairs), sized by price, or by
 *  tokens where nothing is priced. */
function ShareBar({
  shares,
  order,
  colors,
  label,
}: {
  shares: TokenUsageAccountShare[]
  order: string[]
  colors: Map<string, string>
  label: (account: string) => string
}) {
  const t = useTranslations("TokenUsage")
  const byPrice = shares.some((s) => (s.usage.cost_usd ?? 0) > 0)
  const weight = (s: TokenUsageAccountShare) =>
    byPrice ? (s.usage.cost_usd ?? 0) : s.usage.tokens
  const total = shares.reduce((sum, s) => sum + weight(s), 0)
  if (total <= 0) return null
  const sorted = [...shares].sort(
    (a, b) => order.indexOf(a.account) - order.indexOf(b.account)
  )
  const describe = (s: TokenUsageAccountShare) => {
    const parts = [
      label(s.account),
      `${Math.round((weight(s) / total) * 100)}%`,
    ]
    if (s.usage.pct != null)
      parts.push(t("pctOfWeekShort", { pct: formatPct(s.usage.pct) }))
    if (s.usage.cost_usd != null) parts.push(formatUsd(s.usage.cost_usd))
    return parts.join(" · ")
  }
  return (
    <div
      role="img"
      aria-label={sorted.map(describe).join("; ")}
      className="mt-1.5 flex h-1.5 w-full gap-[2px] overflow-hidden rounded-full"
    >
      {sorted.map((s) =>
        weight(s) > 0 ? (
          <span
            key={s.account}
            data-account={s.account}
            title={describe(s)}
            className="h-full first:rounded-s-full last:rounded-e-full"
            style={{
              flexGrow: weight(s) / total,
              flexBasis: 0,
              backgroundColor: colors.get(s.account),
            }}
          />
        ) : null
      )}
    </div>
  )
}

export interface SessionUsagePanelProps {
  filter: TokenUsageFilter
  /** Bumped by the page to refetch under unchanged filters. */
  refreshTick: number
  /** The report's own list, shown when the server has no session route. */
  fallback: TokenUsageConversationItem[]
  agentLabel: (agentType: string) => string
  locale: string
}

/**
 * The biggest sessions of the window. Each Claude session expands into its
 * main thread and every sub-agent; with the account switch on, every row
 * shows how the pool's accounts shared it, and the account chips keep only
 * what chosen accounts served. Other agents show their total only.
 *
 * Fetched from whichever server the window is bound to, so a remote window
 * shows that server's sessions and that server's pool.
 */
export function SessionUsagePanel({
  filter,
  refreshTick,
  fallback,
  agentLabel,
  locale,
}: SessionUsagePanelProps) {
  const t = useTranslations("TokenUsage")
  const [split, setSplitState] = useState(() =>
    readStored(SPLIT_STORAGE_KEY, false, isBool)
  )
  const [off, setOffState] = useState<string[]>(() =>
    readStored(ACCOUNTS_OFF_STORAGE_KEY, [], isStringList)
  )
  const [data, setData] = useState<TokenUsageSessionsReport | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())
  const [poll, setPoll] = useState(0)
  const pollsRef = useRef(0)
  const reqRef = useRef(0)

  const setSplit = useCallback((next: boolean) => {
    setSplitState(next)
    writeStored(SPLIT_STORAGE_KEY, next)
  }, [])
  const toggleAccount = useCallback((account: string) => {
    setOffState((prev) => {
      const next = prev.includes(account)
        ? prev.filter((a) => a !== account)
        : [...prev, account]
      writeStored(ACCOUNTS_OFF_STORAGE_KEY, next)
      return next
    })
  }, [])

  // The legend's accounts, as a stable key: the "on" list sent to the
  // server is every known account that is not switched off.
  const legendKey = (data?.accounts ?? []).map((a) => a.account).join("\u0000")
  const selected = useMemo(() => {
    if (!split || off.length === 0 || legendKey === "") return null
    return legendKey.split("\u0000").filter((a) => !off.includes(a))
  }, [split, off, legendKey])
  const selectedKey = selected ? selected.join("\u0000") : null

  useEffect(() => {
    const id = ++reqRef.current
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = async () => {
      try {
        const next = await tokenUsageSessions({
          filter,
          accounts:
            selectedKey == null
              ? null
              : selectedKey.split("\u0000").filter(Boolean),
          limit: SESSION_LIMIT,
        })
        if (id !== reqRef.current) return
        setData(next)
        setUnavailable(false)
        if (next.indexing && pollsRef.current < INDEXING_POLLS) {
          pollsRef.current += 1
          timer = setTimeout(() => setPoll((n) => n + 1), INDEXING_POLL_MS)
        }
      } catch {
        if (id !== reqRef.current) return
        // An older server without the route: the report's own list.
        setUnavailable(true)
      }
    }
    void run()
    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [filter, refreshTick, selectedKey, poll])

  // A new window or filter starts the indexing polls afresh.
  useEffect(() => {
    pollsRef.current = 0
  }, [filter, refreshTick])

  const colors = useMemo(() => accountColors(data?.accounts ?? []), [data])
  const order = useMemo(() => {
    const names = (data?.accounts ?? [])
      .map((a) => a.account)
      .filter((a) => a !== TOKEN_USAGE_NO_ACCOUNT)
      .sort((a, b) => a.localeCompare(b))
    return [...names, TOKEN_USAGE_NO_ACCOUNT]
  }, [data])
  const accountLabel = useCallback(
    (account: string) =>
      account === TOKEN_USAGE_NO_ACCOUNT ? t("noPoolRecord") : account,
    [t]
  )

  const hasAccounts =
    !!data &&
    (data.pool.configured || data.accounts.some((a) => a.kind !== "none"))

  const toggleExpanded = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  if (unavailable) {
    return (
      <Panel title={t("topSessionsTitle")}>
        <FallbackList items={fallback} agentLabel={agentLabel} />
      </Panel>
    )
  }

  const sessions = data?.sessions ?? []
  const legend = [...(data?.accounts ?? [])].sort(
    (a, b) => order.indexOf(a.account) - order.indexOf(b.account)
  )

  return (
    <Panel
      title={t("topSessionsTitle")}
      hint={split && hasAccounts ? t("accountSplitHint") : undefined}
      actions={
        hasAccounts ? (
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            {t("accountSplitToggle")}
            <Switch
              checked={split}
              onCheckedChange={setSplit}
              aria-label={t("accountSplitToggle")}
            />
          </label>
        ) : undefined
      }
    >
      {split && hasAccounts && data && (
        <div className="mb-3 space-y-2 border-b border-border pb-3">
          <div
            className="flex flex-wrap gap-1.5"
            role="group"
            aria-label={t("accountChipsLabel")}
          >
            {legend.map((a) => {
              const on = !off.includes(a.account)
              const pool =
                a.kind === "none"
                  ? t("noPoolRecordHint")
                  : t("accountPoolTotal", {
                      pct: formatPct(a.pool_pct),
                      amount: formatUsd(a.pool_cost_usd),
                      calls: a.pool_calls.toLocaleString(locale),
                    })
              const rate =
                a.usd_per_pct != null
                  ? a.usd_per_pct_measured
                    ? t("usdPerPctMeasured", {
                        amount: formatUsd(a.usd_per_pct),
                      })
                    : t("usdPerPctBaseline", {
                        amount: formatUsd(a.usd_per_pct),
                      })
                  : null
              return (
                <button
                  key={a.account}
                  type="button"
                  aria-pressed={on}
                  data-account={a.account}
                  title={[pool, rate].filter(Boolean).join(" · ")}
                  onClick={() => toggleAccount(a.account)}
                  className={cn(
                    "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                    on
                      ? "border-border bg-muted/60 text-foreground"
                      : "border-dashed border-border text-muted-foreground opacity-60"
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-[2px]"
                    style={{
                      backgroundColor: on
                        ? colors.get(a.account)
                        : "transparent",
                      boxShadow: on
                        ? undefined
                        : `inset 0 0 0 1px ${colors.get(a.account)}`,
                    }}
                  />
                  <span className="truncate font-medium">
                    {accountLabel(a.account)}
                  </span>
                  <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                    {[
                      a.usage.pct != null ? formatPct(a.usage.pct) : null,
                      a.usage.cost_usd != null
                        ? formatUsd(a.usage.cost_usd)
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || formatTokenCount(a.usage.tokens)}
                  </span>
                </button>
              )
            })}
          </div>
          <PoolNote report={data} locale={locale} />
        </div>
      )}

      {data == null ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {t("loadingSessions")}
        </p>
      ) : sessions.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {t("topSessionsEmpty")}
        </p>
      ) : (
        <ol className="divide-y divide-border">
          {sessions.map((s, i) => (
            <SessionRow
              key={s.conversation_id}
              session={s}
              rank={i + 1}
              expanded={expanded.has(s.conversation_id)}
              onToggle={() => toggleExpanded(s.conversation_id)}
              split={split && hasAccounts}
              order={order}
              colors={colors}
              accountLabel={accountLabel}
              agentLabel={agentLabel}
            />
          ))}
        </ol>
      )}
      {data?.indexing && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("indexingSessions")}
        </p>
      )}
    </Panel>
  )
}

function PoolNote({
  report,
  locale,
}: {
  report: TokenUsageSessionsReport
  locale: string
}) {
  const t = useTranslations("TokenUsage")
  const { pool } = report
  const lines: string[] = [t("accountSplitNote")]
  if (!pool.configured) lines.push(t("poolNotConfigured"))
  else if (!pool.reachable && pool.error)
    lines.push(t("poolUnavailable", { reason: pool.error }))
  if (pool.records_since)
    lines.push(
      t("accountsSince", {
        date: new Date(pool.records_since).toLocaleString(locale, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }),
      })
    )
  return (
    <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
      {lines.join(" ")}
    </p>
  )
}

function SessionRow({
  session: s,
  rank,
  expanded,
  onToggle,
  split,
  order,
  colors,
  accountLabel,
  agentLabel,
}: {
  session: TokenUsageSessionItem
  rank: number
  expanded: boolean
  onToggle: () => void
  split: boolean
  order: string[]
  colors: Map<string, string>
  accountLabel: (account: string) => string
  agentLabel: (agentType: string) => string
}) {
  const t = useTranslations("TokenUsage")
  // Only a session that delegated has threads worth opening: a lone main
  // thread would just repeat the row.
  const subAgents = s.threads.filter((th) => !th.main).length
  const expandable = s.detail && subAgents > 0
  const threadsId = `tu-session-${s.conversation_id}-threads`
  return (
    <li className="py-2 first:pt-0 last:pb-0" data-session={s.conversation_id}>
      <div className="flex items-center gap-3">
        {expandable ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={threadsId}
            aria-label={t(expanded ? "collapseSession" : "expandSession", {
              title: s.title || t("untitledSession"),
            })}
            className="-m-1 shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronRight
              className={cn(
                "size-3.5 transition-transform",
                expanded && "rotate-90 rtl:-rotate-90"
              )}
              aria-hidden="true"
            />
          </button>
        ) : (
          <span className="w-3.5 shrink-0" aria-hidden="true" />
        )}
        <span
          aria-hidden="true"
          className="w-5 shrink-0 font-mono text-[0.625rem] tabular-nums text-muted-foreground/70"
        >
          {String(rank).padStart(2, "0")}
        </span>
        <span className="min-w-0 flex-1 truncate text-[0.8125rem]">
          {s.title || t("untitledSession")}
        </span>
        <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:block sm:max-w-[10rem]">
          {s.folder_label}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {agentLabel(s.agent_type)}
          {expandable ? ` · ${t("subAgentCount", { count: subAgents })}` : ""}
        </span>
        <UsageFigures usage={s.usage} detail={s.detail} />
      </div>
      {split && s.detail && (
        <div className="ps-[2.875rem]">
          <ShareBar
            shares={s.by_account}
            order={order}
            colors={colors}
            label={accountLabel}
          />
        </div>
      )}
      {expandable && expanded && (
        <ul
          id={threadsId}
          className="mt-2 space-y-1.5 border-s border-border ms-[1.1rem] ps-[1.6rem]"
        >
          {s.threads.map((th) => (
            <li key={th.key || "__main__"} data-thread={th.key || "main"}>
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-xs">
                  {th.main
                    ? t("mainThread")
                    : th.label ||
                      th.agent_type ||
                      t("subAgentFallback", { id: th.key.slice(0, 8) })}
                </span>
                {!th.main && th.agent_type && (
                  <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[0.625rem] leading-4 text-muted-foreground">
                    {th.agent_type}
                  </span>
                )}
                <UsageFigures usage={th.usage} detail />
              </div>
              {split && (
                <ShareBar
                  shares={th.by_account}
                  order={order}
                  colors={colors}
                  label={accountLabel}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

/** The list the page showed before the session route existed. */
function FallbackList({
  items,
  agentLabel,
}: {
  items: TokenUsageConversationItem[]
  agentLabel: (agentType: string) => string
}) {
  const t = useTranslations("TokenUsage")
  if (items.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        {t("topSessionsEmpty")}
      </p>
    )
  }
  return (
    <ol className="divide-y divide-border">
      {items.map((c, i) => (
        <li
          key={c.conversation_id}
          className="flex items-center gap-3 py-2 first:pt-0 last:pb-0"
        >
          <span
            aria-hidden="true"
            className="w-5 shrink-0 font-mono text-[0.625rem] tabular-nums text-muted-foreground/70"
          >
            {String(i + 1).padStart(2, "0")}
          </span>
          <span className="min-w-0 flex-1 truncate text-[0.8125rem]">
            {c.title || t("untitledSession")}
          </span>
          <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:block sm:max-w-[10rem]">
            {c.folder_label}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {agentLabel(c.agent_type)}
          </span>
          <span className="shrink-0 font-mono text-xs tabular-nums">
            {formatTokenCount(c.total_tokens)}
          </span>
        </li>
      ))}
    </ol>
  )
}
