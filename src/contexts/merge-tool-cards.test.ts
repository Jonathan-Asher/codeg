/**
 * The snapshot carries the newest card of each Pi run and job
 * (`tool_cards`). A fresh snapshot is the backend's newest per call; a stale
 * one predates cards this client already applied, so it may only add calls.
 */
import { describe, expect, it } from "vitest"

import { mergeToolCards } from "@/contexts/acp-connections-context"
import { denormalizeSnapshot } from "@/lib/snapshot-denormalize"
import type { LiveSessionSnapshot } from "@/lib/types"

const running = { "codeg.subagentRun": { status: "running" } }
const done = { "codeg.subagentRun": { status: "completed" } }

describe("mergeToolCards", () => {
  it("takes a fresh snapshot's card for each call", () => {
    const current = new Map([["call-1", running]])
    const merged = mergeToolCards(
      current,
      [
        { tool_call_id: "call-1", meta: done },
        { tool_call_id: "call-2", meta: running },
      ],
      false
    )
    expect(merged?.get("call-1")).toBe(done)
    expect(merged?.get("call-2")).toBe(running)
  })

  it("lets a stale snapshot add calls but never roll one back", () => {
    const current = new Map([["call-1", done]])
    const merged = mergeToolCards(
      current,
      [
        { tool_call_id: "call-1", meta: running },
        { tool_call_id: "call-2", meta: running },
      ],
      true
    )
    expect(merged?.get("call-1")).toBe(done)
    expect(merged?.get("call-2")).toBe(running)
  })

  it("keeps the same map when nothing changes", () => {
    const current = new Map([["call-1", done]])
    expect(
      mergeToolCards(current, [{ tool_call_id: "call-1", meta: done }], false)
    ).toBe(current)
    expect(mergeToolCards(current, [], false)).toBe(current)
    expect(mergeToolCards(null, [], false)).toBeNull()
  })
})

describe("the snapshot's cards", () => {
  it("reach the patch, and default to none", () => {
    const base = {
      connection_id: "c",
      conversation_id: 1,
      folder_id: 1,
      status: "connected",
      external_id: "s",
      live_message: null,
      active_tool_calls: [],
      pending_permission: null,
      modes: null,
      current_mode: null,
      config_options: null,
      prompt_capabilities: null,
      usage: null,
      fork_supported: false,
      selectors_ready: true,
      event_seq: 3,
    } as unknown as LiveSessionSnapshot
    expect(denormalizeSnapshot(base).toolCards).toEqual([])
    const cards = [{ tool_call_id: "call-1", meta: done }]
    expect(denormalizeSnapshot({ ...base, tool_cards: cards }).toolCards).toBe(
      cards
    )
  })
})
