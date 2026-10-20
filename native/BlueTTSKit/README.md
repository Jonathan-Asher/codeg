# BlueTTSKit

On-device Hebrew + English text-to-speech for Apple platforms: a Swift port of
the BlueTTS 2.5 + RenikudPlus pipeline (Python reference: `Light-BlueTTS` at
`0e38dbf`, `renikud-plus` 0.5.0, `phonemizer` + espeak-ng 1.52.0), with
automatic `<en>…</en>` tagging of Latin and code spans.

- Platforms: iOS 26+, macOS 15+. Swift 6 language mode, Swift tools 6.0.
- Runtime: ONNX Runtime 1.30.0, CPU execution provider.
- Model files are not bundled; `scripts/fetch-models.sh` downloads them (~575 MB).

## Products

| product | license | what |
|---|---|---|
| `BlueTTSKit` | MIT | Normalizer, `<en>` auto-tagger, RenikudPlus G2P, BlueTTS synthesis, `EnglishPhonemizer` protocol |
| `BlueTTSEspeak` | GPL-3.0-or-later | espeak-ng 1.52.0 compiled from source plus its English data (~0.8 MB), as `EspeakPhonemizer` |
| `bluetts-cli` | MIT | macOS benchmarking / listening-pack tool; not for the app |

## Usage

```swift
import BlueTTSKit
import BlueTTSEspeak   // GPL-3, see Licensing

let tts = BlueTTS(modelDirectory: modelsURL,               // layout below
                  englishPhonemizer: try EspeakPhonemizer())
try await tts.load()                                        // optional; loads lazily otherwise

// One pass: Float32 PCM, 44.1 kHz mono.
let audio = try await tts.synthesize("עדכנתי את ה-Dockerfile ודחפתי ל-main.")
// audio.samples: [Float], audio.sampleRate: 44100

// Sentence by sentence: the first chunk arrives after one sentence of work.
for try await chunk in tts.synthesizeStream(longText) {
    player.enqueue(chunk.samples, sampleRate: chunk.sampleRate)
}

// Options: voice, speed, flow steps, CFG, seed, normalization, tagging.
var o = SynthesisOptions()
o.voice = "noa"        // any voices/<name>.json
o.speed = 1.1
o.seed = 1234          // same seed as np.random.seed in Python gives the same audio
let a2 = try await tts.synthesize(text, options: o)

// Inspect the text front end (tagging, normalization, phonemes, chunks).
let fe = try await tts.phonemize(text)
```

### Public API

