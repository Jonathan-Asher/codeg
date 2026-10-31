# Third-party notices: codeg-talk

Talk on the Mac runs on these models and libraries. The models are downloaded
by codeg at runtime (with the sha256 values of codeg-ios's `stt-models.json`)
and are never bundled in the app.

## Models

- **`zipformer2-66m-streaming-he-{encoder,decoder,joiner}.int8.onnx` and
  `zipformer2-66m-streaming-he-tokens.txt`**: "zipformer2-66m-streaming-he"
  by Yakov Kolani
  (https://huggingface.co/thewh1teagle/zipformer2-66m-streaming-he),
  licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/),
  downloaded from ivrit.ai's mirror
  (https://huggingface.co/ivrit-ai/zipformer2-66m-streaming-he). The contents
  are unchanged; the files were renamed with the model's name in front. It is
  a fine-tune of icefall's streaming Zipformer (Apache-2.0) on ivrit.ai audio.
  Talk on the Mac uses it for the live Hebrew transcript.
- **`smart-turn-v3.2-cpu.onnx`**: Smart Turn v3.2
  (https://huggingface.co/pipecat-ai/smart-turn-v3), unchanged, BSD-2-Clause,
  Copyright (c) 2024–2025, Daily. Its encoder is OpenAI's Whisper Tiny (MIT).
- **`ggml-silero-v5.1.2.bin`**: Silero VAD v5.1.2 as converted by ggml-org
  (https://huggingface.co/ggml-org/whisper-vad), MIT.
- **`ggml-ivrit-large-v3-turbo-q8_0.bin`**: ivrit.ai's Hebrew fine-tune of
  whisper large-v3-turbo (https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ggml),
  Apache-2.0, quantized to q8_0 with whisper.cpp.
- **`ggml-tiny-q8_0.bin`**: OpenAI whisper tiny in whisper.cpp's ggml format,
  MIT.
- **BlueTTS 2.5** (`notmax123/BlueTTS2.5-onnx`): no stated licence; never
  bundled, downloaded on request (see `docs/natural-tts.md`). RenikudPlus:
  Apache-2.0.

## Libraries linked into the helper

- **espeak-ng 1.52.0 and its English data** (through BlueTTSKit's
  `BlueTTSEspeak`): GPL-3.0-or-later. The `codeg-talk` binary is therefore
  GPL-3.0-or-later, like `codeg-tts`; codeg talks to it over a pipe.
- **whisper.cpp v1.9.1** (`whisper.framework`, the official release
  XCFramework): MIT.
- **sherpa-onnx 2.0.1** (static, built by codeg-ios's
  `scripts/build-sherpa-onnx.sh`): Apache-2.0.
- **ONNX Runtime 1.30.0** and its Objective-C bindings: MIT.
- The vendored Talk sources (`Sources/TalkCore/Vendor`,
  `Sources/TalkEngines/Vendor`) and the packages in `native/SherpaOnnx`,
  `native/SmartTurn`, `native/WhisperCpp`, `native/ExceptionCatcher`: from
  codeg-ios (`vendor.lock` names the commit).
