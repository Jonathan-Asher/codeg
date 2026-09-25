# Fork solution plan — codeg pains (Jonathan's fork)

**Fork:** https://github.com/Jonathan-Asher/codeg (upstream `xintaofei/codeg`, v0.30.9, Apache-2.0)
**Local clone:** `~/Work/codeg` · **Date:** 2026-09-17
**Priority order agreed:** ① Search index ② Session tree UI ③ Resume/deep-link fork bug ④ Battery.
Destructive-action safety nets: **not a priority**.

**Status 2026-09-17:** Pain 1b (cmd+F) implemented → upstream PR #764; first fork build produced
`target/release/bundle/macos/codeg.app` (DMG bundling step fails — cosmetic, needs Finder/hdiutil).

**Backlog (Jonathan, 2026-09-17 evening):**
- ⑤ **⌘⇧W closes the whole window** — with a remote-workspace window AND a local-workspace window
  open, it should close only the focused one. Investigate the keybinding scope in the frontend.
  **Status 2026-09-25 — fixed with ⑩:** ⌘⇧W is a registered "Close Window" shortcut that only the focused window receives.
- ⑥ **Stale transcript after MacBook wake** — prompt a Claude Code session, close the lid, reopen:
  streamed replies are missing until the remote workspace is closed and reopened. The client's
  WS/event stream dies on sleep and nothing re-syncs on wake. Fix direction: on window focus /
  network reconnect, re-fetch the session snapshot (codeg already has `acp_get_session_snapshot`
  and turn-window machinery) before trusting the local view.
  **Status 2026-09-23 — fixed.** Two gaps, both closed: (a) neither transport ever checked the
  socket was alive — a socket that died during sleep stays OPEN until the OS times it out, so no
  reconnect, no re-attach snapshot, no status flip (`web-transport.ts` heartbeat + wake probe via
  the connection guard; Rust `remote_proxy.rs` heartbeat + `remote_ws_probe`); (b) `useWakeResync`
  dropped its refetch while the client still believed a turn was streaming — after sleep that belief
  is stale, so the trigger is now deferred until the reconnect snapshot settles the status. Also:
  the desktop proxy no longer reports a session as expired after three *network* failures (Wi-Fi
  still coming up after wake); only auth rejections on the handshake count.
- **Updater (2026-09-24, Jonathan: "we are holding the fork").** Everything update-related now points
  at the fork: the desktop feed already did (`tauri.conf.json`), and now so do the server-side manifest
  (`src-tauri/src/update/version.rs`, which answers update checks for remote-workspace windows) and the
  two "view release" links. Before, a remote window advertised upstream 0.32.1 and linked to it — installing
  that DMG would have wiped every fork feature. Fork builds carry their own version, stamped by CI:
  `<upstream major.minor.(patch+1)>-fork.<run number>` (e.g. `0.30.11-fork.42`), which is what makes the
  in-app update button deliver fork builds at all (the updater installs only a strictly newer semver, and
  the feed used to repeat the upstream version). The scheme stays above whatever upstream version the
  branch is rebased onto. Upstream ships fast (0.30.10 → 0.32.1 in four days): rebase soon.
- ⑦ **Reorder pinned sessions by dragging** — sidebar pinned order currently derives from
  `pinned_at`; needs a per-folder sort order plus drag-and-drop in the sidebar.

**Backlog (Jonathan, 2026-09-24):**
- ⑧ **Sidebar folder view: recently-messaged session should float to the top of its folder.**
  With sessions grouped by work folder, sending a message to a session does not move it to the
  first position in that folder. Sort each folder's sessions by last activity (last message
  sent/received), pinned ones excepted.
  **Status 2026-09-25 — fixed:** the sidebar defaults to "Last updated" order; a send bumps the session (status change), so it rises at once. An explicit View-options choice is kept.
- ⑨ **Sidebar session timestamps: show last-message time, not creation time.** The row next to a
  session shows how long ago it was created; Jonathan wants the time since the last message
  (confirm whether creation time should go entirely or sit second). Pairs with ⑧ — both hang off a
  per-conversation "last activity" that the row and the sort share.
  **Status 2026-09-25 — fixed with ⑧:** in "Last updated" order the row shows time since last activity.
