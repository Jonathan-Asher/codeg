"use client"

import { create } from "zustand"
import { useTabStore } from "@/stores/tab-store"

/**
 * How long a run of next/previous-tab presses rests, with the step modifier
 * still held, before the tab it reached is switched to. Longer than the gap
 * between the presses of a fast run (60-100 ms), short enough to read as the
 * tab following the highlight.
 */
export const TAB_STEP_SETTLE_MS = 150

/** The latest a run's first press waits for its highlight to be painted
 *  before switching anyway (no frame comes while the window is hidden). */
const PAINT_FALLBACK_MS = 100

/** A key event's own time is trusted up to this far back; past that (or on
 *  another clock) the time it is handled stands in for it. */
const MAX_INPUT_DELAY_MS = 5000

interface TabStepState {
  /** The tab the next/previous-tab presses have reached and the strip
   *  highlights, ahead of the switch to it. Null when no step is pending. */
  previewTabId: string | null
}

/**
 * The next/previous-tab chords (Ctrl+Tab / Ctrl+Shift+Tab by default) step
 * through the conversation strip.
 *
 * Switching tabs is not cheap: the tab's view is shown and laid out, its
 * header, composer and side panels follow it, and it connects its agent. A
 * press that did all of that before the highlight moved fell behind a fast
 * run of presses, and the highlight trailed the keys. So a press moves only
 * the strip's highlight, which is painted at once, and the switch follows:
 *
 *   - after a single press (or the first of a run), as soon as the highlight
 *     is on screen;
 *   - inside a run (a press within {@link TAB_STEP_SETTLE_MS} of the last
 *     one), once the step modifier is released, the run has rested that long,
 *     or another key is pressed (a shortcut pressed next acts on the tab the
 *     run reached).
 *
 * A run's first press switches as a single press does, since it cannot know
 * more presses will follow; the tabs the rest of the run passes are never
 * activated: no view shown, no connect, no scroll restore, their attention
 * marks left alone. A tab chosen any other way, the pending tab closing, or a
 * pointer press (the click acts on what is on screen) drops the pending step.
 */
export const useTabStepStore = create<TabStepState>()(() => ({
  previewTabId: null,
}))

export interface TabStepperOptions {
  /** Make the tab the active one (the tab store's `switchTab`). */
  activate: (tabId: string) => void
  /** Whether the tab is still open. */
  hasTab: (tabId: string) => boolean
  /** Publish the pending step (null when none) for the strip. */
  setPreview: (tabId: string | null) => void
  settleMs?: number
  now?: () => number
  /** Run `fn` after `ms`; returns a function that cancels it. */
  schedule?: (fn: () => void, ms: number) => () => void
  /** Run `fn` once the frame showing the current changes has been painted;
   *  returns a function that cancels it. */
  afterPaint?: (fn: () => void) => () => void
  /** Run `fn` once the work the current task queued is done (the React
   *  render a store write schedules runs in a microtask). */
  afterWork?: (fn: () => void) => void
}

export interface TabStepper {
  /** One press: highlight `tabId`, and switch to it when the step settles.
   *  `pressedAt` is when the key went down (the event's `timeStamp`, on the
   *  `now` clock), when known. */
  step: (tabId: string, pressedAt?: number) => void
  /** Switch to the pending step's tab now. */
  settle: () => void
  /** Switch to the pending step's tab in a task of its own, soon. */
  settleSoon: () => void
  /** Drop the pending step without switching. */
  cancel: () => void
  /** Drop the pending step and forget the last one (tests). */
  reset: () => void
  previewTabId: () => string | null
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const handle = setTimeout(fn, ms)
  return () => clearTimeout(handle)
}

function defaultAfterPaint(fn: () => void): () => void {
  let done = false
  let painted: ReturnType<typeof setTimeout> | null = null
  const run = () => {
    if (done) return
    done = true
    cancel()
    fn()
  }
  // A task queued from the frame callback runs after that frame's rendering.
  const frame = requestAnimationFrame(() => {
    painted = setTimeout(run, 0)
  })
  const fallback = setTimeout(run, PAINT_FALLBACK_MS)
  function cancel() {
    cancelAnimationFrame(frame)
    if (painted != null) clearTimeout(painted)
    clearTimeout(fallback)
  }
  return () => {
    done = true
    cancel()
  }
}

