import { buildQuotedMarkdown } from "@/lib/message-quote"
import type { AgentType, AvailableCommandInfo, PromptDraft } from "@/lib/types"

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
 * claude-agent-acp and pi-acp builds advertise it), so the composer adds the
 * command to its `/` menu itself: the agent does not list it. Everywhere else a `/btw`
 * is still never a message: the composer keeps it and says the session can't
 * answer it, rather than sending it, queueing it or steering it into a turn.
 */

/** The command's name, as typed after the `/`. */
export const SIDE_QUESTION_COMMAND = "btw"

/** The agents codeg ships an adapter build for that answers side questions.
 *  Whether a session does is still the adapter's word once it has connected;
 *  before that, this tells "wait for the connection" from "this agent can't". */
const SIDE_QUESTION_AGENTS: ReadonlySet<AgentType> = new Set<AgentType>([
  "claude_code",
  "pi",
])

/** Whether a session of `agentType` can answer side questions once it has
 *  connected (see `SIDE_QUESTION_AGENTS`). */
export function mayAnswerSideQuestions(
  agentType: AgentType | null | undefined
): boolean {
  return agentType != null && SIDE_QUESTION_AGENTS.has(agentType)
}

/** What the composer's text asks for: a side question (`question` is empty
 *  for a bare `/btw`, which reopens the answers), or `null` for anything else.
 *  Only a leading `/btw`, alone or followed by whitespace, counts: `/btwx` and
 *  a `/btw` in the middle of a message are ordinary text. Any case counts
 *  (`/BTW`, `/Btw`): a capitalised one is still meant as the command, and as a
 *  prompt it would wait behind the running turn and stay in the transcript. */
export function parseSideQuestionCommand(
  text: string
): { question: string } | null {
  const match = /^\s*\/btw(?:\s+([\s\S]*))?$/i.exec(text)
  if (!match) return null
  return { question: (match[1] ?? "").trim() }
}

/** The side question a draft is, or `null`: its display text (the composer's
 *  own text) or, for a draft built elsewhere, its text blocks read as one.
 *  The last line of defence for the paths that send a draft rather than the
 *  composer's text — the queue, an insert into the running turn, an edited
 *  message — so a `/btw` that reached one never goes out as a prompt. */
export function sideQuestionOfDraft(
  draft: Pick<PromptDraft, "blocks" | "displayText">
): { question: string } | null {
  const fromDisplay = parseSideQuestionCommand(draft.displayText)
  if (fromDisplay) return fromDisplay
  const text = draft.blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
  return text ? parseSideQuestionCommand(text) : null
}

/** What a path that sends DRAFTS does with one that is a side question (see
 *  `sideQuestionOfDraft`): asks it where the session answers side questions,
 *  else hands its text back to be kept (the composer, with a notice). True
 *  when the draft was a side question, which then goes nowhere else — not out
 *  as a prompt, not into the queue, not into the running turn. */
export function divertSideQuestionDraft(
  draft: Pick<PromptDraft, "blocks" | "displayText">,
  handlers: {
    supported: boolean
    ask: (question: string) => void
    keep: (text: string) => void
  }
): boolean {
  const command = sideQuestionOfDraft(draft)
  if (!command) return false
  if (handlers.supported) handlers.ask(command.question)
  else handlers.keep(draft.displayText)
  return true
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
