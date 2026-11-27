import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  type ReactNode,
  type Ref,
} from "react"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createTranslator, NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

// The same stand-ins as the picker's own suite: the model selector is a list.
vi.mock("@/hooks/use-appearance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-appearance")>()),
  useZoomLevel: () => ({ zoomLevel: 100, setZoomLevel: () => {} }),
}))

vi.mock("virtua", () => ({
  Virtualizer: forwardRef(function VirtualizerMock(
    props: { children?: ReactNode },
    ref: Ref<{ scrollToIndex: (i: number) => void }>
  ) {
    useImperativeHandle(ref, () => ({ scrollToIndex: vi.fn() }))
    return <>{props.children}</>
  }),
}))

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({
    children,
    onViewportRef,
  }: {
    children?: ReactNode
    onViewportRef?: (el: HTMLElement | null) => void
  }) => {
    useEffect(() => {
      onViewportRef?.(document.createElement("div"))
    }, [onViewportRef])
    return <div data-slot="scroll-area">{children}</div>
  },
}))

import enMessages from "@/i18n/messages/en.json"
import jaMessages from "@/i18n/messages/ja.json"
import { SessionSettingsPicker } from "./session-settings-picker"
import {
  localizeConfigOptions,
  type AgentVocabularyTranslator,
} from "@/lib/agent-label-vocabulary"
import { buildSessionSettings } from "@/lib/session-settings"
import type {
  SessionConfigOptionInfo,
  SessionConfigSelectOptionInfo,
} from "@/lib/types"

afterEach(() => cleanup())

function select(
  id: string,
  name: string,
  category: string,
  current: string,
  options: SessionConfigSelectOptionInfo[]
): SessionConfigOptionInfo {
  return {
    id,
    name,
    description: null,
    category,
    kind: { type: "select", current_value: current, options, groups: [] },
  }
}

const row = (
  value: string,
  name: string,
  description: string | null = null
): SessionConfigSelectOptionInfo => ({ value, name, description })

/** A Grok session's selectors as the backend emits them: Grok's model and
 *  effort, then the permission selector codeg builds (`acp::grok_permission`),
 *  whose base row is Ask or the mode the session was launched in. */
function grokOptions(
  mode: string,
  base = "default"
): SessionConfigOptionInfo[] {
  const baseRow =
    base === "default"
      ? row("default", "Ask", "Asks before edits and commands")
      : row(
          base,
          "Auto-approve edits",
          "Set at launch in Grok settings; fixed for this session"
        )
  return [
    select("model", "Model", "model", "grok-4.6", [
      row("grok-4.6", "Grok 4.6"),
      row("grok-4.5", "Grok 4.5"),
    ]),
    select("reasoning_effort", "Reasoning effort", "thought_level", "high", [
      row("low", "Low"),
      row("high", "High"),
    ]),
    {
      ...select("mode", "Mode", "mode", mode, [
        baseRow,
        row(
          "auto",
          "Auto",
          "Grok checks each call and asks only when it is unsure"
        ),
        row(
          "bypassPermissions",
          "Always approve",
          "Runs every tool call without asking; deny rules still apply"
        ),
      ]),
      description: "Session permission mode",
    },
  ]
}

type Messages = typeof enMessages

/** The composer's path: the agent's options, localised for Grok, as settings. */
function renderGrokPicker(
  options: SessionConfigOptionInfo[],
  { locale, messages }: { locale: "en" | "ja"; messages: Messages } = {
    locale: "en",
    messages: enMessages,
  }
) {
  const t = createTranslator({
    locale,
    messages,
    namespace: "AgentVocabulary",
  }) as AgentVocabularyTranslator
  const onChange = vi.fn()
  render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <SessionSettingsPicker
        agentType="grok"
        settings={buildSessionSettings({
          configOptions: localizeConfigOptions("grok", options, t),
          modes: [],
          currentModeId: null,
          modeTitle: messages.Folder.chat.messageInput.modeLabel,
        })}
        loadingLabel={null}
        onChange={onChange}
      />
    </NextIntlClientProvider>
  )
  const msgs = messages.Folder.chat.messageInput
  const trigger = screen.getByRole("button", {
    name: new RegExp(msgs.agentSettings),
  })
  return { onChange, trigger, msgs }
}

function summary(trigger: HTMLElement) {
  return trigger.querySelector('[data-slot="settings-summary"]')?.textContent
}

describe("SessionSettingsPicker — Grok's permission mode", () => {
  it("reads in the chip like Claude's mode, Ask left out as the baseline", () => {
    const ask = renderGrokPicker(grokOptions("default"))
    expect(summary(ask.trigger)).toBe("Grok 4.6/High")
    expect(ask.trigger).toHaveAccessibleName(
      `${ask.msgs.agentSettings}: Model Grok 4.6, Reasoning effort High, Mode Ask`
    )
    cleanup()
    const always = renderGrokPicker(grokOptions("bypassPermissions"))
    expect(summary(always.trigger)).toBe("Grok 4.6/High/Always approve")
  })

  it("switches the running session from the popover, in the user's language", async () => {
    const user = userEvent.setup()
    const { onChange, trigger, msgs } = renderGrokPicker(
      grokOptions("default"),
      {
        locale: "ja",
        messages: jaMessages as unknown as Messages,
      }
    )
    await user.click(trigger)
    const popover = await screen.findByRole("dialog", {
      name: msgs.agentSettings,
    })
    const group = within(popover).getByRole("group", { name: "モード" })
    expect(
      within(group)
        .getAllByRole("button")
        .map((b) => [b.textContent, b.getAttribute("aria-pressed")])
    ).toEqual([
      ["確認する", "true"],
      ["自動", "false"],
      ["常に許可", "false"],
    ])
    await user.click(within(group).getByRole("button", { name: "常に許可" }))
    expect(onChange).toHaveBeenCalledWith(
      { type: "config", configId: "mode" },
      "bypassPermissions"
    )
  })

  it("shows a mode the session was launched in as fixed, with Auto and Always approve on top", async () => {
    const user = userEvent.setup()
    const { onChange, trigger, msgs } = renderGrokPicker(
      grokOptions("acceptEdits", "acceptEdits")
    )
    expect(summary(trigger)).toBe("Grok 4.6/High/Auto-approve edits")
    await user.click(trigger)
    const popover = await screen.findByRole("dialog", {
      name: msgs.agentSettings,
    })
    const group = within(popover).getByRole("group", { name: "Mode" })
    expect(
      within(group)
        .getAllByRole("button")
        .map((b) => b.textContent)
    ).toEqual(["Auto-approve edits", "Auto", "Always approve"])
    expect(
      within(popover).getByText(
        "Set at launch in Grok settings; fixed for this session"
      )
    ).toBeInTheDocument()
    await user.click(within(group).getByRole("button", { name: "Auto" }))
    expect(onChange).toHaveBeenCalledWith(
      { type: "config", configId: "mode" },
      "auto"
    )
  })
})
