"use client"

import {
  buildMechanicalHandoff,
  requestContinuationHandoff,
  type ContinuationHandoff,
} from "@/lib/api"
import { parkComposerPrefill } from "@/lib/composer-prefill-handoff"
import { parkContinuationLink } from "@/lib/continuation-links"
import { requestComposerFocus } from "@/lib/composer-focus"
import { setContinuationInProgress } from "@/lib/continue-in-agent-block"
import { sessionLinkUri } from "@/lib/session-link"
import {
  saveConfigPreference,
  saveModePreference,
} from "@/lib/selector-prefs-storage"
import type { AgentType, DbConversationSummary } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  groupOfTab,
  useTabStore,
  type OpenedDraftTarget,
} from "@/stores/tab-store"

/**
 * "Continue in another agent…": hand a session's work to a new session on
 * another agent (or the same one with another model). A session cannot change
 * its agent in place — each keeps its own native history — so:
 *
 * 1. the old session's agent writes a handoff: the backend sends it a fixed
 *    prompt as an ordinary visible message and answers with the turn's final
 *    text (`acp::continuation`). When that fails, codeg can write a plain one
 *    itself (the session's first message, folder, branch, `git status` and
 *    its link);
 * 2. a new-session draft opens beside the old tab, in the same folder (and
 *    worktree), on the chosen agent with the chosen model and effort; its
 *    composer holds a line linking the old session, then the handoff — not
 *    sent, so the person reads it first;
 * 3. when that draft is sent and becomes a conversation, its row records the
 *    old one (`continued_from_id`), which draws the banners linking the two.
 *
 * The new agent can read more of the old session itself: the link is a
 * `codeg://session/<id>?server=<instance>` reference, which
 * `get_session_info` resolves.
 */

// ── When it can run: see `lib/continue-in-agent-block.ts` ──────────────────

export {
  continueInAgentBlock,
  setContinuationInProgress,
  type ContinuableConversation,
  type ContinueInAgentBlock,
} from "@/lib/continue-in-agent-block"

// ── What the new composer starts with ──────────────────────────────────────

/** Collapse whitespace and escape what would break out of `[...]` link
 *  text, as the composer's own references do. */
function linkText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_~[\]()<>]/g, "\\$&")
}

/**
 * The new session's composer text: one line linking the old session, then
 * the handoff. The line is for the new agent (it goes out with the message),
 * so it is not translated, like the handoff prompt itself.
 */
export function buildContinuationPrefill({
  title,
  conversationId,
  agentLabel,
  handoff,
}: {
  /** The old session's title (already falling back to "Untitled…"). */
  title: string
  conversationId: number
  /** The old session's agent, by name. */
  agentLabel: string
  handoff: string
}): string {
  const name = linkText(title) || `Session ${conversationId}`
  const line = `Continuing [${name}](${sessionLinkUri(conversationId)}) from ${agentLabel}.`
  const body = handoff.trim()
  return body ? `${line}\n\n${body}` : line
}

// ── Running it ─────────────────────────────────────────────────────────────

/** The mode and config values picked for the new session. */
export interface ContinuationPicks {
  modeId: string | null
  configValues: Record<string, string>
}

/** How the handoff went, as the dialog shows it. */
export type HandoffResult =
  | { ok: true; text: string }
  | {
      ok: false
      kind: NonNullable<ContinuationHandoff["failure"]>["kind"] | "request"
      message: string | null
    }

/**
 * Ask the session's agent for its handoff. Resolves either way: a failed
 * request (the server gone, a timeout) is a failure like any other, so the
 * dialog offers the plain handoff for it too.
 */
export async function writeHandoff(
  conversationId: number,
  request: (
    id: number
  ) => Promise<ContinuationHandoff> = requestContinuationHandoff
): Promise<HandoffResult> {
  setContinuationInProgress(conversationId, true)
  try {
    const outcome = await request(conversationId)
    const text = outcome.text?.trim()
    if (text) return { ok: true, text }
    return {
      ok: false,
      kind: outcome.failure?.kind ?? "empty",
      message: outcome.failure?.message ?? null,
    }
  } catch (err) {
    return { ok: false, kind: "request", message: errorText(err) }
  } finally {
    setContinuationInProgress(conversationId, false)
  }
}

function errorText(err: unknown): string | null {
  if (typeof err === "string") return err
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message
    if (typeof message === "string") return message
  }
  return null
}

