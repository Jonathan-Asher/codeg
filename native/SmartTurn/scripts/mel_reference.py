"""Reference values for SmartTurn's log-mel front end and classifier.

Runs the same steps as pipecat-ai/smart-turn's inference.py (commit
4786657e242dfe77dd138699ac564ee074a2a543): keep the last 8 s, zero-pad at the
front, then transformers' WhisperFeatureExtractor(chunk_length=8) with
padding="max_length", max_length=128000, truncation=True, do_normalize=True,
and, with --model, the ONNX classifier's probability.

The test signals are synthetic and generated identically by
Tests/SmartTurnTests/MelFrontEndTests.swift (TestSignal): three sines under a
slow envelope plus noise from a 32-bit LCG.

Usage (numpy, transformers and, for --model, onnxruntime; no torch, so the
extractor takes its numpy path):
    python3 -I scripts/mel_reference.py [--model smart-turn-v3.2-cpu.onnx] \
        > Tests/SmartTurnTests/Fixtures/mel-reference.json
"""

import argparse
import json
import math

import numpy as np
from transformers import WhisperFeatureExtractor

SAMPLE_RATE = 16000
FRAMES = [0, 1, 2, 3, 200, 399, 400, 401, 797, 798, 799]
CASES = [("8s", 8.0, 1), ("3s-padded", 3.0, 7), ("10s-truncated", 10.0, 42)]
FILTER_BINS = [0, 1, 2, 10, 50, 100, 150, 200]


def test_signal(seconds, seed):
    n = int(round(seconds * SAMPLE_RATE))
    state = seed & 0xFFFFFFFF
    out = np.empty(n, dtype=np.float64)
    for i in range(n):
        state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
        noise = (state >> 8) / 16777216.0 - 0.5
        t = i / SAMPLE_RATE
        env = 0.55 + 0.45 * math.sin(2 * math.pi * 0.7 * t)
        x = (0.30 * math.sin(2 * math.pi * 220.0 * t)
             + 0.20 * math.sin(2 * math.pi * 1375.0 * t + 0.5)
             + 0.10 * math.sin(2 * math.pi * 3150.0 * t))
        out[i] = env * x + 0.05 * noise
    return out.astype(np.float32)


def truncate_audio_to_last_n_seconds(audio_array, n_seconds=8, sample_rate=16000):
    # As smart-turn's audio_utils.py.
    max_samples = n_seconds * sample_rate
    if len(audio_array) > max_samples:
        return audio_array[-max_samples:]
    if len(audio_array) < max_samples:
        return np.pad(audio_array, (max_samples - len(audio_array), 0), mode="constant", constant_values=0)
    return audio_array


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model")
    args = ap.parse_args()

    fe = WhisperFeatureExtractor(chunk_length=8)
    session = None
    if args.model:
        import onnxruntime as ort
        so = ort.SessionOptions()
        so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        so.inter_op_num_threads = 1
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        session = ort.InferenceSession(args.model, sess_options=so, providers=["CPUExecutionProvider"])

    cases = []
    for name, seconds, seed in CASES:
        audio = truncate_audio_to_last_n_seconds(test_signal(seconds, seed), n_seconds=8)
        inputs = fe(audio, sampling_rate=16000, return_tensors="np", padding="max_length",
                    max_length=8 * 16000, truncation=True, do_normalize=True)
        feats = inputs.input_features.squeeze(0).astype(np.float32)  # (80, 800)
        assert feats.shape == (80, 800), feats.shape
        case = {
            "name": name,
            "seconds": seconds,
            "seed": seed,
            # values[i * 80 + m] = feature (mel m, frame FRAMES[i])
            "values": [round(float(feats[m, f]), 6) for f in FRAMES for m in range(80)],
            "mean": float(feats.mean()),
            "min": float(feats.min()),
            "max": float(feats.max()),
        }
        if session is not None:
            out = session.run(None, {"input_features": feats[None, :, :]})
            case["probability"] = float(out[0][0].item())
        cases.append(case)

    filters = fe.mel_filters  # (201, 80)
    print(json.dumps({
        "source": "pipecat-ai/smart-turn inference.py @ 4786657e; transformers WhisperFeatureExtractor(chunk_length=8), numpy path",
        "frames": FRAMES,
        "cases": cases,
        "filterBins": FILTER_BINS,
        "filterValues": [round(float(filters[b, m]), 9) for b in FILTER_BINS for m in range(80)],
        "filterColumnSums": [round(float(s), 9) for s in filters.sum(axis=0)],
    }, indent=1))


if __name__ == "__main__":
    main()
