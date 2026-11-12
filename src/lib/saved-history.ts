import { exportConversationSavedHistory } from "@/lib/api"
import { parkComposerPrefill } from "@/lib/composer-prefill-handoff"
import type { AgentType, SavedHistoryExport } from "@/lib/types"

/**
 * What "Start a new session from this" puts in the new session's composer,
 * from the server's export of a session's saved text (see
 * `SavedHistoryExport`): the preamble with the text under it when the export
 * came back inline, or the preamble alone with the export's file attached
 * when it was too long to sit in a composer.
 *
 * The preambles come in already translated — one says the text follows, the
 * other that it is attached — so this stays a plain function of the export.
 */
export function buildSavedHistoryPrefill({
  exported,
  inlinePreamble,
  attachedPreamble,
}: {
  exported: SavedHistoryExport
  inlinePreamble: string
  attachedPreamble: string
}): { text: string; files?: string[] } {
  if (exported.path) {
    return { text: attachedPreamble, files: [exported.path] }
  }
  const body = exported.markdown?.trim()
  return { text: body ? `${inlinePreamble}\n\n${body}` : inlinePreamble }
}

/** Where the new session opens: what `openNewConversationTab` reports. */
interface OpenedDraft {
  tabId: string
  agentType: AgentType
  folderId: number
}

/**
 * "Start a new session from this", for a session whose history the agent
 * deleted: a new conversation on the same agent, in the same folder and
 * working directory, whose composer holds the preamble and the saved text.
 * Nothing is sent — the text is parked for the new draft's own composer (see
 * `composer-prefill-handoff.ts`), and waits there for the person.
 *
 * Exports first, so a failure leaves no half-made draft behind.
 */
export async function startSessionFromSavedHistory(
  {
    conversationId,
    folderId,
    workingDir,
    agentType,
    targetGroup,
    inlinePreamble,
    attachedPreamble,
  }: {
    conversationId: number
    folderId: number
    workingDir: string
    agentType: AgentType
    targetGroup?: string
    inlinePreamble: string
    attachedPreamble: string
  },
  deps: {
    openNewConversationTab: (
      folderId: number,
      workingDir: string,
      options: { targetGroup?: string; forceAgent: AgentType }
    ) => OpenedDraft
    exportSaved?: (conversationId: number) => Promise<SavedHistoryExport>
    park?: typeof parkComposerPrefill
  }
): Promise<OpenedDraft> {
  const exportSaved = deps.exportSaved ?? exportConversationSavedHistory
  const park = deps.park ?? parkComposerPrefill
  const exported = await exportSaved(conversationId)
  const target = deps.openNewConversationTab(folderId, workingDir, {
    ...(targetGroup != null ? { targetGroup } : {}),
    forceAgent: agentType,
  })
  park(target.tabId, {
    ...buildSavedHistoryPrefill({ exported, inlinePreamble, attachedPreamble }),
    agentType: target.agentType,
    folderId: target.folderId,
  })
  return target
}
