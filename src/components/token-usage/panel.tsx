import type { ComponentType, ReactNode } from "react"
import { cn } from "@/lib/utils"

/** One card of the Token Usage page: a titled section with an optional hint
 *  and a right-aligned slot for its own controls. */
export function Panel({
  title,
  hint,
  icon: Icon,
  actions,
  children,
  className,
}: {
  title: string
  hint?: string
  icon?: ComponentType<{ className?: string }>
  /** Right-aligned header slot — e.g. a segmented toggle. */
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    // flex-col so a child marked flex-1 (the heatmap) can absorb the extra
    // height a side-by-side grid row hands the card.
    <section
      className={cn(
        "flex flex-col rounded-xl border border-border bg-card p-4",
        className
      )}
    >
      <header className="mb-3 flex shrink-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-[0.8125rem] font-semibold">
            {Icon ? (
              <Icon
                className="size-3.5 text-muted-foreground"
                aria-hidden="true"
              />
            ) : null}
            {title}
          </h2>
          {hint ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {hint}
            </p>
          ) : null}
        </div>
        {actions}
      </header>
      {children}
    </section>
  )
}
