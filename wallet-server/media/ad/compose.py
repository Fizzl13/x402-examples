"""Cuts the Fizzl ad from Higgsfield footage, the stills and the narration (ad.json).

    python compose.py [--ffmpeg ffmpeg] [--out out]

Reads clips/<clip>.mp4 (Higgsfield, 1280x720, 5 s), out/audio/<scene id>.mp3 (the voice, one line per scene),
out/titles/<scene id>.png, out/approve.png and out/phone-frame.png (node stills.mjs). Each scene lasts as long as
its line plus a breath; a 5-second clip is slowed to fit with motion-interpolated frames, so it stays smooth.
Writes out/<output>.mp4 (1920x1080, 30 fps, H.264 + AAC), out/<output>.vtt (captions) and out/poster.jpg.
"""

import argparse
import json
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
W, H, FPS = 1920, 1080, 30
LEAD = 0.35   # the line starts this long after its scene
XF = 0.5      # crossfade between scenes
GAP = 0.5     # silence between two lines
END_HOLD = 1.8
PHONE = (1130, 90, 560, 900)  # the window the approve page scrolls in (stills.mjs draws the bezel around it)


def run(cmd):
    print("+", " ".join(str(c) for c in cmd[:8]), "...", flush=True)
    subprocess.run([str(c) for c in cmd], check=True)


def duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


def size(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", path], capture_output=True, text=True, check=True)
    w, h = out.stdout.strip().split(",")[:2]
    return int(w), int(h)


def vtt_time(t):
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02}.{ms:03}"


def title_overlay(n, length, last):
    """Fade the scene's title card in (and out, except on the end card) over the picture [base]."""
    out = f"[{n}:v]format=rgba,fade=t=in:st=0.3:d=0.6:alpha=1"
    if not last:
        out += f",fade=t=out:st={length - XF - 0.35:.2f}:d=0.35:alpha=1"
    return out + "[t];[base][t]overlay=0:0:format=auto"


def clip_scene(ff, clip, title, length, last, dst):
    """A Higgsfield clip slowed to the scene's length, with a slow push-in and the title on top."""
    clip_len = duration(clip)
    stretch = max(1.0, length / clip_len)
    # Motion-interpolate to twice the frames before slowing down, at the clip's own size (much faster than at 1080p).
    smooth = "minterpolate=fps=48:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1," if stretch > 1.05 else ""
    # The push-in: scale up a little more every frame and keep the centre (scale interpolates, so it doesn't jitter).
    push = f"scale=w='{W}*(1+0.07*t/{length:.3f})':h=-2:eval=frame:flags=bicubic,crop={W}:{H}:'(iw-{W})/2':'(ih-{H})/2'"
    base = (f"[0:v]{smooth}setpts=PTS*{stretch:.4f},fps={FPS},{push},"
            f"eq=contrast=1.06:saturation=1.1,vignette=PI/5,trim=0:{length:.3f},setpts=PTS-STARTPTS[base]")
    run([ff, "-y", "-i", clip, "-loop", "1", "-t", f"{length:.3f}", "-i", title,
         "-filter_complex", f"{base};{title_overlay(1, length, last)},format=yuv420p[v]",
         "-map", "[v]", "-r", FPS, "-c:v", "libx264", "-preset", "medium", "-crf", "14", "-an", dst])