- ⑩ **⌘⇧W does not close the window** (2026-09-24 report; ⑤ above is the older report that it closed
  the *wrong* window). Trace the shortcut from the keybinding registry to the Tauri window close and
  fix whichever half is broken; scope it to the focused window.
  **Status 2026-09-25 — fixed:** new `close_window` shortcut (default mod+shift+w, shared with close-all-file-tabs like ⌘W is shared): file pane → close file tabs, elsewhere → close the focused window via its own close path.
- ⑪ **OS notifications don't say which session they are about** (2026-09-24). Root cause, in
  `acp-connections-context.tsx`: every banner (turn finished, permission, question, error, background
  task) is titled `<folder> - Codeg`, where `<folder>` is the window's ACTIVE folder — not the folder of
  the session that raised it — and the body only names the agent ("Claude Code has finished
  responding"). With several sessions across folders the banner is unattributable, and can even name
  the wrong folder. Clicking it doesn't open the session either (the native notification carries no
  action). Fix: title = the session's own title (fallback: its folder), body = folder + agent + event;
  keep the "hide notification contents" redaction honoured, since a session title is user-authored
  text. Stretch: click → focus that session.
  **Status 2026-09-24 — done** (with ⑫): banners are titled with the session's own title, the body
  leads with the session's real folder, and "hide notification contents" swaps the title back to
  `<folder> - Codeg` (`src/lib/notification-session.ts`). Click-to-open is still open.
  **Status 2026-09-24 — fixed:** notifications are titled with the session and name its own folder (upstream PR xintaofei/codeg#834).
- ⑫ **Sidebar "waiting on you" indicator** (Jonathan, 2026-09-24: "if a session is stuck on a
  permission or asking a question I have no idea which session it is"). **Done:** the central
  `emit_with_state` hook diffs each session's `AttentionKind` (permission > question > plan approval;
  none once disconnected) around every event and broadcasts changes on `conversation://attention` —
  its own channel, because older clients would misread a new `conversation://changed` kind as a
  status and blank the row. `list_conversation_attention` is the snapshot (start, reconnect, and
  250 ms after live events), and maps a blocked delegation sub-agent to its visible root row. UI: a
  pulsing rose dot on the row's agent glyph, a rose icon badge with a tooltip (shield / question
  bubble / clipboard), and a rose bell count on folder and group headers so collapsed folders still
  signal.
- ⑬ **Arrange the tab strip** (Jonathan, 2026-09-24). **Done:** an "Arrange tabs" button beside the
  new-tab button — manual order (draggable, as before), group by work folder (a colored label per
  folder plus a color stripe on each tab; uncolored folders get a stable auto color), or sort by
  status (needs you → awaiting your reply → running → other, each band labeled). Display-only:
  the manual order and its persistence are untouched, and dragging is off while a derived layout is
  shown. Per-device preference (`workspace:tab-arrange-mode`); applies to split strips too.

---

## Pain 1 — Search doesn't find chat content

**Root cause (confirmed):** `src-tauri/src/commands/conversations.rs:264` — the search is a
lowercased `contains()` over conversation **metadata only** (title, path, branch, model, folder).
Message bodies never enter the DB; they live in per-agent session files.

**Key asset already in the codebase:** `src-tauri/src/parsers/pi.rs` (2,507 lines) fully
reconstructs pi session stores into `UnifiedMessage`s — including walking only the *active*
branch of the tree (`active_branch()`, leaf → root via `parentId`). Equivalent parsers exist for
claude, codex, opencode, gemini, grok, cline, etc. So message text is already derivable — it's
just never indexed.

