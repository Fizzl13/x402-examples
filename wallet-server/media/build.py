"""Mixes the narration onto the recorded screen (wallet video; from x402-doctor's pipeline) and writes the deliverables.

    python build.py [--ffmpeg /path/to/ffmpeg] [--out out] [--script fix.json]

Reads out/screen.webm, out/timeline.json and out/audio/<id>.wav. Writes
out/<output>.mp4 (1920x1080 H.264 + AAC, fade in/out), out/<output>.srt and
out/poster.jpg, where <output> comes from the script (default
x402-doctor-explainer).
"""

import argparse
import json
import os
import re
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))


def srt_time(t):
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def video_duration(ffmpeg, path):
    """The container duration in seconds, from ffmpeg's banner (no ffprobe needed), or None."""
    p = subprocess.run([ffmpeg, "-i", path], capture_output=True, text=True)
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", p.stderr)
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else None


def run(cmd):
    print("+", " ".join(cmd[:6]), "...")
    subprocess.run(cmd, check=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--out", default=os.path.join(HERE, "out"))
    parser.add_argument("--script", default=os.environ.get("SCRIPT", "script.json"))
    args = parser.parse_args()
    out = args.out

    with open(os.path.join(HERE, args.script)) as f:
        script = json.load(f)
    texts = {s["id"]: s["text"] for s in script["segments"]}
    name = script.get("output", "fizzl-agent-wallet")
    with open(os.path.join(out, "timeline.json")) as f:
        timeline = json.load(f)
    total = timeline["total"]
    segments = timeline["segments"]

    # Narration track: each line starts exactly where its scene started.
    inputs, filters, labels = [], [], []
    for i, seg in enumerate(segments):
        inputs += ["-i", os.path.join(out, "audio", f"{seg['id']}.wav")]
        delay = int(seg["start"] * 1000)
        filters.append(f"[{i}:a]aresample=48000,adelay={delay}|{delay}[a{i}]")
        labels.append(f"[a{i}]")
    filters.append(f"{''.join(labels)}amix=inputs={len(segments)}:normalize=0,apad,atrim=0:{total:.3f}[mix]")
    narration = os.path.join(out, "narration.wav")
    run([args.ffmpeg, "-y", *inputs, "-filter_complex", ";".join(filters), "-map", "[mix]", "-ac", "2", narration])

    mp4 = os.path.join(out, f"{name}.mp4")
    fade_out = max(0.0, total - 0.8)
    loudness = float(os.environ.get("LOUDNESS_LUFS", "-12"))
    # A busy recording browser writes a video that runs longer than the wall clock it was timed by
    # (seen: 67.4 s of video for 63.6 s), so the picture drifts behind the voice. Fit it to the timeline.
    vdur = video_duration(args.ffmpeg, os.path.join(out, "screen.webm"))
    fit = f"setpts=PTS*{total / vdur:.5f}," if vdur and abs(vdur / total - 1) > 0.01 else ""
    run([
        args.ffmpeg, "-y", "-i", os.path.join(out, "screen.webm"), "-i", narration,
        "-vf", f"{fit}fps=30,format=yuv420p,fade=t=in:st=0:d=0.5,fade=t=out:st={fade_out:.2f}:d=0.8",
        # Loudness for phones and social platforms: -12 LUFS integrated (loud enough on a phone speaker),
        # -1 dBTP peaks; LOUDNESS_LUFS overrides it (e.g. -16 for a quieter mix).
        "-af", f"loudnorm=I={loudness}:TP=-1.0:LRA=9,afade=t=out:st={fade_out:.2f}:d=0.8",
        "-ar", "48000",
        "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-profile:v", "high",
        "-c:a", "aac", "-b:a", "160k", "-t", f"{total:.3f}", "-movflags", "+faststart", mp4,
    ])
    run([args.ffmpeg, "-y", "-ss", "1.5", "-i", mp4, "-frames:v", "1", "-update", "1", "-q:v", "2", os.path.join(out, "poster.jpg")])

    with open(os.path.join(out, f"{name}.srt"), "w") as f:
        for i, seg in enumerate(segments, 1):
            f.write(f"{i}\n{srt_time(seg['start'])} --> {srt_time(seg['start'] + seg['duration'])}\n{texts[seg['id']]}\n\n")
    print(f"done: {mp4} ({total:.1f} s)")


if __name__ == "__main__":
    main()
