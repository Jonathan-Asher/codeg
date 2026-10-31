# codeg-talk

Talk on the Mac: the iPhone's hands-free Hebrew voice conversation, run by a
helper process of the codeg desktop app. One process runs the whole voice
loop of one Talk:

- the microphone and the spoken replies share **one `AVAudioEngine` with
  macOS voice processing**, which gives echo cancellation its reference, so
  you can interrupt by talking over the reply on speakers;
- the iPhone's Talk logic, vendored unchanged: the reducer, end-of-turn and
  barge-in policies, speech text, router, spoken prompts, feed, controller and
  sentence speaker (`Sources/TalkCore/Vendor`);
- the iPhone's engines: Silero voice detection and whisper (whisper.cpp), the
  ivrit.ai streaming Zipformer (sherpa-onnx), Smart Turn (shadow mode) and the
  BlueTTS voice.

The window that owns the Talk drives the session (local sessions and sessions
on the box alike); codeg's Rust side only spawns the helper and relays its JSON
lines to and from that window. See `docs/talk-mode.md` for the feature.

macOS 15+, Apple Silicon only (whisper.framework and sherpa-onnx's macOS slice
are arm64). Separate from `codeg-tts`: Talk's engines are arm64-only while the
voice helper is universal, the microphone stays in its own process, and the
helper plays its audio itself.

## Package

| target | what |
|---|---|
| `TalkCore` | the vendored iPhone files, compiled as one module (Swift 5 mode), plus `Shim/` |
| `TalkHost` | `Wire` (the protocol), `MirrorPort` (the session mirror behind the controller's synchronous `TalkSessionPort`), `BridgeBackend` (`TalkBackend` over the wire), `UIStatePublisher`, `MacEchoPolicy`. No engine dependencies. |
| `TalkEngines` | `MacTalkAudioEngine` (`TalkAudioIO`), `CoreAudioRoute`, `MacMicTap`, `MacTalkSystem`, the BlueTTS and system-voice synthesizers, the engine cache; vendored adapters (`Vendor/`) |
| `codeg-talk` | the executable |

The vendored files keep Swift's default (internal) access; the other targets
reach them through testable imports, so the library targets are compiled with
`-enable-testing` in release too, and TalkEngines imports TalkCore into every
file (`-testable-import-module`), as the app's single module does.

```sh
swift build -c release --product codeg-talk --triple arm64-apple-macosx15.0   # what prepare-sidecars.mjs runs
swift test                     # TalkHost: wire fixtures, mirror, requests, echo policy, routes, channel 0
scripts/test-core.sh           # the vendored iPhone Talk tests, on macOS without Xcode
scripts/sync-from-ios.sh --check
```

## Vendoring

`scripts/sync-from-ios.sh --commit <ref>` copies codeg-ios's
`CodegiOS/Features/Talk/Core/` (every file), the models and support files Talk
needs, and the engine packages (`../SherpaOnnx`, `../SmartTurn`,
`../WhisperCpp`, `../ExceptionCatcher`) at a pinned commit, read with
`git show` (the iOS checkout is never touched). It writes `vendor.lock`: the
commit and the sha256 and source of every vendored file. `--check` verifies
them. Vendored files are never edited here: change them in codeg-ios, then
re-sync. `native/BlueTTSKit/Package.swift` is byte-identical to codeg-ios's
(the `OnnxRuntime` product SherpaOnnx and SmartTurn link against).

## Launch

```sh
codeg-talk [--espeak-data DIR] [--idle-exit SECONDS]
codeg-talk --probe      # one JSON line, exit 0
codeg-talk --version
```

`--probe` prints `{"arm64":true,"macos":"26.6.2","mic":"undetermined","protocol":1,"version":"1.0.0","whisperLoads":true}`:
the macOS version, whether it runs natively on Apple Silicon, whether
whisper.cpp loaded (the framework linked and answered), and the microphone
permission (`granted`, `denied`, `undetermined`). It never asks for the
microphone. Built for an Intel or universal target, codeg ships a stub with
the same probe (`"arm64":false`) that refuses to start.

The process loads the engines on its first `start` and keeps them loaded
across Talks; it exits 2 minutes (`--idle-exit`) after the last Talk ended,
or when stdin closes. Diagnostics go to stderr.

The microphone permission is asked with `AVCaptureDevice.requestAccess(for: .audio)`
when a Talk starts and it is undetermined. Spawned by codeg.app, macOS
attributes the helper to codeg (its responsible process) and shows codeg's
`NSMicrophoneUsageDescription` (`src-tauri/Info.plist`).

## Protocol (version 1)

JSON lines, UTF-8, one object per line, every object with a `type`. The
window writes to the helper's stdin (through Rust, which adds `models` to
`start`); the helper writes to stdout. **Envelope fields are camelCase.
Server records inside a message (`MessageTurn`, `PendingItem`, a pending
permission, question or plan approval) are passed exactly as the server
sends them, snake_case**; the helper reads them as the iPhone does. Both sides
ignore unknown types and fields. `fixtures/protocol/` has one example of every
message (`to-helper.*`, `to-window.*`); the helper's tests decode and encode
every one.

