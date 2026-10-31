import type { ContentBlock, MessageTurn, UserMessageBlock } from "@/lib/types"

/**
 * Widen the lean `UserMessageBlock`s the backend broadcasts into the
 * `ContentBlock`s a rendered turn holds.
 *
 * The backend deliberately narrows a user's prompt before putting it on the
 * wire (`user_blocks_from_prompt`): text and images pass through, an image-mime
 * embedded resource is promoted to an image, and every other resource collapses
 * to a markdown link so blob bytes never ship twice. Everything that survives
 * that projection is exactly a `ContentBlock`'s `text` or `image`, so this is a
 * total mapping with no lossy case left to decide.
 *
 * `uri` is null rather than absent because a broadcast image is carried by its
 * bytes — there is no path to name, and `extractUserImagesFromBlocks` derives
 * the display name from the mime type in that case.
 *
 * Shared by both surfaces that turn a broadcast into a user turn: a viewer's
 * `user_message` echo, and a mid-turn steered message adopted into the live
 * transcript. They must agree — the same message reaching the transcript by the
 * two routes has to render identically.
 */
export function contentBlocksFromUserMessage(
  blocks: UserMessageBlock[]
): ContentBlock[] {
  return blocks.map((b) =>
    b.type === "image"
      ? { type: "image", data: b.data, mime_type: b.mime_type, uri: null }
      : { type: "text", text: b.text }
  )
}

/**
 * A user `MessageTurn` from a broadcast `user_message` (the live event, or a
 * snapshot's `pending_user_message`), for a cross-client VIEWER to render the
 * sender's prompt. The turn `id` is the broadcast `message_id` so the runtime
 * reducer can dedup it idempotently. A message spoken through the phone's Talk
 * mode stays marked as spoken, so its mic marker shows before any reload.
 */
export function buildUserTurnFromMessageBlocks(
  messageId: string,
  blocks: UserMessageBlock[],
  spoken?: boolean
): MessageTurn {
  return {
    id: messageId,
    role: "user",
    blocks: contentBlocksFromUserMessage(blocks),
    timestamp: new Date().toISOString(),
    ...(spoken ? { spoken: true } : {}),
  }
}
