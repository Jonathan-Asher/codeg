# Fork solution plan — codeg pains (Jonathan's fork)

**Fork:** https://github.com/Jonathan-Asher/codeg (upstream `xintaofei/codeg`, v0.30.9, Apache-2.0)
**Local clone:** `~/Work/codeg` · **Date:** 2026-09-17
**Priority order agreed:** ① Search index ② Session tree UI ③ Resume/deep-link fork bug ④ Battery.
Destructive-action safety nets: **not a priority**.

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
