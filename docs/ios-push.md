# iPhone push notifications

codeg sends its notifications to an iPhone through Apple Push Notification
service (APNs). The codeg backend (the desktop app, or `codeg-server`) talks to
APNs itself, signed with your team's `.p8` auth key. There is no relay server.

This page covers:

1. [Creating the key in App Store Connect](#1-the-apns-key)
2. [The settings in codeg](#2-settings)
3. [When codeg pushes](#3-when-codeg-pushes)
4. [Registering a device (iOS client)](#4-registering-a-device)
5. [The payload contract (iOS client)](#5-payload-contract)
6. [Notification actions (iOS client)](#6-notification-actions)
7. [Presence: who counts as "looking"](#7-presence)
8. [Testing against a mock APNs](#8-testing-without-apple)
9. [What waits on the user: the pending list and reminders](#9-pending-items)

## 1. The APNs key

One key serves every app of a team, in both APNs environments.

1. Sign in to [developer.apple.com](https://developer.apple.com/account) with
   the team that owns the app.
2. Go to **Certificates, Identifiers & Profiles › Keys**, and click **+**.
3. Name it (for example "codeg push"), tick **Apple Push Notifications service
   (APNs)**, and click **Configure**:
   - Environment: **Sandbox & Production**.
   - Key restriction: **Team Scoped (All Topics)**.
4. **Continue › Register › Download.** The file is
   `AuthKey_<KEYID>.p8`. Apple lets you download it **once**: keep a copy
   somewhere safe.
5. Note the **Key ID** (on the key's page, and in the file name) and the
   **Team ID** (top right of the developer site, or **Membership details**).

The app needs the **Push Notifications** capability on its App ID
(**Identifiers › your app › Capabilities**); Xcode adds it when you enable the
capability in the target.

For this setup:

| Field | Value |
|---|---|
| Team ID | `3L92BZK46V` |
| Key ID | `3Y8TW4TVF2` (team scoped, all topics, sandbox and production) |
| Bundle ID / APNs topic | `io.ashurov.codeg` (app "Codeg Plus", App Store Connect id 6818623057) |
| Environment | **Production** for TestFlight builds, **Sandbox** for Xcode debug builds |

## 2. Settings

**Settings › General › iPhone push** (next to the other notification
settings). The settings belong to the backend that sends: in a browser on a
`codeg-server`, you edit that server's settings.

| Field | What it is |
|---|---|
| Team ID | 10 characters. |
| Key ID | 10 characters. |
| Bundle ID | The iOS app's bundle id. It is the default `apns-topic`. A device can register with its own. |
| Environment | For a device that registers without saying which. **Production** for TestFlight and App Store builds, **Sandbox** for builds run from Xcode. |
| .p8 key | Paste the file's contents or choose the file. It is checked (it must be a P-256 PKCS#8 key) and stored in the backend's keychain as `secret:apns-auth-key`: the OS keyring on desktop, the 0600 `tokens.json` in `CODEG_DATA_DIR` on a server. It is never logged and never sent back to a client. Leave the box empty to keep the stored key. **Remove key** deletes it. |

Under the settings:

- **Send test push** sends a test notification to every registered device,
  regardless of preferences. It reports Apple's answer for each device and
  explains the common configuration mistakes:
  - `InvalidProviderToken`: the Team ID, Key ID and key don't belong together.
  - `DeviceTokenNotForTopic`: the bundle ID is wrong.
  - `BadDeviceToken` or `410`: the device is removed.
- **Devices** lists every registered device (name, environment, token tail,
  last seen). Each device has a **Remove** button and its own preferences:

  | Preference | Options | Default |
  |---|---|---|
  | Turn finished | Always / Only when away / Off | Only when away |
  | Needs you | Always / Only when away / Off | Only when away |
  | Critical alerts | On / Off | On |
  | Errors | On / Off | Off |

  **Away** means that no codeg window on a desktop or in a browser is visible,
  focused and in use (see [presence](#7-presence)). Whatever the preferences
  say, nothing is pushed about a session that someone is looking at right now.

  **Reminders** of something still waiting for an answer (see
  [pending items](#9-pending-items)) are "needs you" pushes that read "Only
  when away" as "Always": they go to the phone while you sit at the desk on
  another session. "Off" still means off. The silent badge updates go to
  every device.

The notifications are worded in the app language in use when the settings were
last saved, the same wording as the desktop notifications.

Settings API (all behind the usual token auth; `POST /api/<name>` on a server,
a command of the same name on desktop):

| Command | Body | Returns |
|---|---|---|
| `get_push_settings` | none | `{team_id, key_id, bundle_id, environment, language, has_key, key_error, server_id, configured}` |
| `update_push_settings` | `{settings: {team_id, key_id, bundle_id, environment, language}, authKey?}`. Omit `authKey` to keep the key, `""` removes it, PEM text replaces it. | the same view |
| `list_push_devices` | none | `[device]` |
| `update_push_device_prefs` | `{id, prefs}` | `device` |
| `unregister_push_device` | `{id}` or `{token}` | `true` if a row was removed |
| `send_test_push` | `{deviceId?}` | `[{device_id, name, ok, error, removed}]` |

## 3. When codeg pushes

The same moments the desktop raises a system notification, read from the
backend's event bus, so they fire with no window open:

| Event | Push `kind` | Notification |
|---|---|---|
| A turn ends normally (`end_turn`) | `turn_finished` | "Claude Code has finished responding" |
| A permission request | `needs_you`, `needs: "permission"` | "Claude Code: Agent requests permission to continue this turn." |
| `ask_user_question` | `needs_you`, `needs: "question"` | "Claude Code is waiting for your answer" |
| A plan waiting for approval | `needs_you`, `needs: "plan"` | "Claude Code: The agent has a plan — review it" |
| An error that breaks the session | `error` | "Claude Code error: …" |
| A critical session alert, the first and every repeat | `critical` | "⚑ Critical session needs you: <session>" |

The title is the session's title, or "<folder> - Codeg" when it has none.
When the title is the session's, the body starts with the folder name.

Bursts collapse: one push per kind per session every 3 s. A turn that ends
within 10 s of an error pushed for its session is not also reported as
finished. Sessions of delegated sub-agents don't push their turns; their
parent session does.

The three "needs you" rows come from the pending list (section 9), which also
sends:

| When | Push |
|---|---|
| A delegated sub-agent asks (a question, a permission, a plan) | `needs_you`, filed under the parent session (`conversation_id` is the parent, `asking_conversation_id` the sub-agent) |
| The user leaves the desk (presence flips to away) with items the phone never heard of (asked while they were at the desk) | `needs_you`, `attempt: 0`, at once |
| An item still waits at a reminder time (5 min, 30 min, 2 h after the ask, then every 4 h, by default) | `needs_you`, `reminder: true`, `attempt: n` |
| The number of waiting items changes and a device did not get the new count with a push | badge-only (`kind: "badge"`), silent |

The body of a "needs you" push ends with what is asked, on its own line: the
question, the tool call's title (a permission), or the plan's first line.
A reminder says how long the agent has waited: "Claude Code is still waiting
for your answer (30 min)".

Critical alerts are de-duplicated with the chat channels. An alert that reached
an iPhone is not also sent to Telegram (or another channel), unless "Also send
to chat channels" is on in the critical session settings.

## 4. Registering a device

After `UIApplication.registerForRemoteNotifications()` succeeds, send the token
to the codeg server, with the same base URL and bearer token the app already
uses:

```http
POST /api/register_push_device
Authorization: Bearer <codeg token>
Content-Type: application/json

{
  "token": "a1b2c3…",                // the device token, hex (from the Data)
  "environment": "production",       // "sandbox" for a debug build from Xcode
  "bundleId": "io.ashurov.codeg",    // optional, default: the settings' bundle id
  "name": "Jonathan's iPhone",       // optional, shown in Settings
  "platform": "ios"                  // optional
}
```

The response is `{"device": {…}, "server_id": "…"}`. Register on every launch:
the call is an upsert by token, so it refreshes "last seen" and keeps the
preferences the user set. Keep `server_id`; every notification carries it (see
below).

When the user signs out of a server, send `POST /api/unregister_push_device`
with `{"token": "…"}`.

The app can read and change its own preferences with `list_push_devices` and
`update_push_device_prefs` (`{"id": …, "prefs": {"turn_finished": "away",
"needs_you": "always", "critical": true, "errors": false}}`).

The environment must match the build. A TestFlight or App Store build gets
production tokens; a debug build run from Xcode gets sandbox tokens. A
production token sent to the sandbox host (or the reverse) fails with
`BadDeviceToken`, and the device is removed.

## 5. Payload contract

Every notification is an `alert` push (`apns-push-type: alert`,
`apns-priority: 10`) to `apns-topic` = the device's bundle id.

Headers:

| Header | Value |
|---|---|
| `apns-collapse-id` | `<server_id>-c<conversation_id>`. A newer notification about the same session replaces the one still in Notification Center. Test pushes use `<server_id>-test`. |
| `apns-expiration` | now + 1 h (a test push: `0`, delivered now or never) |

Body:

```json
{
  "aps": {
    "alert": { "title": "Fix the login bug", "body": "codeg · Claude Code has finished responding" },
    "sound": "default",
    "thread-id": "<server_id>-42",
    "category": "CODEG_SESSION",
    "interruption-level": "active"
  },
  "server_id": "3f9c0a1b2c4d",
  "kind": "turn_finished",
  "alert_id": "9a8b…",
  "conversation_id": 42,
  "folder_id": 7,
  "agent_type": "claude_code"
}
```

`aps` fields:

| Field | Value |
|---|---|
| `alert.title`, `alert.body` | Already localized. Title ≤ 120 characters, body ≤ 600. |
| `sound` | `"default"`. Absent for a critical alert when the critical-session tone is off. |
| `thread-id` | `<server_id>-<conversation_id>`: one group per session in Notification Center. |
| `category` | `CODEG_CRITICAL`, `CODEG_PERMISSION`, `CODEG_QUESTION` or `CODEG_SESSION` (see actions). |
| `interruption-level` | `time-sensitive` for `critical` and `needs_you` (reminders included), else `active`. The app needs the **Time Sensitive Notifications** capability for it to break through Focus. |
| `badge` | On every push: how many items wait on the user across all sessions (`0` clears the icon badge). |
| `mutable-content` | `1` on `CODEG_QUESTION` pushes, so a Notification Service Extension can add the answer buttons (see actions). |

Custom fields (top level):

| Field | Always | Meaning |
|---|---|---|
| `server_id` | yes | The codeg server that sent it (`get_push_settings` and the registration return it). An app connected to several servers uses it to pick the connection. |
| `kind` | yes | `turn_finished`, `needs_you`, `error`, `critical`, `test` |
| `alert_id` | yes | Unique per notification. For `critical` it is the alert's own id (the same `id` as the in-app `app://critical-session-alert` event). |
| `conversation_id` | session pushes | The session to open. |
| `folder_id` | session pushes | Its workspace folder. |
| `agent_type` | session pushes | Stored agent id (`claude_code`, `codex`, `pi`, …). |
| `critical_kind` | `critical` | `idle`, `needs_you`, `interrupted`, `stalled`, `background_stalled` |
| `needs` | `needs_you` | `permission`, `question`, `plan` |
| `connection_id`, `request_id` | `needs: permission` | The pending permission request. |
| `approve_option_id` | `needs: permission`, when the request has one | Its "allow once" option (else the first "allow" option). |
| `deny_option_id` | `needs: permission`, when the request has one | Its "reject once" option. |
| `pending_id` | `needs_you` | The item's id in `list_pending_items`: deep-link to it. |
| `pending_kind` | `needs_you` | `permission`, `question` or `plan`. A plan gate that arrives as a permission request (Claude Code's ExitPlanMode, Codex's plan review) is `pending_kind: "plan"` with `needs: "permission"` and the permission fields. |
| `pending_since` | `needs_you` | When the session started waiting (RFC 3339, UTC). |
| `reminder` | `needs_you` | `false` for the first push and the catch-up, `true` for a reminder. |
| `attempt` | `needs_you` | `0` for the first push and the catch-up; `n` for the n-th reminder. |
| `connection_id` | `needs_you` | The connection the item is on (questions and plans too). |
| `asking_conversation_id` | a delegated sub-agent's item | The sub-agent's session; `conversation_id` is the parent to open. |
| `question` | `needs: question` | The first question of the set: `{question_id, item_id, text, header, multi_select, options, count, answerable}`. `options` are the full labels. `answerable` is true for one single-choice question whose labels all fit a button (60 characters). |
| `approval_id` | `needs: plan` (Grok) | The plan approval waiting for a decision. |

A question reminder, for example:

```json
{
  "aps": {
    "alert": {
      "title": "Fix the login bug",
      "body": "codeg · Claude Code is still waiting for your answer (30 min)\nWhich database should we use?"
    },
    "sound": "default",
    "thread-id": "<server_id>-42",
    "category": "CODEG_QUESTION",
    "interruption-level": "time-sensitive",
    "badge": 2,
    "mutable-content": 1
  },
  "server_id": "3f9c0a1b2c4d",
  "kind": "needs_you",
  "alert_id": "9a8b…",
  "conversation_id": 42,
  "folder_id": 7,
  "agent_type": "claude_code",
  "needs": "question",
  "pending_id": "question:5e0f…",
  "pending_kind": "question",
  "pending_since": "2026-10-26T09:00:00Z",
  "reminder": true,
  "attempt": 2,
  "connection_id": "c41d…",
  "question": {
    "question_id": "5e0f…",
    "item_id": "a17c…",
    "text": "Which database should we use?",
    "header": "Storage",
    "multi_select": false,
    "options": ["SQLite", "Postgres"],
    "count": 1,
    "answerable": true
  }
}
```

A badge-only update is silent: no alert, no sound, no category.

```json
{ "aps": { "badge": 1 }, "server_id": "3f9c0a1b2c4d", "kind": "badge", "alert_id": "…" }
```

Its `apns-collapse-id` is `<server_id>-badge`, so it never replaces a
notification on screen.

## 6. Notification actions

The app registers these `UNNotificationCategory`s. The server only names them.

| Category | Actions |
|---|---|
| `CODEG_CRITICAL` | `ACK`, `SNOOZE`, `OPEN` |
| `CODEG_PERMISSION` | `APPROVE`, `OPEN` |
| `CODEG_QUESTION` | `OPEN`, plus `ANSWER_<i>` per option (see below) |
| `CODEG_SESSION` | `OPEN` |

Each action calls an existing endpoint with fields from the payload. Mark
`ACK`, `SNOOZE` and `APPROVE` as background actions (`UNNotificationAction`
without `.foreground`), and mark `APPROVE` `.authenticationRequired`:

| Action | Call | Body |
|---|---|---|
| `ACK` | `POST /api/ack_critical_session` | `{"conversationId": conversation_id}` |
| `SNOOZE` | `POST /api/snooze_critical_session` | `{"conversationId": conversation_id, "minutes": 15}` (1 to 1440) |
| `APPROVE` | `POST /api/acp_respond_permission` | `{"connectionId": connection_id, "requestId": request_id, "optionId": approve_option_id}` |
| `OPEN` (and a tap) | none | Open the session `conversation_id` in folder `folder_id`, on the server `server_id`. Opening a critical session in the app should also send `ack_critical_session`, like the desktop does. |

If the permission was already answered elsewhere, or its connection is gone,
`acp_respond_permission` fails. Show "already handled" and open the session.

**Answering a question from the notification.** Action titles are fixed when
a category is registered, so the buttons come from a Notification Service
Extension: for a push with `question.answerable`, it registers (or reuses) a
category such as `CODEG_QUESTION.<hash of the labels>` with one action per
option (`ANSWER_0`, `ANSWER_1`, …, titled with the labels, background,
`.authenticationRequired`), adds it with `setNotificationCategories`, and sets
the content's `categoryIdentifier` to it. Without the extension, or when the
question is not `answerable`, the push keeps `CODEG_QUESTION` and a tap opens
the session. `ANSWER_<i>` calls:

```http
POST /api/acp_answer_question
{"connectionId": connection_id,
 "questionId": question.question_id,
 "answer": {"answers": [{"questionId": question.item_id, "labels": [question.options[i]]}], "declined": false}}
```

A question already answered (on the desktop, or by another device) fails the
same way a handled permission does.

**Deep links.** `pending_id` names the item; open `conversation_id` (the
parent of a delegated sub-agent) in `folder_id`, where the waiting card sits
above the composer. The app can read the whole list with `list_pending_items`
(section 9), and refresh its icon badge from `count` when it comes to the
foreground.

## 7. Presence

The backend decides who is looking from what each client reports. An open
connection alone means nothing: a phone in a pocket, a sleeping laptop whose
socket never closed, and a background tab all hold one.

- A client counts as **looking** only while its latest report is less than
  90 s old, says `visible` and `focused`, and `idle_secs` (plus the report's
  age) is under 10 minutes.
- **Anyone looking** (the opposite of away) counts desktop and web windows
  only. iOS clients never count: the phone is where alerts go when the user is
  away.
- **Looking at a session** counts every client, iOS included. Nothing is pushed
  about that session.
- The critical alerts' chat-channel fallback goes out when nobody is looking
  and no iPhone took the alert, or always with "also send to chat channels".

How clients report:

- Event WebSocket (`/ws/events`): send
  `{"action":"presence","visible":true,"focused":true,"idle_secs":0,"conversation_ids":[42]}`
  on connect, on every change, and at least every 30 s. Every field is
  optional; a missing one reads as `false`, `0` or `[]`.
- An iOS client declares itself by adding the subprotocol `codeg-client.ios`
  next to `codeg-events` (and the `codeg-token.…` one). It should report
  `visible`/`focused` true while the scene is active and showing a session,
  and false when it moves to the background.
- The desktop app's own windows report through the `report_client_presence`
  command (same fields, as `{presence: {…}}`).

## 8. Testing without Apple

`CODEG_APNS_BASE_URL` replaces both APNs hosts (for example
`http://127.0.0.1:9799`). Over plain `http://` the client speaks HTTP/1.1, so a
small echo server is enough to see the exact requests: the path is
`/3/device/<token>`, and the headers and body are as described above. Answer
`200` to accept, `410 {"reason":"Unregistered"}` to see the device removed, or
`403 {"reason":"InvalidProviderToken"}` to see the test-push error.

Every send is logged under `[push]` with the device id, the token's last 8
characters, Apple's status and reason, and the `apns-id`. The key and the
provider token are never logged.

`CODEG_REMINDER_SCHEDULE` shortens the reminder schedule for a test run:
`5,10,20/30` reminds 5, 10 and 20 seconds after the ask, then every 30 s. It
is not saved and not shown in the settings. Reminders are logged under
`[pending]`.

## 9. Pending items

The backend keeps one list of everything waiting on the user, across all
sessions:

- a permission request (a tool call parked on allow / reject);
- a question: codeg's `ask_user_question` (codeg-mcp), an agent's own ask
  (Codex `request_user_input`, Pi's select, an MCP elicitation);
- a plan waiting for approval: Claude Code's ExitPlanMode and Codex's plan
  review (both permission requests), Grok's `exit_plan_mode`;
- the same from a delegated sub-agent, filed under its parent session.

An item is on the list exactly while its session holds it: answering it on
any device, cancelling the turn, the agent giving up or its process ending
all take it off, and its reminders stop with it. The bookkeeping (when it was
asked, whether a phone heard of it, which reminders went out) is stored, so
when an agent asks the same thing again after codeg restarts (an
auto-resumed turn), the item keeps its age and its reminders, and the phone is
not told twice.

**Reminders** (Settings › General › Reminders, stored by the backend):

| Setting | Default |
|---|---|
| Remind me | on |
| Remind after | 5 min, 30 min, 2 h (counted from the ask) |
| Then every | 4 h |
| Quiet hours | off (22:00 to 07:00 in the time zone of the device that saved them) |

Each reminder is an iPhone push and a desktop notification (one per machine,
honouring the desktop notifications' switch, permission and "hide contents").
A reminder due while someone looks at that session is skipped; one due in the
quiet hours waits for their end; several due at once (the machine slept) go
out as one, the latest.

The desktop shows the count on the dock icon and as "Waiting for you (N)" in
the sidebar header; its list gives each item's age, and a click opens the
session. A browser shows the same list (and the count on the app badge of an
installed web app).

API (token auth; `POST /api/<name>` on a server, a command on desktop):

| Command | Body | Returns |
|---|---|---|
| `list_pending_items` | none | `{items: [item], count}`, oldest first |
| `get_pending_reminder_settings` | none | `{enabled, steps_secs, repeat_secs, quiet_hours, quiet_start_min, quiet_end_min, timezone}` |
| `update_pending_reminder_settings` | `{settings: {…}}` | the stored settings |

An item: `{id, kind, source, conversation_id, root_conversation_id,
folder_id, folder_name, title, agent_type, agent_label, connection_id,
request_id, asked_at, text, options: [{id, label, kind?}], question?:
{item_id, header, multi_select, count, secret?}, queued, reminders_sent,
last_reminded_at, next_reminder_at, phone_notified}`. `secret` (present only
when true) marks an answer the card masks; never ask for it as plain text.
`source` says how to answer it: `permission` (`acp_respond_permission`,
`requestId`, an option's `id`), `question` (`acp_answer_question`,
`questionId` = `request_id`, a label), `plan_approval`
(`acp_answer_plan_approval`, `approvalId` = `request_id`). Open
`root_conversation_id`.

The macOS desktop app answers the same way from its own notifications
(first notification and reminders): Allow / Deny (plus the "always" variants
a request offers), a plan's Approve, one button per option of a single
single-choice question and a typed reply, each sent to the backend of the
window that raised the notification. It checks the item is still listed
first, and opens the session with a notice when it is not.

Events on the event WebSocket: `app://pending-items` (the list changed; the
whole `{items, count}`) and `app://pending-reminder` (`{id, attempt, item}`:
a reminder is due; `id` is unique per firing).