- `BlueTTS(modelDirectory:englishPhonemizer:configuration:)` and `BlueTTS(paths:…)`: loads lazily and is thread-safe. All inference runs on one serial background queue, never on the caller's executor.
- `func load() async throws`: loads the four BlueTTS graphs, RenikudPlus and the default voice now.
- `func synthesize(_:options:) async throws -> AudioBuffer`: the same chunking and slow-span handling as Python's `BlueTTS.synthesize`. It splits phonemes into ≤300-character chunks and peak-limits the whole utterance at 0.95.
- `func synthesizeStream(_:options:firstChunkMaxChars:) -> AsyncThrowingStream<AudioChunk, Error>`: works one source sentence at a time. A long first sentence is cut at a comma. Each chunk is peak-limited on its own, and cancelling the consuming task stops the work.
- `func phonemize(_:options:) async throws -> PhonemizationResult`: runs the front end only.
- `func availableVoices() -> [String]`
- `SynthesisOptions`: `voice`, `speed` (1.0), `totalSteps` (5), `cfgScale` (4.0), `silenceBetweenChunks` (0), `paceBlend` / `paceDptRef`, `peakLimit` (0.95), `normalizeText`, `autoTagEnglish`, `language` (`.auto` / `.hebrew` / `.english`), `seed`.
- `BlueTTSConfiguration`: `threads` (default `min(8, cores)`, as in Python), per-graph `ExecutionProvider` (`.cpu` / `.coreML`), and `defaultVoice` (`"noa"`).
- `protocol EnglishPhonemizer { func phonemize(_ text: String) throws -> String }`: the plug-in point for `<en>` spans. `PunctuationPreserver` (a port of phonemizer's punctuation handling) is public so other backends can reuse it.
- `EnglishAutoTagger.tag(_:)` and `TextNormalizer.prepareTextForSynthesis(_:lang:markSlow:)` are public as well.

## Model files

Not bundled. Fetch them, pinned and checksummed:

```sh
scripts/fetch-models.sh /path/to/models          # downloads, verifies sha256
scripts/fetch-models.sh /path/to/models --verify # check only
```

Layout `BlueTTS(modelDirectory:)` expects (sizes from the pinned revisions):

```
models/                                   574 MB total
  bluetts/                                263 MB  notmax123/BlueTTS2.5-onnx @ 468da64
    vector_estimator.onnx                 132.5 MB
    vocoder.onnx                          101.4 MB
    text_encoder.onnx                      27.4 MB
    duration_predictor_style.onnx           1.5 MB
    uncond.npz  stats.npz  vocab.json  tts.json
  renikud/
    model_int8.onnx                       311.6 MB  notmax123/RenikudPlus @ 679c56c
  voices/                                 ~0.3 MB each  maxmelichov/Light-BlueTTS @ 0e38dbf
    noa.json  adam.json  daniel.json  lily.json
```

`scripts/models.sha256` lists every file's sha256 and source URL. The app needs
about 575 MB on disk plus ~0.8 MB of espeak-ng data, which ships inside
`BlueTTSEspeak` as a resource bundle.

## Pipeline

The steps are the same as the Python reference, in this order:

1. **Auto-tagging** (`EnglishAutoTagger`, new; the spike placed tags by hand). Runs of Latin letters/digits joined by `._/-` (also `://`, `C++`, `C#`, and apostrophes between Latin letters), separated by spaces, become `<en>…</en>`. Bare numbers stay Hebrew. An apostrophe or geresh after a Hebrew letter stays Hebrew (`בראנץ'`, `ג'וני`), and typographic `’` there is folded to `'`. E-mail addresses and existing tags are left alone. Text with no Hebrew letter is synthesized as English, untagged, like the spike's English texts.
2. **Normalization** (`TextNormalizer`, a port of `text_norm.py` with `num2words` he/en): numbers, dates, clock times, percentages, ratios, phone numbers, e-mails, alphanumeric codes, list markers, brackets, quotes, Hebrew abbreviation marks, and `【…】` slow spans.
3. **G2P.** Hebrew goes through RenikudPlus (`RenikudG2P`), a port of `renikud_onnx`: the hebrew-num2words front end, grapheme normalization, niqqud strip/use, windowing, the exact-MAP cascade decode, IPA rendering, and `vocalize`. English goes to the `EnglishPhonemizer`, with the routing ported from `TextProcessor`.
4. **Synthesis** (`BlueSynthesizer`, a port of `TextToSpeech._infer`): `UnicodeProcessor` tokens, the duration predictor (style vector), the text encoder, the vector estimator over N flow steps with classifier-free guidance from `uncond.npz`, the latent de-normalization and un-shuffle, the vocoder, and the edge trim.

Not ported: RenikudPlus's attested-reading rescorer and force lexicon. They only switch on with a `datastore.json` beside the model, which the Hugging Face repo does not ship and the spike did not use. `RenikudG2P` refuses to start if one is present, so this gap can never change output silently.

## Parity and tests

Run `swift test`. The model-dependent suites look for `BLUETTS_MODEL_DIR` (README layout) and fall back to `/tmp/tts-spike`; they are skipped when neither exists.

`scripts/golden/make_golden.py` regenerates `Tests/BlueTTSKitTests/Golden` from the Python reference venv. `scripts/golden/cases.py` holds the inputs: the 10 spike texts and 23 extra sentences covering numbers, dates, times, prefixes, code terms, an e-mail, a phone number and a geresh word.

| check | result |
|---|---|
| Front end, Swift on plain text vs Python on hand-tagged text (normalized text, every segment's phonemes, chunks) | 33 / 33 |
| Token ids fed to the acoustic model | 33 / 33 |
| The spike's logged phoneme lines | 10 / 10 |
| Auto-tagger vs the hand-placed tags | 30 / 30 |
| RenikudPlus extra sentences, IPA and niqqud | 15 / 15 and 15 / 15 |
| espeak-ng English terms | 52 / 52 |
| Normalizer cases / num2words values | 17 / 17, 56 / 56 |
| Seeded synthesis vs Python (same seed) | same length; max \|diff\| ≈ 2 LSB at 16 bit, r > 0.9999 |

### Measurements (16 GB M1, CPU, 8 threads, 2026-10-02)

Python and Swift ran alternately for 4 rounds on a busy box (load average 12–76). The full numbers and the listening pack are in `out/`, which is gitignored and regenerated with `bluetts-cli bench`.

| | Python reference | Swift |
|---|---|---|
| Load + first call | 1.2–2.2 s | 1.3–2.4 s |
| Median RTF (best of 4 per text) / 30 s text | 0.148 / 0.135 | 0.151 / 0.138 |
| Peak RSS | 880–928 MB | 856–893 MB |
| Hebrew words heard (whisper, of 134) | mean 124.8 | mean 124.5 |
| English code terms clear, of 29 | mean 20.6 | mean 20.3 |
| Streaming: first chunk | n/a | median 0.75–1.07 s per run, worst 1.32–1.51 s |

`synthesizeStream` phonemizes per sentence, so RenikudPlus loses cross-sentence context. In the golden set this changed 1 word in 45 segments (באייפון: `baʔˈajfon` → `beʔˈajfon`).

### ONNX Runtime version

The official `microsoft/onnxruntime-swift-package-manager` stops at 1.24.2. Under 1.24.2 the int8 RenikudPlus graph flips three near-tie words against the 1.30.0 reference, and Python on 1.24.2 makes the same three flips:

- האימג' `haʔˈimedʒ` instead of `haʔimˈadʒ`
- הפונקציה `fˈunktsija` instead of `fˈunktsja`
- מילישניות `milʃnijˈot` instead of `miliʃnijˈot`

The package therefore uses the official 1.30.0 CocoaPods C/C++ archive, the same artifact the SPM repo wraps, with its Objective-C bindings vendored unchanged from `microsoft/onnxruntime` v1.30.0 (MIT). Once the official SPM repo tags 1.30, switch back to it.

## CoreML

Probed on this M1 with ORT 1.30's CoreML EP. Keep everything on CPU:

| graph | MLProgram | NeuralNetwork |
|---|---|---|
| duration predictor | the EP aborts the process (ORT logging bug), so it is pinned to CPU | same |
| text encoder (449 nodes) | fails to build the execution plan | runs, 54 partitions, slower than CPU |
| vector estimator (1007 nodes) | fails to build the execution plan | runs, 129 partitions, RTF 0.67 vs 0.29 on CPU |
| vocoder (141 nodes) | rejects the unbounded `latent` dimension | runs, 34 partitions, slower |
| RenikudPlus int8 (1755 nodes) | init exception | runs, 200 partitions, slower |

Making ANE/GPU worthwhile needs static-shape exports (length buckets) or a coremltools conversion of the vector estimator and vocoder. That is future work.

## Licensing

- BlueTTSKit sources: MIT. Light-BlueTTS (the pipeline this ports): MIT. renikud-plus: MIT, and the RenikudPlus weights are Apache-2.0.
- **BlueTTS 2.5 weights** (`notmax123/BlueTTS2.5-onnx`): the model card declares no license. Confirm with the author before any public release.
- ONNX Runtime: MIT.
- **espeak-ng: GPL-3.0-or-later.** It lives only in the `BlueTTSEspeak` product. An app that links it must ship under GPL-3-compatible terms. That is fine for a personal TestFlight build, but an App Store release needs either GPL compliance or a different `EnglishPhonemizer` (for example a CMU-dictionary + rules backend). The protocol exists so it can be swapped without touching the rest.
- ucd-tools (inside espeak-ng): GPL-3.0-or-later. The `compat/endian.h` shim: public domain.

## Building

```sh
swift build -c release
swift test
.build/release/bluetts-cli synth --models /path/to/models --text "שלום, זו בדיקה." --out a.wav
.build/release/bluetts-cli bench --models /path/to/models --cases cases.json --outdir out/
```

For iOS, `xcodebuild -scheme BlueTTSEspeak -destination 'generic/platform=iOS' build` succeeds with Xcode 27 (iPhoneOS 27.0 SDK). It has not been run on a device yet.