### Window → helper

| type | fields |
|---|---|
| `start` | `protocol` (1), `conversationId`, `title`, `folder`?, `settings` (the server's Talk settings `{language, address}`), `prefs`, `voice` `{name, speed}` (read aloud's voice), `port` (the full port, below), `live` (the turn in progress or null), `items` (the server's pending items), `models` (added by Rust), `app` `{version, build, bundleId}` |
| `port` | the port fields that changed; a card set to `null` is gone |
| `live` | `turnId`, `text`, `streaming`: the live turn's main-thread text (the iPhone's `mainThreadText`), sent when it changed |
| `turnEnded` | `turnId`, `stopReason` (`end_turn`, …, `cancelled`, `error`, or null when the reply landed while disconnected); once per turn, after its final `live` |
| `awaiting` | `value`: the turn is held open only for background work |
| `bgTurns` | `turns`: turns the agent wrote outside a turn (upserted by id) |
| `items` | `items`: the server's pending list (the helper keeps this conversation's sub-agents' items) |
| `res` | `id`, `ok`, `value`?, `error`?: the answer to a `req` |
| `control` | `op`: `toggleMute` (the Mute button), `softMute` `{value}` (still listens for "unmute"/"end"), `skip`, `tapOrb`, `press` `{down}` (push to talk; the global shortcut held), `cancelPress`, `choose` `{choiceId}`, `reportCutOff`, `setHandsFree` `{value}`, `repeatLast` |
| `settings` | `settings`: the server's Talk settings changed (they apply from the next Talk) |
| `prefs` | `prefs`: the window's Talk prefs changed (`handsFree` applies now, the rest from the next Talk) |
| `end` | end the Talk |

**port**: `title`, `canInsertIntoTurn`, `isInFlight`, `awaitingBackground`,
`backgroundOutstanding`, `pendingPermission` (the server's
`PendingPermissionState`: `request_id`, `tool_call`, `options` …),
`pendingQuestion` (`PendingQuestionState`: `question_id`, `questions` …),
`pendingPlanApproval` (`PendingPlanApprovalState`: `approval_id`,
`plan_markdown` …).

**prefs**: `handsFree` (true), `patience` (`short`/`normal`/`long`),
`interruptBySpeaking` (true), `speakProgress` (false), `smartTurnActive`
(false), `echoMode` (`automatic`/`voiceProcessing`/`off`), `shareTelemetry`
(true).

**models**: `zipformer` `{encoder, decoder, joiner, tokens}`, `vad`,
`smartTurn` (required), `whisper`, `languageID` (optional: the more accurate
final transcript), `bluetts` (BlueTTSKit's model directory; null: the system
voices speak), `espeakData` (null: looked up next to the helper, as codeg-tts
does). Absolute paths.

`start` fills the helper's session mirror, then starts the controller. Setting
the controller as the mirror's observer replays it as on the iPhone: the live
turn counts as heard (not spoken), the background hold is noted, waiting cards
are asked. A `start` while a Talk runs replaces it (`ended` `replaced` first).

### Helper → window

