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
finished. Sessions of delegated sub-agents don't push; their parent session
does.

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
| `category` | `CODEG_CRITICAL`, `CODEG_PERMISSION` or `CODEG_SESSION` (see actions). |
| `interruption-level` | `time-sensitive` for `critical` and `needs_you`, else `active`. The app needs the **Time Sensitive Notifications** capability for it to break through Focus. |

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

## 6. Notification actions

The app registers these `UNNotificationCategory`s. The server only names them.

| Category | Actions |
|---|---|
| `CODEG_CRITICAL` | `ACK`, `SNOOZE`, `OPEN` |
| `CODEG_PERMISSION` | `APPROVE`, `OPEN` |
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
