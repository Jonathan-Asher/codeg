import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { DictationRefineSettingsView } from "@/lib/types"

const h = vi.hoisted(() => ({
  getDictationRefineSettings: vi.fn(),
  updateDictationRefineSettings: vi.fn(),
  refineDictation: vi.fn(),
}))
vi.mock("@/lib/api", () => h)
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import {
  DICTATION_TEST_SAMPLE,
  DictationRefineSettingsSection,
} from "./dictation-refine-settings"

const PROVIDERS: DictationRefineSettingsView["providers"] = [
  {
    id: "groq",
    label: "Groq",
    hasKey: true,
    defaultModel: "openai/gpt-oss-120b",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    hasKey: false,
    defaultModel: "gpt-oss-120b",
  },
  { id: "openai", label: "OpenAI", hasKey: false, defaultModel: "gpt-4o-mini" },
  {
    id: "anthropic",
    label: "Anthropic",
    hasKey: false,
    defaultModel: "claude-haiku-4-5-20251001",
  },
  {
    id: "google",
    label: "Google Cloud Translation",
    hasKey: false,
    defaultModel: null,
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    hasKey: false,
    defaultModel: null,
  },
]

const VIEW: DictationRefineSettingsView = {
  provider: "groq",
  model: "",
  endpoint: "",
  targetLanguage: "English",
  refine: true,
  translate: true,
  instructions: "Keep legal terms in Hebrew.",
  configured: true,
  providers: PROVIDERS,
  keyError: null,
}

const FORM = {
  provider: "groq",
  model: "",
  endpoint: "",
  targetLanguage: "English",
  refine: true,
  translate: true,
  instructions: "Keep legal terms in Hebrew.",
}

function renderSection() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <DictationRefineSettingsSection />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  h.getDictationRefineSettings.mockReset().mockResolvedValue(VIEW)
  h.updateDictationRefineSettings
    .mockReset()
    .mockImplementation(async (update: Record<string, unknown>) => {
      const { apiKey, ...settings } = update
      return {
        ...VIEW,
        ...settings,
        providers: PROVIDERS.map((p) =>
          p.id === settings.provider && typeof apiKey === "string"
            ? { ...p, hasKey: apiKey !== "" }
            : p
        ),
      }
    })
  h.refineDictation.mockReset().mockResolvedValue({
    text: "I need to send the document to the client by tomorrow morning.",
    provider: "groq",
    model: "openai/gpt-oss-120b",
    elapsedMs: 412,
  })
})

describe("DictationRefineSettingsSection", () => {
  it("shows the stored settings and that a key is saved, never the key", async () => {
    renderSection()
    expect(
      await screen.findByText("Dictation clean-up and translation")
    ).toBeTruthy()
    expect(screen.getByRole("combobox", { name: "Provider" }).textContent).toBe(
      "Groq"
    )
    expect(
      (screen.getByLabelText("Model") as HTMLInputElement).placeholder
    ).toBe("openai/gpt-oss-120b")
    const key = screen.getByLabelText("API key") as HTMLInputElement
    expect(key.type).toBe("password")
    expect(key.value).toBe("")
    expect(key.placeholder).toBe("Saved")
    expect(screen.getByText(/A key is saved/)).toBeTruthy()
    expect(
      (screen.getByLabelText("Target language") as HTMLInputElement).value
    ).toBe("English")
    expect(
      screen
        .getByRole("switch", { name: "Clean up" })
        .getAttribute("aria-checked")
    ).toBe("true")
    expect(screen.getByText("Ready")).toBeTruthy()
  })

  it("saves the form with a typed key, and keeps the key when none is typed", async () => {
    const user = userEvent.setup()
    renderSection()
    await user.type(await screen.findByLabelText("API key"), " gsk_new ")
    await user.click(screen.getByRole("switch", { name: "Translate" }))
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(h.updateDictationRefineSettings).toHaveBeenCalledWith({
        ...FORM,
        translate: false,
        apiKey: "gsk_new",
      })
    )
    // The typed key is cleared once stored.
    await waitFor(() =>
      expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(
        ""
      )
    )

    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(h.updateDictationRefineSettings).toHaveBeenCalledTimes(2)
    )
    expect(h.updateDictationRefineSettings.mock.calls[1][0]).not.toHaveProperty(
      "apiKey"
    )
  })

  it("removes the stored key", async () => {
    const user = userEvent.setup()
    renderSection()
    await user.click(await screen.findByRole("button", { name: /Remove key/ }))
    await waitFor(() =>
      expect(h.updateDictationRefineSettings).toHaveBeenCalledWith({
        ...FORM,
        apiKey: "",
      })
    )
  })

  it("switching provider resets the model and shows what that provider needs", async () => {
    const user = userEvent.setup()
    h.getDictationRefineSettings.mockResolvedValue({
      ...VIEW,
      model: "openai/gpt-oss-20b",
    })
    renderSection()
    await user.click(await screen.findByRole("combobox", { name: "Provider" }))
    await user.click(
      await screen.findByRole("option", { name: "Google Cloud Translation" })
    )
    expect(screen.queryByLabelText("Model")).toBeNull()
    expect(screen.getByText(/Google can only translate/)).toBeTruthy()
    expect(screen.getByText("No key saved for this provider yet.")).toBeTruthy()

    await user.click(screen.getByRole("combobox", { name: "Provider" }))
    await user.click(
      await screen.findByRole("option", { name: "Custom (OpenAI-compatible)" })
    )
    expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("")
    expect(screen.getByLabelText("Endpoint")).toBeTruthy()
    expect(screen.getByText(/Optional: a local server/)).toBeTruthy()
  })

  it("tests the saved settings on a Hebrew sample and shows the answer", async () => {
    const user = userEvent.setup()
    renderSection()
    await user.click(await screen.findByRole("button", { name: /Test/ }))
    await waitFor(() =>
      expect(h.refineDictation).toHaveBeenCalledWith({
        text: DICTATION_TEST_SAMPLE,
        sourceLanguage: "Hebrew",
      })
    )
    // Nothing unsaved, so nothing saved first.
    expect(h.updateDictationRefineSettings).not.toHaveBeenCalled()
    const status = await screen.findByRole("status")
    expect(status.textContent).toContain(
      "I need to send the document to the client by tomorrow morning."
    )
    expect(status.textContent).toContain("groq · openai/gpt-oss-120b · 412 ms")
  })

  it("saves unsaved edits before testing, and shows a failure", async () => {
    const user = userEvent.setup()
    h.refineDictation.mockRejectedValueOnce(
      new Error("Groq: the API key was rejected")
    )
    renderSection()
    await user.click(await screen.findByRole("switch", { name: "Clean up" }))
    await user.click(screen.getByRole("button", { name: /Test/ }))
    await waitFor(() =>
      expect(h.updateDictationRefineSettings).toHaveBeenCalledWith({
        ...FORM,
        refine: false,
      })
    )
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toBe(
      "Test failed: Groq: the API key was rejected"
    )
  })
})