| type | fields |
|---|---|
| `hello` | `protocol`, `version`, `mic`: first line after launch. Another protocol: Talk unsupported. |
| `state` | what the dock shows (below); at most 20 a second, the last of a burst always sent |
| `level` | `in`, `out` (0…1): microphone and speech levels, 15 a second while they move |
| `req` | `id`, `op` and its fields; answered with `res` of the same `id` within 20 s, or it counts as failed |
| `cmd` | `op`: `cancel` (stop the agent's turn, as the stop button) |
| `flags` | `keepsStreamAttached` (keep the event stream attached while idle), `isTalking` (presence `talking`), `holdSession` (keep the session open): all three, when any changes |
| `ended` | `reason` (`ended`, `failed`, `replaced`), `error`: the Talk let go of the microphone |
| `error` | `message`: a line the helper couldn't use |

**req ops** and their answers (`res.value`):

| op | fields | answer |
|---|---|---|
| `sendSpoken` | `text` | `prompt` (sent as a prompt), `insert` (into the running turn), `queued`; mark the message spoken |
| `respondPermission` | `requestId`, `optionId` | `ok` |
| `answerQuestion` | `questionId`, `answer` `{answers: [{questionId, labels}], declined}` | `ok` |
| `declineQuestion` | `questionId` | `ok` |
| `answerPlanApproval` | `approvalId`, `decision` (`approve`/`request_changes`/`abandon`), `feedback` | `ok` |
| `setTalkMode` | `enabled` | `ok` (on the session's own backend) |
| `fetchSettings` | | `{language, address}` or null |
| `respondItem` | `item` `{itemId, connectionId, requestId, conversationId}`, `optionId` | `ok` |
| `answerItem` | `item`, `answer` | `ok` |
| `answerItemPlan` | `item`, `decision`, `feedback` | `ok` |
| `uploadReport` | `report` (a `talk_lab` report object) | `ok`; post `{"report": report}` to `report_client_diagnostic` |

`ok: false` (with `error`) or a value of `false` is a failure; Talk says it
didn't work and asks again where it can.

**state**: `status` (`starting`, `listening`, `hearing`, `thinking`,
`working`, `speaking`, `asking`, `confirmingCancel`, `paused`, `ended`,
`failed`), `pauseReason`, `error`, `title`, `heard`, `heardFinal`, `spoken`
(`[{id, text}]`, the last 20), `current` (the id playing), `ask` (`{id, kind,
prompt, choices: [{id, label}], multiSelect, acceptsOwnWords, isSecret,
answerableByVoice}` or null), `mute` (`none`/`soft`/`hard`), `handsFree`,
`backgroundOutstanding`, `awaitingBackground`, `fastMode`, `naturalVoice`,
`canReportCutOff`, `route` (`builtIn`, `bluetoothHFP`, `wired` = headphones,
`other`), `echo` (`voiceProcessing`/`none`), `speaksHebrew`, `mic`,
`suggestHeadphones` (speakers without echo cancellation: talking over the
reply can't interrupt it).

A crash of the helper, or a reload of the owning page, is reported to the
window as `ended` by Rust.

## Audio

- A fresh `AVAudioEngine` for every start and rebuild; the speech and earcon
  players are attached before `inputNode.setVoiceProcessingEnabled(true)`;
  other apps' audio is ducked as little as voice processing allows; voice
  processing is turned off before the engine stops.
- The route comes from Core Audio: the transport type of the default input
  and output devices (and the built-in output's data source, speakers or
  headphones). Default-device listeners and `AVAudioEngineConfigurationChange`
  rebuild the engine 150 ms after a change, and the sentence being said
  starts again.
- `MacEchoPolicy`: a built-in or USB microphone with speakers gets voice
  processing; a Bluetooth microphone or headphone output gets none. When
  voice processing fails to start, Talk goes on without it; on speakers the
  microphone is then not heard while Talk speaks (talking over the reply
  can't interrupt it) and the dock suggests headphones.
- `MacMicTap`: channel 0 of the input (with voice processing the input can
  have several channels), then the iPhone's `MicrophoneConverter`, then
  16 kHz frames of 512 samples. Mute drops frames at the tap and sets
  `isVoiceProcessingInputMuted`.
- The Mac is kept awake while Talk runs (`ProcessInfo.beginActivity`).

## Licensing

- `TalkHost`, `TalkEngines` and the executable's sources: MIT, like codeg.
  The vendored files are codeg-ios's.
- The binary links **BlueTTSEspeak, i.e. espeak-ng (GPL-3.0-or-later)**, so
  the `codeg-talk` executable as built is GPL-3.0-or-later, like codeg-tts. It
  is a separate program codeg talks to over a pipe. **Keep `native/` and the
  helper out of anything sent upstream.**
- Models are downloaded by codeg, never bundled: the streaming Zipformer
  (zipformer2-66m-streaming-he by Yakov Kolani, CC-BY-4.0, mirrored by
  ivrit.ai; attribution in `THIRD_PARTY_NOTICES.md`), Silero VAD (MIT),
  Smart Turn v3.2 (BSD-2-Clause), whisper he-turbo (ivrit.ai, Apache-2.0),
  BlueTTS 2.5 (no stated licence, so never bundled).
- whisper.cpp (MIT, `whisper.framework` from its release), sherpa-onnx
  (Apache-2.0), ONNX Runtime (MIT).
