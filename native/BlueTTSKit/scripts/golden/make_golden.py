"""Generate golden files for BlueTTSKit from the Python reference pipeline.

Run with the reference venv (Light-BlueTTS checkout + renikud-plus 0.5.0 +
phonemizer + espeakng-loader 0.2.4):

    /tmp/tts-spike/venv/bin/python scripts/golden/make_golden.py \
        --blue-src /tmp/tts-spike/Light-BlueTTS \
        --blue-dir /tmp/tts-spike/models/blue25 \
        --renikud /tmp/tts-spike/models/renikud/model_int8.onnx \
        --out Tests/BlueTTSKitTests/Golden

Writes pipeline.json (front end per case: tagged, normalized, segments with
phonemes, chunks and token ids), espeak.json, renikud.json and num2words.json.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cases  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--blue-src", required=True)
    ap.add_argument("--blue-dir", required=True)
    ap.add_argument("--renikud", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    sys.path.insert(0, a.blue_src)
    from src.blue_onnx import (TextProcessor, chunk_text, load_text_processor,
                               prepare_text_for_synthesis, split_slow_segments,
                               strip_lang_tags_from_phoneme_string)
    from src.blue_onnx import text_norm
    from num2words import num2words

    g2p = TextProcessor(a.renikud)
    up = load_text_processor(a.blue_dir)
    os.makedirs(a.out, exist_ok=True)

    def front_end(text, lang):
        normalized = prepare_text_for_synthesis(text, lang=lang, mark_slow=True)
        segs = []
        for seg_text, is_slow in split_slow_segments(normalized):
            ph = g2p.phonemize(seg_text, lang=lang)
            chunks = chunk_text(strip_lang_tags_from_phoneme_string(ph), max_len=300)
            ids = [up([c], [lang])[0][0].tolist() for c in chunks]
            segs.append(dict(text=seg_text, isSlow=bool(is_slow), phonemes=ph, chunks=chunks, tokenIds=ids))
        return dict(normalized=normalized, segments=segs,
                    # The spike's logged PHON line: unmarked normalization, one G2P pass.
                    spikePhon=g2p.phonemize(prepare_text_for_synthesis(text, lang=lang, mark_slow=False), lang))

    pipeline = []
    for group, rows in (("spike", cases.SPIKE), ("extra", cases.EXTRA)):
        for nn, kind, t in rows:
            lang = "en" if kind == "en" else "he"
            plain = cases.plain(t)
            ref_input = plain if lang == "en" else cases.tagged(t)
            row = dict(id=nn, group=group, kind=kind, language=lang, plain=plain, tagged=ref_input)
            row.update(front_end(ref_input, lang))
            pipeline.append(row)
            print(nn, row["spikePhon"][:100], flush=True)
    json.dump(pipeline, open(os.path.join(a.out, "pipeline.json"), "w"), ensure_ascii=False, indent=1)

    esp = [dict(text=t, phonemes=g2p._espeak(t, "en")) for t in cases.ESPEAK_TERMS]
    json.dump(esp, open(os.path.join(a.out, "espeak.json"), "w"), ensure_ascii=False, indent=1)

    ren = g2p._load_renikud()
    rk = []
    for t in cases.RENIKUD_EXTRA:
        rk.append(dict(text=t, phonemes=ren.phonemize(t), vocalized=ren.vocalize(t)))
    json.dump(rk, open(os.path.join(a.out, "renikud.json"), "w"), ensure_ascii=False, indent=1)

    nums = []
    for v in [0, 1, 2, 7, 10, 11, 12, 15, 19, 20, 21, 42, 99, 100, 101, 110, 200, 315, 999, 1000, 1001, 1024,
              1500, 2000, 2024, 2025, 3000, 10000, 11000, 12345, 100000, 250000, 999999, 1000000, 2500000,
              -5, 3.5, 3.12, 49.9, 0.25, 1.05, 12.5]:
        nums.append(dict(value=v, isFloat=isinstance(v, float), he=num2words(v, lang="he"), en=num2words(v, lang="en")))
    for v in [1, 2, 3, 4, 5, 11, 12, 13, 21, 22, 23, 31, 40, 101]:
        nums.append(dict(value=v, isFloat=False, ordinalEn=num2words(v, to="ordinal", lang="en")))
    json.dump(nums, open(os.path.join(a.out, "num2words.json"), "w"), ensure_ascii=False, indent=1)

    # Normalizer-only cases (no G2P) for quick unit coverage.
    norm_inputs = [
        ("he", "המספר הוא 7 והשעה 08:15"), ("he", "יחס של 2:3 בין הקבוצות"), ("he", "שלב 1. התקנה 2. הרצה"),
        ("he", "קוד TKT-90254 נשלח"), ("he", "מנכ\"ל החברה אמר..."), ("he", "ג'מיני ומנג'ר"),
        ("he", "באז-וורד חדש!!!"), ("he", "(בסוגריים) וגם [מרובעים]"), ("he", "כוכבית *6700 לשירות"),
        ("he", "DJ gear + laptop"), ("he", "שלח ל-GPU מהר"), ("he", "10% הנחה ו-3.5 מעלות"),
        ("en", "Meet me at 10:30 on 12/05/2024, it's 95% done."), ("en", "Version 1,500.25 is out"),
        ("he", "אמר: \"שלום\" והלך"), ("he", "🎉 מסיבה 🎉"), ("he", "## כותרת"),
    ]
    norm = [dict(lang=l, text=t, normalized=prepare_text_for_synthesis(t, lang=l, mark_slow=True))
            for l, t in norm_inputs]
    json.dump(norm, open(os.path.join(a.out, "normalizer.json"), "w"), ensure_ascii=False, indent=1)
    print("done")


if __name__ == "__main__":
    main()
