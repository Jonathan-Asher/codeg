import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AppearanceProvider } from "./appearance-provider"
import {
  useChatTextScale,
  useCustomStyle,
  useSessionColumnWidth,
} from "@/hooks/use-appearance"
import {
  STORAGE_KEY_CUSTOM_THEME,
  STORAGE_KEY_ZOOM_LEVEL,
} from "@/lib/appearance-script"
import {
  CHAT_TEXT_SCALE_PROPERTY,
  CHAT_TEXT_SCALE_WILL_CHANGE_EVENT,
  STORAGE_KEY_CHAT_TEXT_SCALE,
} from "@/lib/chat-text-scale"
import { SHORTCUTS_STORAGE_KEY } from "@/lib/keyboard-shortcuts"
import {
  SESSION_COLUMN_MAX_WIDTH_PROPERTY,
  STORAGE_KEY_SESSION_COLUMN_WIDTH,
} from "@/lib/session-column-width"

function Probe() {
  const { setCustomThemeToken } = useCustomStyle()
  return (
    <>
      <button onClick={() => setCustomThemeToken("primary", "#bbbbbb")}>
        set-b
      </button>
      <button onClick={() => setCustomThemeToken("primary", "#aaaaaa")}>
        set-a
      </button>
    </>
  )
}

function renderProbe() {
  return render(
    <AppearanceProvider>
      <Probe />
    </AppearanceProvider>
  )
}

function storedPrimary(): string | undefined {
  const raw = localStorage.getItem(STORAGE_KEY_CUSTOM_THEME)
  return raw ? JSON.parse(raw).light?.primary : undefined
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute("style")
  document.documentElement.classList.remove("dark")
  localStorage.setItem(
    STORAGE_KEY_CUSTOM_THEME,
    JSON.stringify({ light: { primary: "#aaaaaa" }, dark: {} })
  )
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  document.documentElement.removeAttribute("style")
})

describe("debounced persistence", () => {
  it("does not resurrect a value that was reverted inside the debounce window", () => {
    // A → B → A，全程不超过防抖窗口，然后关窗触发 flush。此前 flush 会把已经被
    // 撤销的 B 写进去，重载后「撤销」凭空失效，还会经 storage 事件传染给其它窗口。
    renderProbe()
    expect(storedPrimary()).toBe("#aaaaaa")

    fireEvent.click(screen.getByText("set-b"))
    fireEvent.click(screen.getByText("set-a"))

    act(() => {
      window.dispatchEvent(new Event("pagehide"))
    })

    expect(storedPrimary()).toBe("#aaaaaa")
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
      "#aaaaaa"
    )
  })

  it("still flushes a genuinely pending edit when the window goes away", () => {
    // 反向对照：撤销的不写，没撤销的必须写 —— 否则「改完随手关窗」会静默丢修改。
    renderProbe()

    fireEvent.click(screen.getByText("set-b"))
    expect(storedPrimary()).toBe("#aaaaaa") // 还没到期，尚未落盘

    act(() => {
      window.dispatchEvent(new Event("pagehide"))
    })

    expect(storedPrimary()).toBe("#bbbbbb")
  })

  it("writes once the debounce elapses, without needing the flush", () => {
    renderProbe()

    fireEvent.click(screen.getByText("set-b"))
    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(storedPrimary()).toBe("#bbbbbb")
  })
})

