import { buildQuotedMarkdown } from "@/lib/message-quote"
import type { AvailableCommandInfo } from "@/lib/types"

/**
 * Side questions — Claude Code's `/btw`, asked from codeg's composer.
 *
 * `/btw <question>` asks the session a question it answers from its current
 * context, with no tools, while a turn runs or between turns. Neither the
 * question nor the answer enters the transcript or the message queue, and the
 * running turn goes on. `/btw` alone reopens the answers. The backend keeps
 * the exchanges per conversation and sends the newest ones along with the
 * next question, so a follow-up builds on them (`acp::side_question`).
 *
 * Offered only on a session whose adapter answers side questions (codeg's own
 * claude-agent-acp build advertises it), so the composer adds the command to
 * its `/` menu itself: the agent does not list it.
 */

/** The command's name, as typed after the `/`. */
export const SIDE_QUESTION_COMMAND = "btw"

/** What the composer's text asks for: a side question (`question` is empty
 *  for a bare `/btw`, which reopens the answers), or `null` for anything else.
 *  Only a leading `/btw`, alone or followed by whitespace, counts: `/btwx` and
 *  a `/btw` in the middle of a message are ordinary text. */
export function parseSideQuestionCommand(
  text: string
): { question: string } | null {
  const match = /^\s*\/btw(?:\s+([\s\S]*))?$/.exec(text)
  if (!match) return null
  return { question: (match[1] ?? "").trim() }
}

/** The `/` menu's commands with the side question added in front. An agent
 *  that lists a `btw` of its own loses it: on these sessions the entry is
 *  codeg's, and it never reaches the agent as a prompt. */
export function withSideQuestionCommand(
  commands: readonly AvailableCommandInfo[] | null | undefined,
  entry: AvailableCommandInfo
): AvailableCommandInfo[] {
  return [
    entry,
    ...(commands ?? []).filter(
      (command) => command.name !== SIDE_QUESTION_COMMAND
    ),
  ]
}

/**
 * The message "Continue in a fork" puts in the forked conversation's
 * composer: the side question and its answer, quoted, then an empty line for
 * the user's next words. It goes to the agent, so it is not localized — the
 * same as the other prompts codeg writes for the user.
 */
export function sideQuestionForkPrompt(
  question: string,
  answer: string | null
): string {
  const parts = [
    "Earlier I asked you a side question:",
    buildQuotedMarkdown(question),
  ]
  const quotedAnswer = answer ? buildQuotedMarkdown(answer) : ""
  if (quotedAnswer) parts.push("Your answer:", quotedAnswer)
  return `${parts.join("\n\n")}\n\n`
}
