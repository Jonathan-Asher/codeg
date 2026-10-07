/**
 * The button primitive must not ease `opacity`.
 *
 * `disabled` dims a button to half opacity, and a "Saving…" state turns the
 * same button disabled while it starts a spinning icon. Eased, that opacity
 * change runs on a layer the spinner then keeps composited, and WebKit — the
 * desktop app's engine — never repaints what the button showed before
 * underneath it: the editor's "Save & send" stayed visible through
 * "Continuing from here…", next to a second, stale Cancel.
 */
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { Button, buttonVariants } from "./button"

/** Whether a class list transitions `opacity` (unprefixed classes only). */
function easesOpacity(className: string): boolean {
  return className.split(/\s+/).some((name) => {
    if (["transition", "transition-all", "transition-opacity"].includes(name)) {
      return true
    }
    const list = /^transition-\[(.+)\]$/.exec(name)?.[1]
    return list !== undefined && /(^|,)(all|opacity)(,|$)/.test(list)
  })
}

const VARIANTS = [
  "default",
  "outline",
  "secondary",
  "ghost",
  "destructive",
  "link",
] as const
const SIZES = [
  "default",
  "xs",
  "sm",
  "lg",
  "icon",
  "icon-xs",
  "icon-sm",
  "icon-lg",
] as const

describe("Button", () => {
  it("dims when disabled without easing into it", () => {
    render(
      <Button type="button" disabled>
        Saving
      </Button>
    )
    const button = screen.getByRole("button", { name: "Saving" })
    expect(button.className).toContain("disabled:opacity-50")
    expect(easesOpacity(button.className)).toBe(false)
  })

  it("keeps opacity out of every variant's and size's transition", () => {
    for (const variant of VARIANTS) {
      for (const size of SIZES) {
        expect(
          easesOpacity(buttonVariants({ variant, size })),
          `${variant}/${size}`
        ).toBe(false)
      }
    }
  })

  it("still eases its colours", () => {
    expect(buttonVariants()).toMatch(
      /transition-\[[^\]]*background-color[^\]]*\]/
    )
  })
})