/** The stepping logic, with its clock and timers injectable for tests. */
export function createTabStepper({
  activate,
  hasTab,
  setPreview,
  settleMs = TAB_STEP_SETTLE_MS,
  now = () => performance.now(),
  schedule = defaultSchedule,
  afterPaint = defaultAfterPaint,
  afterWork = (fn) => queueMicrotask(fn),
}: TabStepperOptions): TabStepper {
  let preview: string | null = null
  let cancelPending: (() => void) | null = null
  // When the last step's work was done, taken again once the work it queued
  // has run. A press is part of the run when its key went down less than the
  // settle time after that: on a slow machine a switch can keep the page busy
  // past the next press, which is then handled late but still belongs to the
  // run.
  let lastStepAt = Number.NEGATIVE_INFINITY

  const markStep = () => {
    lastStepAt = now()
    afterWork(() => {
      lastStepAt = now()
    })
  }
  const disarm = () => {
    cancelPending?.()
    cancelPending = null
  }
  const publish = (tabId: string | null) => {
    if (preview === tabId) return
    preview = tabId
    setPreview(tabId)
  }

  const settle = () => {
    disarm()
    const target = preview
    if (target == null) return
    // Cleared before the switch, in the same task: the strip renders once,
    // already on the switched-to tab, and the switch is not mistaken for one
    // made elsewhere.
    publish(null)
    if (hasTab(target)) activate(target)
    markStep()
  }

  return {
    step(tabId, pressedAt) {
      const handledAt = now()
      const at =
        pressedAt != null &&
        pressedAt <= handledAt &&
        handledAt - pressedAt < MAX_INPUT_DELAY_MS
          ? pressedAt
          : handledAt
      const inRun = preview != null || at - lastStepAt < settleMs
      publish(tabId)
      disarm()
      cancelPending = inRun ? schedule(settle, settleMs) : afterPaint(settle)
      markStep()
    },
    settle,
    settleSoon() {
      if (preview == null) return
      disarm()
      cancelPending = schedule(settle, 0)
    },
    cancel() {
      disarm()
      publish(null)
    },
    reset() {
      disarm()
      publish(null)
      lastStepAt = Number.NEGATIVE_INFINITY
    },
    previewTabId: () => preview,
  }
}

const MODIFIER_KEYS = new Set(["Control", "Meta", "Alt", "Shift", "AltGraph"])

let isStepKey: (event: KeyboardEvent) => boolean = (event) =>
  event.key === "Tab"
let detachPendingListeners: (() => void) | null = null
let watchingTabs = false

const stepper = createTabStepper({
  activate: (tabId) => useTabStore.getState().switchTab(tabId),
  hasTab: (tabId) =>
    useTabStore.getState().rawTabs.some((tab) => tab.id === tabId),
  setPreview: (tabId) => {
    useTabStepStore.setState({ previewTabId: tabId })
    if (tabId == null) {
      detachPendingListeners?.()
      detachPendingListeners = null
    } else if (!detachPendingListeners) {
      detachPendingListeners = attachPendingListeners()
    }
  },
})

/** Listened to only while a step is pending (see `useTabStepStore`). */
function attachPendingListeners(): () => void {
  if (typeof window === "undefined") return () => {}
  const onKeyDown = (event: KeyboardEvent) => {
    if (MODIFIER_KEYS.has(event.key) || isStepKey(event)) return
    // Before the key's own handlers, so they see the tab the run reached.
    stepper.settle()
  }
  const onKeyUp = (event: KeyboardEvent) => {
    if (!MODIFIER_KEYS.has(event.key)) return
    if (event.ctrlKey || event.metaKey || event.altKey) return
    // Out of the key event: the switch then paints before its effects run.
    stepper.settleSoon()
  }
  const onPointerDown = () => stepper.cancel()
  window.addEventListener("keydown", onKeyDown, true)
  window.addEventListener("keyup", onKeyUp, true)
  window.addEventListener("pointerdown", onPointerDown, true)
  return () => {
    window.removeEventListener("keydown", onKeyDown, true)
    window.removeEventListener("keyup", onKeyUp, true)
    window.removeEventListener("pointerdown", onPointerDown, true)
  }
}

/** A tab chosen any other way (a click, the sidebar, a shortcut, another
 *  window), or the pending tab closing, drops the pending step. */
function watchTabs() {
  if (watchingTabs) return
  watchingTabs = true
  useTabStore.subscribe((state, prev) => {
    const target = stepper.previewTabId()
    if (target == null) return
    if (
      state.activeTabId !== prev.activeTabId ||
      !state.rawTabs.some((tab) => tab.id === target)
    ) {
      stepper.cancel()
    }
  })
}

/**
 * Step to `tabId` from the keyboard (see {@link useTabStepStore}) for the
 * key `event`. `stepKey` tells the step chords' key events from the rest, so
 * a rebound chord keeps a run going.
 */
export function stepConversationTab(
  tabId: string,
  event?: KeyboardEvent,
  stepKey?: (event: KeyboardEvent) => boolean
): void {
  watchTabs()
  if (stepKey) isStepKey = stepKey
  stepper.step(tabId, event?.timeStamp)
}

/** The tab a step is pending for, if any. */
export function tabStepPreviewId(): string | null {
  return stepper.previewTabId()
}

/** Drop the pending step and forget the last one, so the next press is a
 *  single press again (tests). */
export function resetTabStep(): void {
  stepper.reset()
}
