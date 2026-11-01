/**
 * What a Talk's requests need from the session's own backend: the window's
 * transport (this Mac's backend for a local session, the remote server for a
 * session shown in a remote-workspace window). Talk's tuning report goes
 * there too, like the phone's.
 */

import {
  acpAnswerPlanApproval,
  acpAnswerQuestion,
  acpRespondPermission,
  getTalkSettings,
} from "@/lib/api"
import { setTalkMode } from "@/lib/talk-mode"
import { getTransport } from "@/lib/transport"
import type { TalkBridgeBackend } from "./bridge"

export const sessionBackend: TalkBridgeBackend = {
  setTalkMode: (conversationId, enabled) =>
    setTalkMode(conversationId, enabled),
  // An older server has no Talk settings: the helper uses its defaults.
  fetchSettings: () => getTalkSettings().catch(() => null),
  respondItem: (item, optionId) =>
    acpRespondPermission(item.connectionId, item.requestId, optionId),
  answerItem: (item, answer) =>
    acpAnswerQuestion(item.connectionId, item.requestId, answer),
  answerItemPlan: (item, decision, feedback) =>
    acpAnswerPlanApproval(item.connectionId, item.requestId, {
      decision,
      feedback,
    }),
  uploadReport: async (report) => {
    await getTransport().call("report_client_diagnostic", { report })
  },
}