**Plan (upstreamable — no fork needed, but we can carry it in the fork):**
1. New module `src-tauri/src/search/`: incremental indexer over the parser outputs.
   - SQLite **FTS5** virtual table `(conversation_id, agent_type, turn_idx, body, updated_at)`.
   - Trigger: watch session-file `mtime` per conversation (parsers already know the paths);
     re-parse and upsert on change. Full backfill on first run (~10 MB here — seconds).
   - Run on a debounce in the background task pool; never on the UI hot path.
2. Extend the search dialog (`src/contexts/search-dialog-context.tsx`) to a second results
   section "Messages" hitting a new `search_messages` command (`FTS5 MATCH`).
3. Open result → open conversation → scroll to `turn_idx`.

**Estimate:** parser integration is the only risky part; everything else is additive.

### 1b. cmd+F — find within the open chat (user requirement, 2026-09-17)

Separate, simpler feature than the global index: find-in-conversation over the already-parsed
turns of the open session. Client-side only (works from the remote-workspace Mac with no server
change); highlight matches, next/prev navigation, optional case sensitivity. Ships before the
FTS indexer; the indexer complements it for cross-conversation reach.

**Upstream status (deep search 2026-09-17): no PRs for any of our pains; issue landscape:**
- **Resume (Pain 3) is a known upstream bug class:** #528 open (Claude historical sessions
  spawn + never connect; #529 closed dup explicitly asks for auto-connect on open) and #697
  open (Gemini sessions lost). Our fix = PR with proven demand; link both.
- **Tree UI (Pain 2) has demand:** #328 open FR asks for a double-esc rewind button ("really
  important") — same user need as the branch switcher; reference it in the PR.
- **Search / cmd+F / battery:** unclaimed. Only neighbor: #596 perf PR (bound transcript and
  live-tool resource usage) — rebase battery work on it if merged; #427 (closed) was a
  Linux/EGL 100%-CPU startup bug, unrelated to our macOS webview drain.

---

## Pain 2 — Can't go back in sessions / can't edit or delete past messages

**Root cause (confirmed):** pi sessions are trees (`id`/`parentId`, branches in place), and pi
abandoned branches stay in the file. `parsers/pi.rs` deliberately projects **only the active
branch** to a linear thread; codeg's UI renders exactly that projection. "Edit" in pi semantics
= fork at a point; codeg has fork machinery (`src-tauri/src/acp/fork.rs`) but exposes no
per-message UI.

**Plan:**
1. **History navigation first (read-only, low risk):** parser change — instead of projecting one
   active branch, return the tree (entries + parent links + which leaf is active). Frontend:
   a branch switcher on messages that have multiple children ("view earlier branch / fork point"),
   rendering the selected path. No ACP involvement, works for closed sessions.
2. **Edit/delete = fork-at-point (uses existing machinery):** on "edit message", call the
   existing fork flow (`acp/fork.rs`) with the target parent entry id; pi branches in place and
   codeg already handles the row-repointing dance (see the long comment in
   `src/components/conversations/conversation-detail-panel.tsx:502` — the fork chain handling
   is battle-tested). UI shows the fork point inline.
3. Keep `parsers/pi.rs`'s active-branch default for anything that needs linear text (export,
   indexing in Pain 1 indexes the active branch only, matching what pi itself shows in terminal).

**Depends on:** nothing — independent of Pain 1. Hardest part is frontend state, not the backend.

---

## Pain 3 — Resume/deep-link fork bug (new chat instead of resuming)

**Live reproduction (this morning, 2026-09-17 09:12):** clicking `codeg://session/31` — which
should *focus* existing conversation 31 ("btw", pi session `01a0aa57`) — instead spawned a fresh
connection. Log (`~/.codeg/logs/codeg.2026-09-17.log:158`):

```
[ACP] Agent capabilities: load_session=true, fork=false, resume=false
  span: agent_type=Pi, session_id=None
```

