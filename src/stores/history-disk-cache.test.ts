/**
 * The disk layer of the history cache: what it keeps (the tail window, no
 * secrets), for whom (per server), for how long (LRU within a byte and entry
 * budget), and that it survives a restart (a new cache over the same store).
 */
import { describe, expect, it } from "vitest"
import { extendPrefixFingerprint, FNV_SEED_HEX } from "@/lib/turn-window"
import type { DbConversationDetail, MessageTurn } from "@/lib/types"
import {
  createHistoryDiskCache,
  createMemoryDiskBackend,
  historyEntryKey,
} from "./history-disk-cache"
import {
  dropLeadingTurns,
  shapeKeptDetail,
  trimToTail,
  withoutSecretAnswers,
} from "./history-snapshot"

function at(i: number): string {
  return new Date(Date.UTC(2026, 9, 29, 8, 0, i)).toISOString()
}

function turn(i: number, role: MessageTurn["role"], text = `t${i}`) {
  return {
    id: `turn-${i}`,
    role,
    blocks: [{ type: "text" as const, text }],
    timestamp: at(i),
  } satisfies MessageTurn
}

/** `count` turns alternating user/assistant, as a window from `offset`. */
function windowed(
  id: number,
  count: number,
  offset = 0,
  fill = ""
): DbConversationDetail {
  const all: MessageTurn[] = []
  for (let i = 0; i < offset + count; i++) {
    all.push(turn(i, i % 2 === 0 ? "user" : "assistant", `t${i}${fill}`))
  }
  const prefix = all.slice(0, offset)
  return {
    summary: {
      id,
      folder_id: 1,
      agent_type: "claude_code",
      title: "t",
      title_locked: false,
      status: "completed",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: `session-${id}`,
      message_count: offset + count,
      child_count: 0,
      created_at: at(0),
      updated_at: at(0),
      pinned_at: null,
    },
    turns: all.slice(offset),
    session_stats: null,
    turns_offset: offset,
    turns_total: offset + count,
    assistant_turns_before_offset: prefix.filter((t) => t.role === "assistant")
      .length,
    prefix_hash: extendPrefixFingerprint(FNV_SEED_HEX, prefix)!,
    uncovered_prefix_max_ts: offset > 0 ? at(offset - 1) : null,
  } as DbConversationDetail
}

describe("cutting a detail to its tail window", () => {
  it("moves the window exactly as the server would have served it", () => {
    const full = windowed(1, 300)
    const tail = trimToTail(full, 120)!
    // 180 dropped, already a user turn: no walk back needed.
    const server = windowed(1, 120, 180)
    expect(tail.turns).toHaveLength(120)
    expect(tail.turns_offset).toBe(180)
    expect(tail.prefix_hash).toBe(server.prefix_hash)
    expect(tail.assistant_turns_before_offset).toBe(
      server.assistant_turns_before_offset
    )
    expect(tail.uncovered_prefix_max_ts).toBe(server.uncovered_prefix_max_ts)
    expect(tail.turns[0].role).toBe("user")
  })

  it("starts the window at a user turn", () => {
    const tail = trimToTail(windowed(1, 301), 120)!
    // 181 would start on an assistant turn: one more turn is kept.
    expect(tail.turns_offset).toBe(180)
    expect(tail.turns).toHaveLength(121)
  })

  it("keeps a detail that fits, and cannot cut a legacy one", () => {
    const small = windowed(1, 10)
    expect(trimToTail(small, 120)).toBe(small)
    const legacy = { ...windowed(1, 10), prefix_hash: null }
    expect(dropLeadingTurns(legacy, 2)).toBeNull()
  })

  it("cuts by size, newest turns first, and never keeps a mid-turn one", () => {
    const big = windowed(1, 40, 0, "x".repeat(1000))
    const kept = shapeKeptDetail(big, { maxBytes: 10_000 })!
    expect(kept.json.length).toBeLessThanOrEqual(10_000)
    expect(kept.detail.turns[kept.detail.turns.length - 1].id).toBe("turn-39")
    expect(kept.detail.turns[0].role).toBe("user")
    expect(JSON.parse(kept.json)).toEqual(kept.detail)

    expect(
      shapeKeptDetail({ ...windowed(1, 2), in_flight_user_turn_id: "turn-0" })
    ).toBeNull()
    // A newest round bigger than the budget on its own: nothing kept.
    expect(shapeKeptDetail(big, { maxBytes: 500 })).toBeNull()
  })
})