/** The plain handoff codeg writes itself ("Continue without a summary"). */
export function writeMechanicalHandoff(
  conversationId: number,
  build: (id: number) => Promise<string> = buildMechanicalHandoff
): Promise<string> {
  return build(conversationId)
}

/** Where the new session's tab goes: beside the old session's tab, in its
 *  group, when it is open; else wherever a new session would. */
export function continuationPlacement(conversationId: number): {
  targetGroup?: string
  index?: number
} {
  const { rawTabs, groupOf, groupLayout } = useTabStore.getState()
  const anchor = rawTabs.find((tab) => tab.conversationId === conversationId)
  if (!anchor) return {}
  const targetGroup = groupOfTab(groupOf, groupLayout, anchor.id)
  // The group's own draft, if it has one, is the tab that will be used (one
  // draft per group); it moves to the slot, which is counted without it.
  const draft = rawTabs.find(
    (tab) =>
      tab.conversationId == null &&
      groupOfTab(groupOf, groupLayout, tab.id) === targetGroup
  )
  const slots = draft ? rawTabs.filter((tab) => tab !== draft) : rawTabs
  return { targetGroup, index: slots.indexOf(anchor) + 1 }
}

export interface OpenContinuationDeps {
  openNewConversationTab: (
    folderId: number,
    workingDir: string,
    options: { targetGroup?: string; index?: number; forceAgent: AgentType }
  ) => OpenedDraftTarget
  placement?: (conversationId: number) => {
    targetGroup?: string
    index?: number
  }
  folderPath?: (folderId: number) => string | undefined
  park?: typeof parkComposerPrefill
  parkLink?: typeof parkContinuationLink
  savePicks?: (agentType: AgentType, picks: ContinuationPicks) => void
  focusComposer?: () => void
}

/** Save the dialog's picks as the agent's own, which is what a new session's
 *  connect starts from — the same as picking them in a new-session draft. */
function saveAgentPicks(agentType: AgentType, picks: ContinuationPicks): void {
  for (const [configId, value] of Object.entries(picks.configValues)) {
    saveConfigPreference(agentType, configId, value)
  }
  if (picks.modeId) {
    saveModePreference(agentType, {
      current_mode_id: picks.modeId,
      available_modes: [],
    })
  }
}

/**
 * Open the new session: a draft on `agentType` beside the old session's tab,
 * in the old session's folder and working directory, whose composer holds
 * the line linking the old session and the handoff (not sent), with the
 * keyboard in it. The draft remembers what it continues until it is sent.
 */
export function openContinuation(
  {
    source,
    sourceTitle,
    sourceAgentLabel,
    agentType,
    picks,
    handoff,
  }: {
    source: Pick<
      DbConversationSummary,
      "id" | "folder_id" | "working_dir" | "origin_cwd"
    >
    sourceTitle: string
    sourceAgentLabel: string
    agentType: AgentType
    picks: ContinuationPicks
    handoff: string
  },
  deps: OpenContinuationDeps
): OpenedDraftTarget {
  const savePicks = deps.savePicks ?? saveAgentPicks
  const park = deps.park ?? parkComposerPrefill
  const parkLink = deps.parkLink ?? parkContinuationLink
  const placement = (deps.placement ?? continuationPlacement)(source.id)
  const folderPath =
    deps.folderPath ??
    ((id: number) =>
      useAppWorkspaceStore.getState().allFolders.find((f) => f.id === id)?.path)
  const workingDir =
    source.working_dir ?? folderPath(source.folder_id) ?? source.origin_cwd

  // Before the draft exists, so its connect already starts from them.
  savePicks(agentType, picks)
  ;(deps.focusComposer ?? requestComposerFocus)()
  const opened = deps.openNewConversationTab(
    source.folder_id,
    workingDir ?? "",
    {
      ...(placement.targetGroup != null
        ? { targetGroup: placement.targetGroup }
        : {}),
      ...(placement.index != null ? { index: placement.index } : {}),
      forceAgent: agentType,
    }
  )
  park(opened.tabId, {
    text: buildContinuationPrefill({
      title: sourceTitle,
      conversationId: source.id,
      agentLabel: sourceAgentLabel,
      handoff,
    }),
    agentType: opened.agentType,
    folderId: opened.folderId,
  })
  parkLink(opened.tabId, source.id)
  return opened
}
