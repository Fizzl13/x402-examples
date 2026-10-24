# The Fizzl ad (fizzl.eu/agents)

A ~60-second ad for the Fizzl Agent Wallet: filmed-looking footage from Higgsfield with big titles over it, a natural
voice, and the wallet's real approve page. It replaced the older `fizzl.json` ad (drawn scenes, Kokoro voice) on
24 Oct 2026.

- `ad.json`: the scenes (line, title, clip) and the prompt of every clip.
- Footage: Higgsfield, 1280×720, 5 s each, no sound (Kling 3.0 for the new clips, two older Seedance clips). They are
  on the `media-clips` branch; put them in `clips/`.
- Voice: ElevenLabs v4 through Higgsfield, preset voice "Juno", one line per scene, saved as `out/audio/<scene id>.mp3`
  (also on the `media-clips` branch, under `ad-voice/`).
- `stills.mjs` (Node + Playwright): the title cards, the phone bezel, and the approve page (`public/approve.html`) with
  example data (a Claude connector paying a weather API, payable from MetaMask, Phantom or Xaman).
- `compose.py` (ffmpeg): each scene lasts its line plus a breath; a clip is slowed to fit with motion-interpolated
  frames (smooth, no stutter) and gets a slow push-in; the approve page scrolls inside the phone; scenes crossfade;
  the voice is levelled to −14 LUFS. Writes `out/fizzl-ad.mp4`, `out/fizzl-ad.vtt` (captions) and `out/poster.jpg`.

```sh
git fetch origin media-clips
mkdir -p clips out/audio
for f in hf-open-2 hf-city hf-stream hf-shield-k hf-scan hf-phone hf-vault hf-end; do git show origin/media-clips:$f.mp4 > clips/$f.mp4; done
for s in s1-open s2-stream s3-shield s4-scan s5-phone s6-wallets s7-keys s8-doctor s9-end; do git show origin/media-clips:ad-voice/$s.mp3 > out/audio/$s.mp3; done
node stills.mjs && python3 compose.py
```

For the site, re-encode the master smaller: `ffmpeg -i out/fizzl-ad.mp4 -c:v libx264 -preset slow -crf 24 -c:a copy -movflags +faststart fizzl-ad.mp4`.
