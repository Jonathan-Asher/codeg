# Natural read-aloud voice

Read aloud (Settings › General › Read aloud) can speak with the same voice as
the codeg iPhone app: BlueTTS 2.5 with RenikudPlus G2P, which reads Hebrew and
English code terms in one natural voice, with `<en>…</en>` tagging of Latin and
code spans. The macOS system voices stay as the other engine and as the
fallback.

This is fork-only. The sidecar links espeak-ng (GPL-3.0-or-later); see
[Licensing](#licensing) before anything here goes upstream.

## How it fits together

```
 webview (desktop app / remote-workspace window / browser)
   src/lib/read-aloud/player.ts         engine choice, queue, pause/stop, fallback
   src/lib/read-aloud/natural-player.ts paragraph → tts_speak → tts_poll → Web Audio
        │  getShellTransport(): Tauri invoke, or fetch to the page's own server
        ▼
 backend  src-tauri/src/tts/            models, sidecar process, audio streams
        │  stdin: JSON requests   stdout: JSON headers + 16-bit PCM
        ▼
 codeg-tts (Swift, native/codeg-tts)    BlueTTSKit: tagging, normalizer, G2P, ONNX
```

- **Sidecar.** `codeg-tts` ships next to `codeg` in `codeg.app/Contents/MacOS`
  (Tauri `externalBin`, macOS only, `tauri.macos.conf.json`), with espeak-ng's
  English data in `Contents/Resources/tts/espeak-ng-data`. The backend starts it
  on the first read, sends `load` at once (warm start: the models load while
  the first sentence waits), and keeps it until 15 minutes pass without a
  request. One process serves the whole backend: the desktop's own window,
  remote-workspace windows and browsers on its web service share it.
- **Streaming.** The client reads a reply one paragraph at a time:
  `tts_speak` returns a stream id, `tts_poll` waits up to 10 s for new chunks
  (base64 16-bit PCM, one per sentence; a long first sentence is cut at a
  comma so speech starts sooner) and says when the stream is done, `tts_cancel`
  stops it. The same three calls work over Tauri `invoke` and HTTP, so desktop
  and browser share one code path. Chunks are scheduled back to back on one
  Web Audio clock; Pause suspends that clock, so nothing is cut or repeated.
- **Text.** The reply is prepared exactly as for the system voices
  (`speech-text.ts`, which follows the iPhone's `SpeechText`: Markdown
  stripped, fenced code skipped, paths and long snippets dropped, links read as
  their text). The paragraphs go to BlueTTSKit as they are; its own auto-tagger
  adds the `<en>` tags, the same code the iPhone runs.
- **Fallback.** If the natural voice fails (sidecar gone, models deleted
  elsewhere, audio output blocked before any click), the audio already queued
  plays out and the system voices read on from the paragraph that failed, with
  a toast saying so.

## Where the voice is made

On the machine whose speakers play it, wherever that is possible:

| Client | Synthesizes on | Why |
|---|---|---|
| Desktop app | this Mac | `invoke` reaches the local backend. |
| Remote-workspace window on the Mac | this Mac, not the remote box | It runs inside the Mac's own app; the TTS calls go through `getShellTransport()` (the local Tauri transport), never the remote transport the window's other API calls use. |
| Browser (codeg-server or a desktop app's web service) | that server | A page can only reach its own server. |

The Settings row says which, and what it costs there, before anything is
downloaded.

## Cost

| | |
|---|---|
| Download | 13 files, 575,644,743 bytes (549 MiB), into `<data dir>/tts/bluetts-2.5/` |
| Memory | ~0.9 GB resident in `codeg-tts` while loaded; the process exits after 15 minutes idle |
| App bundle | + ~39 MB (`codeg-tts`, ONNX Runtime linked statically) + ~0.8 MB espeak-ng data |

Measured on the M4 Max, Developer-ID-signed bundle, through the backend's
`tts_speak`/`tts_poll` path (a four-sentence Hebrew/English reply, 14.3 s of
audio), 2026-10-20:

| | first audio | whole reply ready | RTF |
|---|---|---|---|
| first start of a new build (macOS checks the signature once, models load) | 0.9–2.7 s | 1.6–3.1 s | 0.11–0.22 |
| warm (engine running, as between replies) | 0.13–0.21 s | 0.55–0.97 s | 0.04–0.07 |
| restart after an idle shutdown | 0.83 s | 1.5 s | 0.10 |

The 16 GB M1 box measured RTF ~0.15 and a ~1 s first chunk in BlueTTSKit's own
benchmark; synthesis there has not been enabled.

Nothing is downloaded or started until the user presses Download (and, after
that, reads something). On a server this is the opt-in: a browser user who
downloads puts the 549 MiB on the server's disk, and reading uses the server's
memory and CPU. `CODEG_TTS=off` turns the natural voice off on a backend
entirely (status `unsupported: disabled`). Delete in Settings stops the sidecar
and removes the directory.

## The model pack

`src-tauri/src/tts/catalog.rs` pins the same files, revisions and sha256s as
the iPhone app's `VoiceModelStore.swift` (BlueTTSKit `scripts/models.sha256`):
BlueTTS 2.5 from `notmax123/BlueTTS2.5-onnx`, RenikudPlus from
`notmax123/RenikudPlus`, voices `noa` (default), `adam`, `daniel`, `lily` from
`maxmelichov/Light-BlueTTS`.

Each file downloads into `<file>.part`, hashed as it arrives, and is renamed into
place only when its checksum matches. An interrupted download resumes with an
HTTP range request (or restarts the file if the server ignores ranges), with
three tries per file. When all files are in place a `.complete` marker records
which catalog they satisfy; "installed" means that marker plus every file at
its size. `CODEG_TTS_CATALOG=/path/catalog.json` replaces the catalog (a
mirror, or a test pack); paths must stay inside the pack directory.

## API

All `POST /api/<command>` with the usual bearer token, or Tauri commands with
the same names and arguments.

| Command | Body | Returns |
|---|---|---|
| `tts_status` | – | `TtsStatus`: `supported`, `unsupportedReason` (`platform`, `sidecarMissing`, `disabled`), `installed`, `download` (`idle` / `downloading {bytesDone, bytesTotal}` / `failed {message}`), `packBytes`, `bytesOnDisk`, `modelsDir`, `voices`, `defaultVoice`, `engineRunning`, `engineLoaded` |
| `tts_download_models` | – | `TtsStatus` (starts the download in the background) |
| `tts_cancel_download` | – | `TtsStatus` (what arrived stays for the next try) |
| `tts_delete_models` | – | `TtsStatus` |
| `tts_speak` | `{text, voice?, speed?}` | `{streamId}` |
| `tts_poll` | `{streamId, waitMs?}` | `{chunks: [{index, sampleRate, pcm}], done, error, stats}` |
| `tts_cancel` | `{streamId}` | `null` |

`tts_speak` refuses with `configuration_missing` (`i18n_key: tts.notInstalled`)
before the download and `dependency_missing` (`tts.unsupported`) where the
backend can't run the sidecar. A stream nobody polls for 60 s is cancelled.
The sidecar's own protocol is in `native/codeg-tts/README.md`.

## Building

`pnpm tauri build` runs `prepare-sidecars.mjs`, which on macOS targets also
runs `swift build -c release --product codeg-tts` in `native/codeg-tts` and
stages the binary; the CI build runner and `local-release.sh` need nothing
else (Xcode's Swift toolchain is on the Mac; the first build downloads ONNX
Runtime 1.30.0, ~60 MB, from download.onnxruntime.ai). Linux and Windows builds
never see `codeg-tts`; `CODEG_SKIP_TTS_SIDECAR=1` skips it on a Mac.
`scripts/ci-devid-sign.sh` signs it like every other nested Mach-O
(`app.codeg.codeg-tts`).

`native/BlueTTSKit` is a copy of the BlueTTSKit package maintained in
Jonathan-Asher/codeg-ios (`Packages/BlueTTSKit`, itself a subtree of
codeg-voice). Update it from there; don't fork it here.

codeg-server installs don't ship `codeg-tts`. A Mac server can use it by
putting `codeg-tts` (and `espeak-ng-data/` beside it) next to `codeg-server`,
or by pointing `CODEG_TTS_BIN` at a `codeg.app`'s copy.

## Testing

- Rust: `cargo test --features test-utils --lib -- tts::` (protocol frames, the
  client's routing and cancel, the store's checksums, resume, restarts and
  delete against a local HTTP server, the service with a scripted sidecar).
- Swift: `swift test` in `native/codeg-tts`.
- Vitest: `src/lib/read-aloud/*natural*`, `player-natural.test.ts`,
  `read-aloud-settings.test.tsx`.
- Real models (ignored by default):
  `CODEG_TTS_E2E_DOWNLOAD_DIR=/tmp/m cargo test --features test-utils --lib -- --ignored tts::store::tests::real_pack_downloads_and_verifies`,
  then
  `CODEG_TTS_E2E_BIN=…/codeg.app/Contents/MacOS/codeg-tts CODEG_TTS_E2E_MODELS=/tmp/m CODEG_TTS_E2E_WAV=/tmp/sample.wav cargo test --features test-utils --lib -- --ignored --nocapture tts::tests::real_sidecar`
  prints first-chunk latency and RTF, cold and warm.

## Licensing

- `native/codeg-tts` and BlueTTSKit's own sources: MIT. ONNX Runtime: MIT.
- **espeak-ng and its data: GPL-3.0-or-later.** `codeg-tts` links it, so the
  sidecar binary and the bundled `espeak-ng-data` are GPL-3. The codeg app only
  talks to it over a pipe. That is fine for Jonathan's own builds; **none of
  this belongs in an upstream PR**, and a public release would need GPL
  compliance or a different `EnglishPhonemizer`.
- **BlueTTS 2.5 weights: no stated licence.** Never bundled, only downloaded
  on request. RenikudPlus weights: Apache-2.0.
