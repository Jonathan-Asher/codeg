import { isLiveTurnId } from "@/stores/conversation-runtime-store"
import type {
  AgentType,
  ContentBlock,
  MessageTurn,
  PromptCapabilitiesInfo,
  PromptDraft,
  PromptInputBlock,
} from "@/lib/types"

/**
 * "Edit message": rewrite a past user message and continue the conversation
 * from there with the new text.
 *
 * Built on "Fork from here". The reply right BEFORE the message is the fork
 * point, so the forked session ends exactly where the message was, and the
 * edited text is then sent there as an ordinary prompt. The conversation's row
 * moves to the forked session; the original branch stays in the sidebar as a
 * row of its own. Only the conversation branches — files the agent changed
 * after that point stay changed.
 *
 * A conversation's first message has no reply before it, so editing it starts
 * a new conversation on the same agent instead.
 */

/**
 * Agents whose adapter forks EXACTLY at a named reply or refuses. Pi's adapter
 * resolves a fork point too, but falls back to the tail when it misses — and a
 * tail fork still holds the message being replaced, so the edit would quietly
 * continue the original conversation. Mirrors `honours_fork_point_strictly` in
 * `acp/fork.rs`, which refuses an edit fork for any other agent anyway.
 */
const EDITABLE_AGENTS: ReadonlySet<AgentType> = new Set<AgentType>([
  "claude_code",
  "codex",
  "deepseek",
])

/** Whether messages in a conversation with this agent can be edited. */
export function supportsMessageEdit(agentType: AgentType): boolean {
  return EDITABLE_AGENTS.has(agentType)
}

/** What the transcript asks its host to do when an edit is saved. */
export interface UserMessageEditRequest {
  /**
   * Id of the reply right before the message — where the session forks — or
   * `null` when the message opens the conversation, in which case the edit
   * starts a new conversation instead.
   *
   * The parser's id where the reply has one. A reply streamed in this session
   * may still carry only its `live-…` id — see {@link resolveEditForkTurnId},
   * which the host runs to find the parser's id before forking.
   */
  forkFromTurnId: string | null
  /** The edited text. */
  text: string
  /** The message being edited, for the attachments it sends again. */
  sourceTurn: MessageTurn
}

type ImageBlock = Extract<ContentBlock, { type: "image" }>

function isImageBlock(block: ContentBlock): block is ImageBlock {
  return block.type === "image" && block.data.length > 0
}

/** The images a user message carries — sent again, unchanged, with its edit. */
function userMessageImages(turn: MessageTurn): ImageBlock[] {
  return turn.blocks.filter(isImageBlock)
}

/**
 * The text an edit starts from: the message's text blocks exactly as they
 * were sent. The composer sends one; a file mention rides inside it as an
 * inline `[label](uri)` link, which stays editable like any other text. Joined
 * the way the retry action reads a prompt (`lastUserPromptText`).
 */
export function editableUserMessageText(turn: MessageTurn): string {
  return turn.blocks
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim()
}

/** Text compared as a person reads it: runs of whitespace are one space. */
function comparableText(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/**
 * The reply an edit forks at, found in a freshly parsed transcript instead of
 * on screen — for a reply this session streamed that was never given the
 * parser's name (see {@link resolveEditForkTurnId}).
 *
 * The message is found by position: `userOrdinal` is its index among the user
 * turns on screen, which line up one for one with the user turns of a parse
 * read from the same starting turn. Its text has to match too: if anything
 * shifted the count — a command the transcript keeps out of its turns, a turn
 * not written yet — the edit fails rather than forking somewhere else.
 *
 * The fork point is then the turn right before the message, stepping over
 * empty ones: the LAST turn of the reply before it. Anything other than a
 * reply there (another message, a system note) has no clean point to fork at
 * — the rule `computeUserEditTargets` applies on screen. `null` when the
 * message or its reply can't be found.
 */
export function resolveEditForkPointInTranscript(
  turns: MessageTurn[],
  userOrdinal: number,
  messageText: string
): string | null {
  let userIndex = -1
  let usersSeen = 0
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role !== "user") continue
    if (usersSeen === userOrdinal) {
      userIndex = i
      break
    }
    usersSeen += 1
  }
  if (userIndex < 0) return null
  if (
    comparableText(editableUserMessageText(turns[userIndex])) !==
    comparableText(messageText)
  ) {
    return null
  }
  for (let i = userIndex - 1; i >= 0; i--) {
    if (turns[i].blocks.length === 0) continue
    return turns[i].role === "assistant" ? turns[i].id : null
  }
  return null
}

/**
 * The parser's id of the reply an edit forks at — the one the backend can
 * resolve.
 *
 * A reply streamed in this session is named `live-…` until the post-turn
 * reparse gives it the parser's name, and that reparse is cancelled when the
 * next reply lands first: a follow-up sent within seconds leaves the reply
 * before it unnamed for as long as the session is open (see
 * `computeTurnMetadataPatches`). Rather than wait on that, read the
 * transcript afresh — a full parse names every turn — and find the reply
 * there by the message's place among the user turns.
 *
 * `thread` is the settled turns on screen, in order; `readTranscript` returns
 * a fresh parse starting at the same turn the thread does. `null` when the
 * reply can't be found; a failed read rejects.
 */
export async function resolveEditForkTurnId({
  forkFromTurnId,
  message,
  thread,
  readTranscript,
}: {
  forkFromTurnId: string
  message: MessageTurn
  thread: MessageTurn[]
  readTranscript: () => Promise<MessageTurn[]>
}): Promise<string | null> {
  if (!isLiveTurnId(forkFromTurnId)) return forkFromTurnId
  const userOrdinal = thread
    .filter((turn) => turn.role === "user")
    .findIndex((turn) => turn.id === message.id)
  if (userOrdinal < 0) return null
  return resolveEditForkPointInTranscript(
    await readTranscript(),
    userOrdinal,
    editableUserMessageText(message)
  )
}

/**
 * The draft an edit sends: the edited text, then the original message's
 * images, in the order the composer builds a draft in (`buildDraft`). Each
 * image goes back out the way the composer would encode it for this agent — a
 * native `image` block, or the embedded-resource blob an agent that takes
 * embedded context but not images reads (`imageAttachmentToPromptBlock`).
 *
 * `null` when there is nothing to send: no text and no images.
 */
export function buildEditedMessageDraft(
  text: string,
  source: MessageTurn,
  caps?: Pick<PromptCapabilitiesInfo, "image" | "embedded_context"> | null
): PromptDraft | null {
  const trimmed = text.trim()
  const images = userMessageImages(source)
  if (!trimmed && images.length === 0) return null

  const embedImages = caps != null && !caps.image && caps.embedded_context
  const blocks: PromptInputBlock[] = trimmed
    ? [{ type: "text", text: trimmed }]
    : []
  images.forEach((image, index) => {
    blocks.push(
      embedImages
        ? {
            type: "resource",
            uri: image.uri ?? `clipboard://edited-image-${index + 1}`,
            mime_type: image.mime_type,
            text: null,
            blob: image.data,
          }
        : {
            type: "image",
            data: image.data,
            mime_type: image.mime_type,
            uri: image.uri ?? null,
          }
    )
  })
  return { blocks, displayText: trimmed }
}