def phone_scene(ff, background, page, frame, title, length, dst):
    """The approve page scrolling inside a phone, over a blurred clip, with the title in the left column."""
    x, y, w, h = PHONE
    clip_len = duration(background)
    stretch = max(1.0, length / clip_len)
    pw, ph = size(page)
    page_h = round(ph * w / pw)
    travel = max(0, page_h - h)
    # Hold the top (the amount and the seller) for a moment, then scroll down to the wallet buttons, eased.
    t0, t1 = 1.4, length - 1.6
    scroll = f"'{travel}*(1-cos(PI*min(1,max(0,(t-{t0})/{t1 - t0}))))/2'"
    graph = (
        f"[0:v]setpts=PTS*{stretch:.4f},fps={FPS},scale={W}:{H}:flags=lanczos,gblur=sigma=28,eq=brightness=-0.12:saturation=0.9,"
        f"trim=0:{length:.3f},setpts=PTS-STARTPTS[bg];"
        f"[1:v]scale={w}:-1:flags=lanczos,crop={w}:{h}:0:{scroll}[pg];"
        f"[bg][pg]overlay={x}:{y}[a];[a][2:v]overlay=0:0[base];"
        f"{title_overlay(3, length, False)},format=yuv420p[v]"
    )
    run([ff, "-y", "-i", background, "-loop", "1", "-framerate", FPS, "-t", f"{length:.3f}", "-i", page,
         "-loop", "1", "-t", f"{length:.3f}", "-i", frame, "-loop", "1", "-t", f"{length:.3f}", "-i", title,
         "-filter_complex", graph, "-map", "[v]", "-r", FPS, "-c:v", "libx264", "-preset", "medium", "-crf", "14", "-an", dst])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--out", default=os.path.join(HERE, "out"))
    args = parser.parse_args()
    ff, out = args.ffmpeg, args.out
    with open(os.path.join(HERE, "ad.json")) as f:
        ad = json.load(f)
    scenes = ad["scenes"]
    os.makedirs(os.path.join(out, "scenes"), exist_ok=True)

    # Timing: each scene holds its line, a breath and the crossfade into the next one.
    voice = [duration(os.path.join(out, "audio", f"{s['id']}.mp3")) for s in scenes]
    lengths = [v + GAP + XF for v in voice[:-1]] + [LEAD + voice[-1] + END_HOLD]
    lengths = [max(l, 3.5) for l in lengths]
    starts, t = [], 0.0
    for l in lengths:
        starts.append(t)
        t += l - XF
    total = starts[-1] + lengths[-1]

    parts = []
    for i, (s, length) in enumerate(zip(scenes, lengths)):
        dst = os.path.join(out, "scenes", f"{s['id']}.mp4")
        title = os.path.join(out, "titles", f"{s['id']}.png")
        if s.get("image"):
            phone_scene(ff, os.path.join(HERE, "clips", "hf-stream.mp4"), os.path.join(out, f"{s['image']}.png"),
                        os.path.join(out, "phone-frame.png"), title, length, dst)
        else:
            clip_scene(ff, os.path.join(HERE, "clips", f"{s['clip']}.mp4"), title, length, i == len(scenes) - 1, dst)
        parts.append(dst)

    # Picture: the scenes joined by crossfades.
    inputs, chain, prev = [], [], "[0:v]"
    for p in parts:
        inputs += ["-i", p]
    for i in range(1, len(parts)):
        offset = starts[i]
        label = f"[x{i}]" if i < len(parts) - 1 else "[pic]"
        chain.append(f"{prev}[{i}:v]xfade=transition=fade:duration={XF}:offset={offset:.3f}{label}")
        prev = label
    # Sound: each line where its scene starts, plus a short lead.
    n = len(parts)
    for i, s in enumerate(scenes):
        inputs += ["-i", os.path.join(out, "audio", f"{s['id']}.mp3")]
        d = int((starts[i] + LEAD) * 1000)
        chain.append(f"[{n + i}:a]aresample=48000,adelay={d}|{d}[a{i}]")
    chain.append("".join(f"[a{i}]" for i in range(n)) + f"amix=inputs={n}:normalize=0,apad,atrim=0:{total:.3f},"
                 f"loudnorm=I=-14:TP=-1.0:LRA=9,afade=t=out:st={total - 1.0:.2f}:d=1.0[snd]")
    chain.append(f"[pic]fade=t=in:st=0:d=0.6,fade=t=out:st={total - 1.0:.2f}:d=1.0,format=yuv420p[v]")
    mp4 = os.path.join(out, f"{ad['output']}.mp4")
    run([ff, "-y", *inputs, "-filter_complex", ";".join(chain), "-map", "[v]", "-map", "[snd]",
         "-c:v", "libx264", "-preset", "slow", "-crf", "19", "-profile:v", "high", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-t", f"{total:.3f}", "-movflags", "+faststart", mp4])
    run([ff, "-y", "-ss", f"{starts[0] + 2.2:.2f}", "-i", mp4, "-frames:v", "1", "-update", "1", "-q:v", "2", os.path.join(out, "poster.jpg")])

    with open(os.path.join(out, f"{ad['output']}.vtt"), "w") as f:
        f.write("WEBVTT\n\n")
        for i, (s, v) in enumerate(zip(scenes, voice), 1):
            a = starts[i - 1] + LEAD
            f.write(f"{i}\n{vtt_time(a)} --> {vtt_time(a + v)}\n{s['text']}\n\n")
    print(f"done: {mp4} ({total:.1f} s)")


if __name__ == "__main__":
    main()
