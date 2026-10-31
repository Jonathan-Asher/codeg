# Talk mode

Talk mode is a hands-free voice conversation with one codeg session, held from
the Codeg Plus iPhone app. The phone does the listening and the speaking; the
codeg backend (the desktop app, or `codeg-server`) does three things:

- it keeps a per-conversation **Talk state** and tells every client about it;
- it adds a short **hidden note** (a "talk frame") to the messages it sends the
  agent, so the agent answers in short spoken sentences;
- it hides those notes again everywhere history is shown, and marks the
  messages that were **spoken**.

This page is the contract the iPhone client builds against.

1. [Rules that never change](#1-rules-that-never-change)
2. [Talk state](#2-talk-state)
3. [Endpoints](#3-endpoints)
4. [Spoken messages](#4-spoken-messages)
5. [Talk frames](#5-talk-frames)
6. [Presence: `talking`](#6-presence-talking)
7. [Events the phone relies on](#7-events)
8. [History: `MessageTurn.spoken`](#8-history)
9. [Desktop](#9-desktop)

## 1. Rules that never change

- **Nothing the agent already received changes.** Turning Talk on or off never
  touches the system prompt, `_meta`, the environment, MCP servers, tools, the
  mode or the model, and never reconnects the session. Any of those would
  invalidate the agent's prompt cache, and the next request would re-read the
  whole conversation at full price.
- **Frames are only ever appended to new messages,** as their last text block.
  A message the agent already has is never rewritten.
- **An interruption is a steering insert, never a cancel.** The phone delivers
  what the user said into the running turn with `submit_session_feedback`; it
  cancels only on an explicit "cancel the agent".

## 2. Talk state

Each conversation row has a Talk state: off (`NULL`), `on`, or `ending` (turned
off, and the agent has not been told yet). It is stored in the database, so it
survives restarts and reconnects, and setting it never moves `updated_at`.

Every conversation summary carries it as a boolean:

```json
{ "id": 42, "title": "…", "talk_mode": true, … }
```

`talk_mode` is `true` only in the `on` state. It is always present on servers
that know Talk mode, and absent on older ones (read it as `false`). It arrives
on `list_conversations`, `list_all_conversations`, `get_conversation` and every
`conversation://changed` upsert, which the server broadcasts whenever the state
changes.

Talk turns **on** when:

- a client calls `set_conversation_talk_mode` with `enabled: true`, or
- a spoken message arrives (`spoken: true` on `acp_prompt` or
  `submit_session_feedback`, see [§4](#4-spoken-messages)).

Talk turns **off** only through `set_conversation_talk_mode` with
`enabled: false` (the phone ends Talk; the desktop's menu item; a Talk left on
by a phone that crashed). From `on` it goes to `ending`; the next message the
user sends carries the Off frame, and the state then clears.

## 3. Endpoints

Web mode: `POST /api/<name>` with `Authorization: Bearer <token>` and a JSON
body. Desktop: Tauri `invoke("<name>", args)` with the same fields as
camelCase arguments.

### `set_conversation_talk_mode`

```json
{ "conversationId": 42, "enabled": true }
```

Answers `null`. An unknown or deleted conversation is an error (`not_found`).

- `enabled: true` sets the state to `on`. The next message on the
  conversation's connection carries the **Full** rules, even if an earlier
  message already did.
- `enabled: false` sets `on` to `ending` (the next message carries **Off**). A
  conversation that is already off stays off.
- Either way the summary is broadcast through `conversation://changed`.
- It does not touch the agent session in any way: no reconnect, no mode or
  model change, nothing sent to the agent by itself.

### `get_talk_settings`

Body `{}`. Answers the global settings:

```json
{ "language": "auto", "address": "auto" }
```

| Field | Values | Default | Meaning |
|---|---|---|---|
| `language` | `auto`, `he`, `en` | `auto` | `auto`: answer in the language of the user's last message, Hebrew when unsure. `he` / `en`: always that language. |
| `address` | `auto`, `masculine`, `feminine` | `auto` | How the agent addresses the user in Hebrew. `auto` avoids gendered second-person forms. |

An unknown value reads as `auto`.

### `update_talk_settings`

```json
{ "settings": { "language": "he", "address": "masculine" } }
```

Answers the stored settings (same shape as `get_talk_settings`). The new
settings reach every session with its next message: that message carries the
Full rules again.

## 4. Spoken messages

Both message endpoints take an optional `spoken` flag. Absent or `false` means
typed.

`acp_prompt` (unchanged otherwise; still answers `{"duplicate": bool}`):

```json
{
  "connectionId": "…",
  "blocks": [{ "type": "text", "text": "תבדוק למה הבילד נופל" }],
  "folderId": 3,
  "conversationId": 42,
  "clientMessageId": "optimistic-…",
  "spoken": true
}
```

`submit_session_feedback` (a message into the running turn; unchanged
otherwise, still answers the `FeedbackItem`, which now says `spoken`):

```json
{
  "connectionId": "…",
  "text": "רגע, תעצור את זה",
  "clientId": "optimistic-…",
  "spoken": true
}
```

```json
{
  "id": "optimistic-…",
  "text": "רגע, תעצור את זה",
  "created_at": "2026-11-01T10:00:00Z",
  "status": "delivered",
  "delivered_at": "2026-11-01T10:00:00Z",
  "spoken": true
}
```

What `spoken: true` does:

- turns Talk on for the conversation if it was off or ending (§2);
- marks the message as spoken: `spoken: true` on the live `user_message` /
  `feedback_submitted` events (§7) and on the history turn (§8), which is what
  draws the mic marker;
- otherwise the message is handled exactly like a typed one: the same turn
  gate (`turn_in_progress` / `NoActiveTurn` rejections), the same retry
  receipts, the same costs.

A `NoActiveTurn` answer to `submit_session_feedback` means the turn ended
first: resend the same words as an `acp_prompt` with `spoken: true`.

## 5. Talk frames

The phone never builds or reads frames; this section is what the server does.

While a conversation's state is `on` or `ending`, the server appends one frame
to each new message that goes through `acp_prompt`, or through
`submit_session_feedback` when the session takes inserts natively
(`_session/steering`; Claude Code, Pi). The frame is its own text block, after
everything else in the message (after codeg's `@agent` routing frame, if any).

| Mode | When | Size (with its descriptor) |
|---|---|---|
| **Full** | State `on`, and this connection has not carried the rules yet: the first message after Talk was turned on, after a reconnect, after a context compaction completed, after `/clear`, and after a settings change. | about 600 tokens |
| **Compact** | State `on`, and the rules are already in this connection's context. | about 140 tokens |
| **Off** | State `ending`: once, then the state clears. | about 65 tokens |

Like the rest of a new message, a frame is written to the prompt cache once
and read from it afterwards; nothing before it is ever re-sent.

No frame is added to:

- slash commands (a message whose first text starts with `/`) and messages
  with no text (images only);
- prompts sent by the delegation broker, chat channels (Telegram, …), work
  tasks and automations;
- notes delivered through the `check_user_feedback` pull tool (agents without
  native steering).

The rules count as delivered on a connection only once the prompt was
accepted, or once the insert reported `injected`. If anything else happened,
the next message carries Full again.

The rules are in `src-tauri/src/talk/rules.rs`. In short: one to three short
spoken sentences, no markdown, paths, URLs, hashes or code in speech; anything
to show goes in one fenced code block (which the phone does not read aloud);
command descriptions and plan openings in plain spoken words (the phone reads
those when it asks for a permission or a plan approval); one question at a
time; long work in the background (for Claude Code, its Agent tool with
`run_in_background`), with the result told briefly when it lands.

Wire format, for the curious: the record separator U+001E, a one-line JSON
descriptor, a newline, the body, and U+001E again.

```
␞{"kind":"codeg_internal_talk","version":1,"mode":"compact","spoken":true,"len":512,"digest":"0123456789abcdef"}
Talk mode is on (voice): …␞
```

`len` is the body's length in UTF-8 bytes and `digest` the first 16 hex digits
of the SHA-256 of `<mode>\n<spoken>\n<body>`. A frame is recognized by those
two, not by its wording, so the rules can change without old frames leaking
into history. U+001E is removed
from everything a client sends, so only the server can write one.

## 6. Presence: `talking`

The phone reports Talk on its event WebSocket (`/ws/events`) with the
existing presence message, plus `talking`:

```json
{
  "action": "presence",
  "visible": false,
  "focused": false,
  "idle_secs": 0,
  "conversation_ids": [42],
  "talking": true
}
```

`talking: true` says the phone is in a Talk session with the conversations in
`conversation_ids`. Send it while Talk is active, including with the screen
locked, at least every 30 s, and send `talking: false` (or nothing) once Talk
ends.

While such a report is fresh (less than 90 s old), whatever `visible`,
`focused` and `idle_secs` say:

- no push goes out about that conversation (turn finished, needs you, errors,
  critical alerts), nor about its sub-agents;
- its pending-item reminders are skipped;
- its critical-session alerts don't fire (no desktop alert, no push, no chat
  channel message): the watchdog treats it as attended.

A phone that dies stops reporting; 90 s later everything comes back. An idle
critical session then alerts after its usual idle threshold.

`talking` does not make the phone count as someone at the desk ("anyone
looking" stays desktop and web windows only; see `docs/ios-push.md` §7).

## 7. Events

Live events arrive on `/ws/events` as `event` frames after an `attach`
(`{"type":"event","subscription_id":"…","envelope":{"seq":…,"connection_id":"…","type":"…",…}}`).
The ones Talk relies on:

### `content_delta`

```json
{ "type": "content_delta", "text": "בדקתי, ", "parent_tool_use_id": "toolu_…" }
```

The agent's reply text, streamed. `parent_tool_use_id` is present only on a
sub-agent's text (Claude Code). Speak only the deltas **without** it: those are
the main thread's.

### `awaiting_background`

```json
{ "type": "awaiting_background", "awaiting": true, "native_steering": true }
```

`awaiting: true`: the main agent answered and is idle, and the turn is held
open only for background work (Claude Code sub-agents started with
`run_in_background`). The phone can keep talking: a message goes into the held
turn with `submit_session_feedback` (it wakes the agent, and `awaiting` turns
`false`). `native_steering` says whether inserts are delivered natively.

### `background_activity`

```json
{
  "type": "background_activity",
  "session_id": "…",
  "turns": [ { "id": "bg-1234-0", "role": "assistant", "blocks": [ … ], "timestamp": "…" } ],
  "outstanding": 1,
  "watermark": 56789
}
```

Work that happens outside a codeg-sent turn, read from the agent's own
transcript (Claude Code): a background agent finishing and the agent's
follow-up, cron and `/loop` turns. `turns` are `MessageTurn`s (§8), upserted by
`id` (a growing turn is sent again whole). Their user turns are cleaned like
history: no frames, `spoken` set. The follow-up after a background result is an
assistant turn here; speak its text with a cursor per turn `id`.

### `user_message`

```json
{
  "type": "user_message",
  "message_id": "optimistic-…",
  "blocks": [{ "type": "text", "text": "תבדוק למה הבילד נופל" }],
  "spoken": true
}
```

A prompt that went to the agent, as the user sent it: never with a frame.
`spoken` is present (and `true`) only for a spoken message. The live snapshot's
`pending_user_message` carries the same `spoken`.

### `feedback_submitted`

```json
{ "type": "feedback_submitted", "item": { "id": "…", "text": "…", "status": "delivered", "spoken": true, … } }
```

A message delivered into the running turn. `item.spoken` as above; the
snapshot's `feedback` list carries it too.

## 8. History

`get_conversation` returns user turns exactly as the user sent them: frames are
removed on every path (Claude Code transcripts, including messages inserted
mid-turn, Pi, codeg's own transcripts for other agents, the transcript cache,
the background overlay above, and message search). A user turn that was spoken
says so:

```json
{ "id": "turn-7", "role": "user", "blocks": [{ "type": "text", "text": "…" }], "timestamp": "…", "spoken": true }
```

`spoken` is absent on typed messages, on every other role, and from servers
that predate Talk.

## 9. Desktop

- A **Talk** badge (the `AudioLines` icon) shows on the session's sidebar row,
  its tab and its header while `talk_mode` is true.
- The same three places have a menu item to turn Talk on or off (for example a
  Talk left on by a phone that crashed).
- Spoken user messages show a small mic marker.
- **Settings › Talk** edits the language and the address form (§3).
