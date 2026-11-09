"""Narration for the wallet video (copied from x402-doctor's explainer pipeline): one WAV per script segment.

    python tts.py --engine kokoro --voice am_michael --out out
    python tts.py --engine silent --out out     # timing-only placeholder (no model needed)
    python tts.py --script new-nl.json          # the voice the script names: {"lang": "nl", "voice": {"engine": "piper", ...}}

Writes out/audio/<segment id>.wav and out/durations.json ({id: seconds}).
Kokoro (open-weight neural TTS) needs kokoro-v1.0.onnx and voices-v1.0.bin in
the working directory; the workflow downloads them. Kokoro has no Dutch: a script
with "lang": "nl" names a Piper voice (open weights too), read from <name>.onnx
and <name>.onnx.json in the working directory (python -m piper.download_voices <name>).
"""

import argparse
import json
import os
import re
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLE_RATE = 24000

# How the voice should say things the captions write differently. The x402
# community says "four-oh-two"; a TTS engine reads "402" as "four hundred two".
PRONUNCIATION = [
    (r"\bx402\b", "ex four oh two"),
    (r"\bwallet\.fizzl\.eu\b", "wallet dot fizzle dot E U"),
    (r"\bbuy\.fizzl\.eu\b", "buy dot fizzle dot E U"),
    (r"\$0\.02\b", "two cents"),
    (r"\$0\.001\b", "a tenth of a cent"),
    (r"\bFizzl\b", "Fizzle"),
    (r"\bfizzl\b", "fizzle"),
    (r"\bpresign-guard\b", "pre-sign guard"),
    (r"\bUSDC\b", "U S D C"),
    (r"\bNode\.js\b", "Node J S"),
    (r"\.mcpb\b", " dot M C P B"),
    (r"\bETH\b", "eth"),
    (r"\$5\b", "five dollars"),
]

# A Dutch voice reads English words the Dutch way: "key" would become "kei".
PRONUNCIATION_NL = [
    (r"\bx402\b", "x vier nul twee"),
    (r"\bwallet\.fizzl\.eu\b", "wallet punt fizzel punt e u"),
    (r"\b[Ff]izzl\b", "Fizzel"),
    (r"\bUSDC\b", "U S D C"),
    (r"\bNode\.js\b", "Nood djee es"),
    (r"\bClaude\b", "Klood"),
    (r"\bBase\b", "Bees"),
    (r"\bkeys\b", "kies"),
    (r"\bkey\b", "kie"),
    (r"\b[Ww]allet\b", "wollet"),
    (r"\bDownload\b", "Daunlood"),
    (r"\bblockchain\b", "blok tsjein"),
]


def spoken(text, lang="en"):
    for pattern, replacement in PRONUNCIATION_NL if lang == "nl" else PRONUNCIATION:
        text = re.sub(pattern, replacement, text)
    return text


def write_wav(path, samples, rate):
    import numpy as np

    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", choices=["kokoro", "piper", "silent"], default=None, help="default: the script's voice, else kokoro")
    parser.add_argument("--voice", default=None, help="default: the script's voice, else am_michael")
    parser.add_argument("--speed", type=float, default=None, help="default: the script's voice, else 1.0")
    parser.add_argument("--out", default=os.path.join(HERE, "out"))
    parser.add_argument("--script", default=os.environ.get("SCRIPT", "script.json"))
    args = parser.parse_args()

    import numpy as np

    with open(os.path.join(HERE, args.script)) as f:
        script = json.load(f)
    segments = script["segments"]
    lang = script.get("lang", "en")
    named = script.get("voice") or {}
    engine = args.engine or named.get("engine", "kokoro")
    voice = args.voice or named.get("name", "am_michael")
    speed = args.speed or named.get("speed", 1.0)
    audio_dir = os.path.join(args.out, "audio")
    os.makedirs(audio_dir, exist_ok=True)

    kokoro = piper = None
    if engine == "kokoro":
        from kokoro_onnx import Kokoro

        kokoro = Kokoro("kokoro-v1.0.onnx", "voices-v1.0.bin")
    elif engine == "piper":
        from piper import PiperVoice, SynthesisConfig

        piper = PiperVoice.load(f"{voice}.onnx")
        piper_config = SynthesisConfig(length_scale=1.0 / speed)

    durations = {}
    for seg in segments:
        if kokoro:
            samples, rate = kokoro.create(spoken(seg["text"], lang), voice=voice, speed=speed, lang="en-us")
        elif piper:
            chunks = list(piper.synthesize(spoken(seg["text"], lang), piper_config))
            # A sentence per chunk; a short pause between them, as Kokoro makes.
            rate = chunks[0].sample_rate
            pause = np.zeros(int(rate * 0.25), dtype=np.float32)
            samples = np.concatenate([part for c in chunks for part in (c.audio_float_array, pause)][:-1])
        else:
            # ~2.6 words per second, the pace of the real voice.
            rate = SAMPLE_RATE
            samples = np.zeros(int(rate * max(1.5, len(seg["text"].split()) / 2.6)), dtype=np.float32)
        path = os.path.join(audio_dir, f"{seg['id']}.wav")
        write_wav(path, np.asarray(samples, dtype=np.float32), rate)
        durations[seg["id"]] = round(len(samples) / rate, 3)
        print(f"{seg['id']}: {durations[seg['id']]} s")

    with open(os.path.join(args.out, "durations.json"), "w") as f:
        json.dump(durations, f, indent=2)
    print(f"total narration: {round(sum(durations.values()), 1)} s")


if __name__ == "__main__":
    main()
