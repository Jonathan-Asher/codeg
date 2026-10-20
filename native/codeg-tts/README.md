# codeg-tts

The desktop app's natural voice: BlueTTS 2.5 + RenikudPlus, the same Swift
port (`../BlueTTSKit`) the codeg iPhone app reads replies with, run as a
long-lived sidecar of the codeg backend on macOS.

- One process per backend, started on the first read-aloud request. The
  models load once (`load`, sent right after start) and stay in memory
  (~0.9 GB) until the backend ends the process after 15 minutes without use.
- Text goes through BlueTTSKit's own front end: the automatic `<en>…</en>`
  tagging of Latin and code spans, the normalizer, RenikudPlus G2P and espeak-ng
  for English, exactly as on the iPhone.
- Audio streams back sentence by sentence as 16-bit PCM at 44.1 kHz.

The backend side is `src-tauri/src/tts/` (model download, process, streams);
see `docs/natural-tts.md` for the whole feature.

## Protocol (version 1)

Requests are one JSON object per line on stdin:

```json
{"op":"synthesize","id":7,"text":"עדכנתי את ה-Dockerfile.","voice":"noa","speed":1.0}
{"op":"cancel","id":7}
{"op":"load"}
{"op":"shutdown"}
```

Answers are frames on stdout: a one-line JSON header, then exactly `bytes` raw
bytes when the header has a `bytes` field (only `chunk` does):

```json
{"event":"ready","protocol":1,"sampleRate":44100,"voices":["adam","daniel","lily","noa"]}
{"event":"loaded","ms":506}
{"event":"chunk","id":7,"index":0,"sampleRate":44100,"format":"s16le","samples":89088,"bytes":178176,"final":false,"elapsedMs":609}
{"event":"done","id":7,"chunks":3,"cancelled":false,"audioMs":9100,"elapsedMs":1480,"firstChunkMs":609}
{"event":"error","id":7,"message":"voice x not found"}
```

Every `synthesize` ends with exactly one `done` (also after `cancel`, with
`cancelled: true`) or one `error` for its id. An `error` without an id is about
the process (no models directory, espeak-ng data missing). Closing stdin is the
same as `shutdown`. `speed` is clamped to 0.5–2.0, text is at most 20,000
characters, and voice names are plain file names (letters, digits, `-`, `_`).

```sh
codeg-tts --models DIR [--espeak-data DIR] [--voice noa] [--threads N]
codeg-tts --version
```

espeak-ng's English data is looked up next to the executable: inside codeg.app
(`Contents/Resources/tts/espeak-ng-data`, bundled by `tauri.macos.conf.json`),
beside a `tauri dev` binary, or in BlueTTSEspeak's resource bundle in a
`swift build` tree. `--espeak-data` or `CODEG_TTS_ESPEAK_DATA` override it.

## Building and testing

```sh
swift build -c release --product codeg-tts   # what prepare-sidecars.mjs runs
swift test                                    # CodegTTSCore: protocol, PCM, lookup
```

`src-tauri/scripts/prepare-sidecars.mjs` builds it for every macOS target and
stages it as `src-tauri/binaries/codeg-tts-<triple>`, the same way as
codeg-mcp; `CODEG_SKIP_TTS_SIDECAR=1` skips it (the app then reads aloud with
the system voices only). ONNX Runtime 1.30.0 is linked statically from the
official archive (download.onnxruntime.ai), so the binary depends on system
libraries only. The first build downloads that archive (~60 MB) and takes
about two minutes on an M4 Max; later builds are incremental.

## Licensing

- `CodegTTSCore` and the `codeg-tts` sources here: MIT, like BlueTTSKit.
- The binary links **BlueTTSEspeak, i.e. espeak-ng (GPL-3.0-or-later)**, so the
  `codeg-tts` executable as built is GPL-3.0-or-later, and so is the bundled
  `espeak-ng-data`. It is a separate program that codeg talks to over a pipe;
  the codeg app itself keeps its own licence. Fine for Jonathan's own builds.
  **Keep `native/` and the sidecar out of anything sent upstream**, and swap
  in a non-GPL `EnglishPhonemizer` before any public distribution.
- The BlueTTS 2.5 weights (`notmax123/BlueTTS2.5-onnx`) state no licence, so
  they are never bundled: the backend downloads them on request. RenikudPlus
  weights: Apache-2.0. ONNX Runtime: MIT.
