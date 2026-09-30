/**
 * Whether `target` was focused the KEYBOARD way.
 *
 * Radix's hover-card trigger opens on ANY focus — `onFocus:
 * composeEventHandlers(props.onFocus, context.onOpen)` — and its `excludeTouch`
 * filter covers only pointer enter/leave, never focus. So on a touch device,
 * tapping a trigger (or a button inside one) focuses it, that focus reaches
 * the trigger, and the bubble opens a beat later with no pointer that could
 * ever leave and dismiss it. (Verified by A/B in headless Chrome with touch
 * emulation: without this guard the tap leaves the bubble stranded open.)
 *
 * Gating on `:focus-visible` keeps the keyboard path intact — tabbing onto the
 * trigger still opens it — while tap and mouse-click stay quiet; with a mouse the hover
 * path opens the bubble on its own anyway. Returning false lets the caller
 * default-prevent the event, which is what makes `composeEventHandlers` skip
 * Radix's own handler.
 *
 * The try/catch is for selector engines that reject the pseudo-class outright
 * rather than just never matching it; a throw reads as "not keyboard focus",
 * which is the quiet, tap-like default.
 */
export function isKeyboardFocus(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  try {
    return target.matches(":focus-visible")
  } catch {
    return false
  }
}