→ pi-acp **advertises `resume=false`**, so codeg started the agent with `session/new`; pi
allocated a new session (`01a0aea3`), which landed in a **new** conversation row (#33) rather
than #31. Old history stays orphaned behind the old live connection.

**Root cause chain:** (a) pi-acp 0.0.33 doesn't implement ACP session resume — same vendor
library as the `/btw` slash-command gap; (b) codeg degrades to a brand-new conversation row
silently, so the user's mental model ("I opened my old chat") breaks.

**Plan, two layers:**
1. **pi-acp (the real fix):** implement resume — on `session/load`/connect-with-session-id,
   relaunch `pi --resume <session-id>` (the CLI already supports it; pi sessions are resumable
   from disk). Same patch-and-PR path as the `includeExtensionCommands` fix we already carry
   locally (`/opt/homebrew/lib/node_modules/pi-acp/dist/index.js`, backup `.bak`). Check
   upstream pi-acp for a newer version first.
2. **codeg (defense in depth):** when a target conversation exists but the agent can't resume,
   *focus the existing row* and render reconstructed history from the parser (Pain 2 machinery),
   with a visible banner "agent cannot resume this session — new turns start a fresh branch",
   instead of silently creating a sibling conversation.
3. Verify the deep-link resolve path (`deep_link.rs::resolve_deep_link` →
   `find_live_by_session_ref`) actually fired here — the log suggests the link resolved but the
   connect went out without `session_id`; add a log line when `sessionId=undefined` on a
   persisted conversation (the frontend guards this at
   `conversation-detail-panel.tsx:561` `awaitingHistoricalSessionId`, so find which path bypassed it).

**Note:** today's incident may be the deep-link-open → new-conversation path rather than a
failed resume mid-chat; the fix in (2) covers both. Confirm with a local debug build before
filing upstream.

---

## Pain 4 — Battery drain

**Verified numbers:** codeg main process ~6% CPU at idle-ish, +2.4% for a live claude-agent-acp
child. Backend timers are cheap and not the drain: automation engine ticks at 30 s
(`automation/engine.rs:51-57`: reconcile 30 s, scheduler 30 s, prune 6 h); token-usage sync is
on-demand with a guard, not a poll.

**Prime suspect:** the webview layer — Next.js UI repainting on `ws/events` traffic, plus
Tauri webview treatment when hidden (pets/animations, canvas, live event cards). macOS
WKWebView repaints even occluded windows unless `occlusion` is respected.

**Plan (profile before touching anything):**
1. `sample` the codeg process over 60 s idle vs. active; look for `WKWebView`, `CA::Transaction`,
   timer churn in the profile.
2. Attach Safari Web Inspector to the Tauri webview: check for rAF loops, re-renders on
   `ws/events` while the window is hidden (React devtools profile).
3. Cheap candidate fixes, in order: pause `ws/events` re-renders when the tab/window isn't
   visible (document.visibilityState / Tauri focus events); gate pet animations on occlusion;
   backstop: reduce event emit frequency for token-usage progress.

---

## Working agreements for the fork

- Branch per pain: `fork/search-index`, `fork/tree-ui`, `fork/resume-fix`, `fork/battery`.
- Anything generally useful (search indexer, tree UI, resume fallback) → PR upstream to
  `xintaofei/codeg`; keep only pi-acp patches as local carryovers.
- Rebase often: upstream ships ~1 release every few days (0.30.5 → 0.30.9 within a week).
- Local build: `pnpm i && pnpm tauri dev` (desktop), tests via `pnpm test` /
  `cargo test --features test-utils`.

**Delivered 2026-09-24/25 (Jonathan's asks):** launch straight into a remote workspace (Settings › System
"When codeg starts, open"), a Reconnect path for remote windows (connection dialog, full-window screen with
Reconnect / Edit connection / Close window, Retry on the open toast), edit a past message (fork at the reply
before it, then send; Claude Code / Codex / DeepSeek), ⌘K opens with the cursor in the box, message search that
finds partial words and Chinese/Japanese text.

**Upstream PRs (xintaofei/codeg):** #764 find in conversation (refreshed), #833 ⌘K focus, #834 session-named
notifications, #835 arrange tabs, #836 pinned drag reorder, #840 sleep/wake recovery, #841 message search.
The sidebar "needs you" indicator stays fork-only (upstream #782 covers it); Retry and Pi fork points too.