describe("window zoom keys", () => {
  function startAt(zoom: number) {
    document.documentElement.style.fontSize = `${(16 * zoom) / 100}px`
  }

  function currentZoomPx(): string {
    return document.documentElement.style.fontSize
  }

  function keydown(
    key: string,
    init: KeyboardEventInit = {},
    target: EventTarget = window
  ) {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
        ...init,
      })
    )
  }

  /** Zoom writes reach Tauri IPC and an on-disk SQLite upsert on the same path. */
  function zoomWrites(spy: ReturnType<typeof vi.spyOn>): number {
    return spy.mock.calls.filter(([key]) => key === STORAGE_KEY_ZOOM_LEVEL)
      .length
  }

  function renderZoom() {
    render(
      <AppearanceProvider>
        <div data-terminal-panel-region="true">
          <span data-testid="terminal-child">term</span>
        </div>
      </AppearanceProvider>
    )
    return vi.spyOn(Storage.prototype, "setItem")
  }

  it("stops writing once a held zoom-out key hits the bottom of the range", () => {
    // 80% is the lowest rung, so every further repeat is a no-op on screen. It
    // used to persist and hit the DB once per repeat regardless.
    startAt(80)
    const setItem = renderZoom()

    act(() => {
      for (let i = 0; i < 5; i += 1) keydown("-", { repeat: i > 0 })
    })

    expect(zoomWrites(setItem)).toBe(0)
    expect(currentZoomPx()).toBe("12.8px")
  })

  it("never writes when reset is held at 100%", () => {
    // stepZoom clamping does not cover reset: it sets the default outright.
    startAt(100)
    const setItem = renderZoom()

    act(() => {
      for (let i = 0; i < 5; i += 1) keydown("0", { repeat: i > 0 })
    })

    expect(zoomWrites(setItem)).toBe(0)
    expect(currentZoomPx()).toBe("16px")
  })

  it("walks one rung per repeat without dropping a step", () => {
    // All three land in one act(), so no passive effect gets to run between
    // them. Reading the level from an effect-synced ref would step 100 → 110
    // three times over and lose two rungs.
    startAt(100)
    const setItem = renderZoom()

    act(() => {
      keydown("=")
      keydown("=", { repeat: true })
      keydown("=", { repeat: true })
    })

    expect(currentZoomPx()).toBe("24px") // 150%
    expect(zoomWrites(setItem)).toBe(3)
  })

  it("preventDefaults a repeat so the webview does not also page-zoom", () => {
    startAt(100)
    renderZoom()

    const held = new KeyboardEvent("keydown", {
      key: "=",
      ctrlKey: true,
      repeat: true,
      bubbles: true,
      cancelable: true,
    })
    act(() => {
      window.dispatchEvent(held)
    })

    expect(held.defaultPrevented).toBe(true)
  })

  it("declines Ctrl over the terminal but still zooms for Cmd", () => {
    // Ctrl+- and Ctrl+= mean something to the shell; Cmd+- does not, so macOS
    // keeps zooming over the terminal.
    startAt(100)
    const setItem = renderZoom()
    const terminalChild = screen.getByTestId("terminal-child")

    act(() => {
      keydown("=", {}, terminalChild)
    })
    expect(zoomWrites(setItem)).toBe(0)
    expect(currentZoomPx()).toBe("16px")

    act(() => {
      keydown("=", { ctrlKey: false, metaKey: true }, terminalChild)
    })
    expect(currentZoomPx()).toBe("17.6px") // 110%
  })

  it("reaches reset from the unshifted AZERTY zero key", () => {
    startAt(125)
    renderZoom()

    act(() => {
      keydown("à", { code: "Digit0" })
    })

    expect(currentZoomPx()).toBe("16px")
  })
})