describe("answers marked secret", () => {
  const ask = (secret: boolean) =>
    JSON.stringify({
      questions: [
        {
          id: "q1",
          question: "Your API key?",
          header: "Key",
          options: [],
          ...(secret ? { isSecret: true } : {}),
        },
      ],
    })

  function withAnswer(secret: boolean): DbConversationDetail {
    const detail = windowed(3, 2)
    detail.turns[1] = {
      ...detail.turns[1],
      blocks: [
        {
          type: "tool_use",
          tool_use_id: "call-1",
          tool_name: "request_user_input",
          input_preview: ask(secret),
        },
        {
          type: "tool_result",
          tool_use_id: "call-1",
          output_preview: '{"answers":{"q1":{"answers":["sk-live-123"]}}}',
          is_error: false,
        },
      ],
    }
    return detail
  }

  it("are never written to disk", async () => {
    const backend = createMemoryDiskBackend()
    const cache = createHistoryDiskCache(backend)
    await cache.save("web:a", 3, withAnswer(true))
    const stored = backend.entries.get(historyEntryKey("web:a", 3))!.json
    expect(stored).not.toContain("sk-live-123")
    expect(stored).toContain("Your API key?")
    const loaded = await cache.load("web:a", 3)
    const result = loaded!.turns[1].blocks[1]
    expect(result.type === "tool_result" && result.output_preview).toBeNull()
  })

  it("leave every other answer alone", () => {
    const plain = withAnswer(false)
    expect(withoutSecretAnswers(plain)).toBe(plain)
  })
})

describe("the disk cache", () => {
  it("survives a restart: a new cache over the same store reads it back", async () => {
    const backend = createMemoryDiskBackend()
    const detail = windowed(7, 4)
    expect(await createHistoryDiskCache(backend).save("local", 7, detail)).toBe(
      true
    )
    const afterRestart = createHistoryDiskCache(backend)
    expect(await afterRestart.load("local", 7)).toEqual(detail)
  })

  it("keeps each server's sessions apart", async () => {
    const backend = createMemoryDiskBackend()
    const cache = createHistoryDiskCache(backend)
    await cache.save("remote:https://a.example", 7, windowed(7, 2))
    expect(await cache.load("remote:https://b.example", 7)).toBeNull()
    expect(await cache.load("local", 7)).toBeNull()
    expect(await cache.load("remote:https://a.example", 7)).not.toBeNull()

    await cache.save("remote:https://b.example", 7, windowed(7, 3))
    await cache.clearServer("remote:https://a.example")
    expect(await cache.load("remote:https://a.example", 7)).toBeNull()
    expect(
      (await cache.load("remote:https://b.example", 7))!.turns
    ).toHaveLength(3)
  })

  it("evicts the least recently used session within its budgets", async () => {
    let clock = 0
    const backend = createMemoryDiskBackend()
    const cache = createHistoryDiskCache(backend, {
      maxEntries: 2,
      now: () => ++clock,
    })
    await cache.save("local", 1, windowed(1, 2))
    await cache.save("local", 2, windowed(2, 2))
    await cache.load("local", 1) // 1 is now the more recently used
    await cache.save("local", 3, windowed(3, 2))
    expect(await cache.load("local", 2)).toBeNull()
    expect(await cache.load("local", 1)).not.toBeNull()
    expect(await cache.load("local", 3)).not.toBeNull()

    const one = (await cache.save("local", 4, windowed(4, 2)))
      ? backend.entries.get(historyEntryKey("local", 4))!.meta.bytes
      : 0
    const bySize = createHistoryDiskCache(createMemoryDiskBackend(), {
      maxBytes: one * 2 + 10,
      now: () => ++clock,
    })
    await bySize.save("local", 1, windowed(1, 2))
    await bySize.save("local", 2, windowed(2, 2))
    await bySize.save("local", 3, windowed(3, 2))
    expect(await bySize.load("local", 1)).toBeNull()
    expect(await bySize.load("local", 3)).not.toBeNull()
  })

  it("forgets a deleted session, and everything on sign-out", async () => {
    const backend = createMemoryDiskBackend()
    const cache = createHistoryDiskCache(backend)
    await cache.save("local", 1, windowed(1, 2))
    await cache.save("local", 2, windowed(2, 2))
    await cache.remove("local", 1)
    expect(await cache.load("local", 1)).toBeNull()
    await cache.clear()
    expect(backend.entries.size).toBe(0)
  })

  it("drops what it cannot read back", async () => {
    const backend = createMemoryDiskBackend()
    const cache = createHistoryDiskCache(backend)
    await cache.save("local", 1, windowed(1, 2))
    const key = historyEntryKey("local", 1)
    backend.entries.get(key)!.json = "{not json"
    expect(await cache.load("local", 1)).toBeNull()
    expect(backend.entries.has(key)).toBe(false)

    // Another session's detail under this key (a reused id): not served.
    await cache.save("local", 1, windowed(1, 2))
    backend.entries.get(key)!.json = JSON.stringify(windowed(2, 2))
    expect(await cache.load("local", 1)).toBeNull()
  })
})
