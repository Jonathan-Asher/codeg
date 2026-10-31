import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

import { DEFAULT_TALK_VOICE_PREFS, wirePrefs, type TalkVoiceApi } from "./api"
import { TalkBridge } from "./bridge"
import { portSnapshot } from "./port-snapshot"
import {
  parseEnvelope,
  parseHelperMessage,
  responseMessage,
  TALK_PROTOCOL_VERSION,
  type TalkControlOp,
  type TalkRequestOp,
  type WindowMessage,
} from "./protocol"

/**
 * The helper's protocol fixtures (native/codeg-talk/fixtures/protocol on the
 * helper's branch, copied here): every message the helper sends parses, and
 * every message the window sends has the helper's shape.
 */

const DIR = join(process.cwd(), "src/lib/talk-voice/__fixtures__/protocol")

function fixtures(prefix: string): [string, Record<string, unknown>][] {
  return readdirSync(DIR)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort()
    .map((name) => [
      name,
      JSON.parse(readFileSync(join(DIR, name), "utf8")) as Record<
        string,
        unknown
      >,
    ])
}

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(DIR, name), "utf8")) as Record<string, unknown>

const keys = (value: unknown) =>
  Object.keys(value as Record<string, unknown>).sort()

const CONTROL_OPS: TalkControlOp[] = [
  "toggleMute",
  "softMute",
  "skip",
  "tapOrb",
  "press",
  "cancelPress",
  "choose",
  "reportCutOff",
  "setHandsFree",
  "repeatLast",
]

const REQUEST_OPS: TalkRequestOp[] = [
  "sendSpoken",
  "respondPermission",
  "answerQuestion",
  "declineQuestion",
  "answerPlanApproval",
  "setTalkMode",
  "fetchSettings",
  "respondItem",
  "answerItem",
  "answerItemPlan",
  "uploadReport",
]

describe("the helper's messages", () => {
  const toWindow = fixtures("to-window.")

  it("has fixtures to check against", () => {
    expect(toWindow.length).toBeGreaterThanOrEqual(21)
  })

  it.each(toWindow)("%s parses as its type", (_name, value) => {
    const parsed = parseHelperMessage(value)
    expect(parsed).not.toBeNull()
    expect(parsed?.type).toBe(value.type)
  })

  it("asks every request op the window carries out, and only those", () => {
    const ops = new Set(
      toWindow
        .filter(([, value]) => value.type === "req")
        .map(([, value]) => value.op as string)
    )
    // uploadReport is in the README though not every op has a fixture: every
    // fixture op is one the bridge knows.
    for (const op of ops) expect(REQUEST_OPS).toContain(op)
    expect(ops.size).toBeGreaterThanOrEqual(10)
  })

  it("speaks this protocol version", () => {
    expect(fixture("to-window.hello.json").protocol).toBe(TALK_PROTOCOL_VERSION)
  })

  it("ignores what it doesn't know, and reads Rust's envelope", () => {
    expect(parseHelperMessage({ type: "somethingNew" })).toBeNull()
    expect(parseHelperMessage({ type: "req", id: 1, op: "unknownOp" })).toBeNull()
    expect(parseHelperMessage("state")).toBeNull()
    expect(parseEnvelope({ talkId: 3, message: { type: "level" } })).toEqual({
      talkId: 3,
      message: { type: "level" },
    })
    expect(parseEnvelope({ message: {} })).toBeNull()
  })

  it("reads a state message's dock fields", () => {
    const state = parseHelperMessage(fixture("to-window.state.asking.json"))
    expect(state).toMatchObject({
      type: "state",
      status: "asking",
      ask: { choices: [{ id: "allow" }, { id: "always" }, { id: "deny" }] },
    })
  })
})

describe("the window's messages", () => {
  const toHelper = fixtures("to-helper.")

  it("has fixtures to check against", () => {
    expect(toHelper.length).toBeGreaterThanOrEqual(26)
  })

  it("uses the helper's control ops exactly", () => {
    const ops = toHelper
      .filter(([, value]) => value.type === "control")
      .map(([, value]) => value.op as string)
      .sort()
    expect(ops).toEqual([...CONTROL_OPS].sort())
  })

  it("starts a Talk with the fields the helper reads (Rust adds the models)", async () => {
    let started: WindowMessage | null = null
    const api: TalkVoiceApi = {
      status: vi.fn(),
      onStatus: vi.fn(),
      onShortcut: vi.fn(),
      start: vi.fn(async (_id, _local, message) => {
        started = message
        return { talkId: 1, hello: { protocol: 1 } }
      }),
      send: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      onMessage: vi.fn(async () => () => {}),
    }
    const bridge = new TalkBridge({
      conversationId: 42,
      contextKey: "tab",
      local: true,
      api,
      actions: {
        respondPermission: vi.fn(),
        answerQuestion: vi.fn(),
        answerPlanApproval: vi.fn(),
        cancel: vi.fn(),
        registerLiveSurfaceKeys: vi.fn(),
      },
      backend: {
        setTalkMode: vi.fn(),
        fetchSettings: vi.fn(),
        respondItem: vi.fn(),
        answerItem: vi.fn(),
        answerItemPlan: vi.fn(),
        uploadReport: vi.fn(),
      },
      sources: {
        store: { getConnection: () => undefined, subscribeKey: () => () => {} },
        pendingItems: { get: () => [], subscribe: () => () => {} },
        title: () => "Fix the flaky build",
        folder: () => "codeg",
        adapter: () => null,
      },
      setTalking: vi.fn(),
    })
    await bridge.start({
      settings: { language: "auto", address: "masculine" },
      prefs: wirePrefs(DEFAULT_TALK_VOICE_PREFS),
      voice: { name: "noa", speed: 1 },
      app: { version: "0.9.2-fork.318", build: "318", bundleId: "app.codeg" },
    })
    const reference = fixture("to-helper.start.json")
    const { models: _models, ...withoutModels } = reference
    void _models
    expect(keys(started)).toEqual(keys(withoutModels))
    const message = started as unknown as Record<string, unknown>
    expect(keys(message.port)).toEqual(keys(reference.port))
    expect(keys(message.voice)).toEqual(keys(reference.voice))
    expect(keys(message.app)).toEqual(keys(reference.app))
    expect(keys(message.settings)).toEqual(keys(reference.settings))
    // The helper's prefs, plus `useWhisper` (Rust reads it, the helper
    // ignores it).
    expect(keys(message.prefs).filter((k) => k !== "useWhisper")).toEqual(
      keys(reference.prefs)
    )
  })

  it("sends port fields the helper knows", () => {
    const port = portSnapshot(undefined, "x")
    const known = new Set([
      ...keys(fixture("to-helper.port.json")),
      ...keys(fixture("to-helper.port.plan.json")),
      ...keys(fixture("to-helper.start.json").port),
      "title",
    ])
    for (const key of keys(port)) expect(known).toContain(key)
  })

  it("answers requests in the helper's shape", () => {
    expect(responseMessage(3, { ok: true, value: "insert" })).toEqual(
      fixture("to-helper.res.sendSpoken.json")
    )
    expect(
      responseMessage(6, {
        ok: false,
        error: "no permission request is pending",
      })
    ).toEqual(fixture("to-helper.res.error.json"))
    expect(responseMessage(4, { ok: true, value: true })).toEqual(
      fixture("to-helper.res.answer.json")
    )
  })
})