describe("chat text size keys", () => {
  function scaleProperty(): string {
    return document.documentElement.style.getPropertyValue(
      CHAT_TEXT_SCALE_PROPERTY
    )
  }

  function keydown(
    key: string,
    init: KeyboardEventInit = {},
    target: EventTarget = window
  ) {
    const event = new KeyboardEvent("keydown", {
      key,
      metaKey: true,
      bubbles: true,
      cancelable: true,
      ...init,
    })
    target.dispatchEvent(event)
    return event
  }

  /** US layout: Shift+= reports "+", Shift+- "_", Shift+0 ")". */
  const enlarge = (init: KeyboardEventInit = {}) =>
    keydown("+", { shiftKey: true, code: "Equal", ...init })
  const shrink = () => keydown("_", { shiftKey: true, code: "Minus" })
  const reset = () => keydown(")", { shiftKey: true, code: "Digit0" })

  function NoticeProbe() {
    const { chatTextScale, chatTextScaleNotice } = useChatTextScale()
    return (
      <span data-testid="notice">
        {`${chatTextScale}:${chatTextScaleNotice?.level ?? "-"}:${chatTextScaleNotice?.seq ?? 0}`}
      </span>
    )
  }

  function renderChat() {
    render(
      <AppearanceProvider>
        <NoticeProbe />
        <div data-terminal-panel-region="true">
          <span data-testid="terminal-child">term</span>
        </div>
      </AppearanceProvider>
    )
  }

  it("enlarges the chat text and leaves the window zoom alone", () => {
    document.documentElement.style.fontSize = "16px"
    renderChat()

    let event!: KeyboardEvent
    act(() => {
      event = enlarge()
    })

    expect(event.defaultPrevented).toBe(true)
    expect(scaleProperty()).toBe("1.1")
    expect(localStorage.getItem(STORAGE_KEY_CHAT_TEXT_SCALE)).toBe("110")
    expect(document.documentElement.style.fontSize).toBe("16px")
    expect(localStorage.getItem(STORAGE_KEY_ZOOM_LEVEL)).toBeNull()
  })

  it("leaves Cmd+= to the window zoom", () => {
    document.documentElement.style.fontSize = "16px"
    renderChat()

    act(() => {
      keydown("=", { code: "Equal" })
    })

    expect(document.documentElement.style.fontSize).toBe("17.6px")
    expect(scaleProperty()).toBe("")
    expect(localStorage.getItem(STORAGE_KEY_CHAT_TEXT_SCALE)).toBeNull()
  })

  it("walks the rungs on a held key, shrinks and resets", () => {
    renderChat()

    act(() => {
      enlarge()
      enlarge({ repeat: true })
      enlarge({ repeat: true })
    })
    expect(scaleProperty()).toBe("1.5")

    act(() => {
      shrink()
    })
    expect(scaleProperty()).toBe("1.25")

    act(() => {
      reset()
    })
    expect(scaleProperty()).toBe("")
    expect(localStorage.getItem(STORAGE_KEY_CHAT_TEXT_SCALE)).toBe("100")
  })

  it("stops writing at the top rung but still announces the size", () => {
    localStorage.setItem(STORAGE_KEY_CHAT_TEXT_SCALE, "200")
    renderChat()
    const setItem = vi.spyOn(Storage.prototype, "setItem")

    act(() => {
      enlarge()
      enlarge({ repeat: true })
    })

    const writes = setItem.mock.calls.filter(
      ([key]) => key === STORAGE_KEY_CHAT_TEXT_SCALE
    )
    expect(writes).toHaveLength(0)
    expect(screen.getByTestId("notice").textContent).toBe("200:200:2")
    setItem.mockRestore()
  })

  it("announces only key presses, not changes from elsewhere", () => {
    renderChat()
    expect(screen.getByTestId("notice").textContent).toBe("100:-:0")

    act(() => {
      enlarge()
    })
    expect(screen.getByTestId("notice").textContent).toBe("110:110:1")

    act(() => {
      localStorage.setItem(STORAGE_KEY_CHAT_TEXT_SCALE, "150")
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: STORAGE_KEY_CHAT_TEXT_SCALE,
          newValue: "150",
        })
      )
    })
    expect(scaleProperty()).toBe("1.5")
    expect(screen.getByTestId("notice").textContent).toBe("150:110:1")
  })

  it("tells transcripts before it writes the new size", () => {
    renderChat()
    const seen: string[] = []
    const onWillChange = () => seen.push(scaleProperty())
    window.addEventListener(CHAT_TEXT_SCALE_WILL_CHANGE_EVENT, onWillChange)

    act(() => {
      enlarge()
      enlarge()
    })
    window.removeEventListener(CHAT_TEXT_SCALE_WILL_CHANGE_EVENT, onWillChange)

    // Each notice saw the size from before its own step.
    expect(seen).toEqual(["", "1.1"])
  })

  it("declines Ctrl over the terminal, where Ctrl+_ means undo", () => {
    renderChat()
    const terminalChild = screen.getByTestId("terminal-child")

    act(() => {
      keydown(
        "_",
        { metaKey: false, ctrlKey: true, shiftKey: true, code: "Minus" },
        terminalChild
      )
    })
    expect(localStorage.getItem(STORAGE_KEY_CHAT_TEXT_SCALE)).toBeNull()

    act(() => {
      keydown("+", { shiftKey: true, code: "Equal" }, terminalChild)
    })
    expect(scaleProperty()).toBe("1.1")
  })

  it("snaps a stored off-rung size on mount", () => {
    localStorage.setItem(STORAGE_KEY_CHAT_TEXT_SCALE, "130")
    renderChat()
    expect(scaleProperty()).toBe("1.25")
    expect(screen.getByTestId("notice").textContent).toBe("125:-:0")
  })
})

