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
   * Parser id of the reply right before the message — where the session forks
   * — or `null` when the message opens the conversation, in which case the
   * edit starts a new conversation instead.
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