describe("session width", () => {
  function widthProperty(): string {
    return document.documentElement.style.getPropertyValue(
      SESSION_COLUMN_MAX_WIDTH_PROPERTY
    )
  }

  function WidthProbe() {
    const {
      sessionColumnWidth,
      setSessionColumnWidth,
      sessionColumnWidthNotice,
    } = useSessionColumnWidth()
    return (
      <>
        <span data-testid="width">
          {`${sessionColumnWidth}:${sessionColumnWidthNotice?.width ?? "-"}:${sessionColumnWidthNotice?.seq ?? 0}`}
        </span>
        <button onClick={() => setSessionColumnWidth("wide")}>wide</button>
        <button onClick={() => setSessionColumnWidth("standard")}>
          standard
        </button>
        <button onClick={() => setSessionColumnWidth(5000)}>huge</button>
        <button onClick={() => setSessionColumnWidth(1100)}>custom</button>
      </>
    )
  }

  function renderWidth() {
    render(
      <AppearanceProvider>
        <WidthProbe />
      </AppearanceProvider>
    )
  }

  const shown = () => screen.getByTestId("width").textContent

  it("starts at Standard and writes nothing", () => {
    renderWidth()
    expect(shown()).toBe("standard:-:0")
    expect(widthProperty()).toBe("")
    expect(localStorage.getItem(STORAGE_KEY_SESSION_COLUMN_WIDTH)).toBeNull()
  })

  it("applies and persists a preset, and removes the variable for Standard", () => {
    renderWidth()

    fireEvent.click(screen.getByText("wide"))
    expect(shown()).toBe("wide:-:0")
    expect(widthProperty()).toBe("64rem")
    expect(localStorage.getItem(STORAGE_KEY_SESSION_COLUMN_WIDTH)).toBe("wide")

    fireEvent.click(screen.getByText("standard"))
    expect(widthProperty()).toBe("")
    expect(localStorage.getItem(STORAGE_KEY_SESSION_COLUMN_WIDTH)).toBe(
      "standard"
    )
  })

  it("clamps a custom width and keeps one inside the range", () => {
    renderWidth()

    fireEvent.click(screen.getByText("huge"))
    expect(shown()).toBe("2560:-:0")
    expect(widthProperty()).toBe("160rem")

    fireEvent.click(screen.getByText("custom"))
    expect(widthProperty()).toBe("68.75rem")
    expect(localStorage.getItem(STORAGE_KEY_SESSION_COLUMN_WIDTH)).toBe("1100")
  })

  it("restores a stored width on mount", () => {
    localStorage.setItem(STORAGE_KEY_SESSION_COLUMN_WIDTH, "full")
    renderWidth()
    expect(shown()).toBe("full:-:0")
    expect(widthProperty()).toBe("calc(100% - 2rem)")
  })

  it("tells transcripts before it reflows them", () => {
    renderWidth()
    const seen: string[] = []
    const onWillChange = () => seen.push(widthProperty())
    window.addEventListener(CHAT_TEXT_SCALE_WILL_CHANGE_EVENT, onWillChange)

    fireEvent.click(screen.getByText("wide"))
    fireEvent.click(screen.getByText("wide"))
    window.removeEventListener(CHAT_TEXT_SCALE_WILL_CHANGE_EVENT, onWillChange)

    // Once, seeing the width from before; the repeat is a no-op.
    expect(seen).toEqual([""])
  })

  it("follows a change made in another window", () => {
    renderWidth()
    act(() => {
      localStorage.setItem(STORAGE_KEY_SESSION_COLUMN_WIDTH, "extra-wide")
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: STORAGE_KEY_SESSION_COLUMN_WIDTH,
          newValue: "extra-wide",
        })
      )
    })
    expect(shown()).toBe("extra-wide:-:0")
    expect(widthProperty()).toBe("80rem")

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: STORAGE_KEY_SESSION_COLUMN_WIDTH,
          newValue: null,
        })
      )
    })
    expect(shown()).toBe("standard:-:0")
    expect(widthProperty()).toBe("")
  })

  function cycle() {
    const event = new KeyboardEvent("keydown", {
      key: "y",
      code: "KeyY",
      metaKey: true,
      altKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    window.dispatchEvent(event)
    return event
  }

  it("has no cycle key until one is assigned", () => {
    renderWidth()
    let event!: KeyboardEvent
    act(() => {
      event = cycle()
    })
    expect(event.defaultPrevented).toBe(false)
    expect(shown()).toBe("standard:-:0")
  })

  it("cycles the presets on an assigned key and announces each step", () => {
    localStorage.setItem(
      SHORTCUTS_STORAGE_KEY,
      JSON.stringify({ cycle_session_width: "mod+alt+shift+y" })
    )
    renderWidth()

    let event!: KeyboardEvent
    act(() => {
      event = cycle()
    })
    expect(event.defaultPrevented).toBe(true)
    expect(shown()).toBe("wide:wide:1")

    act(() => {
      cycle()
      cycle()
    })
    expect(shown()).toBe("full:full:3")
    expect(widthProperty()).toBe("calc(100% - 2rem)")

    act(() => {
      cycle()
    })
    expect(shown()).toBe("standard:standard:4")
    expect(widthProperty()).toBe("")
  })
})
