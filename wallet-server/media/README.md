# Intro video

A ~2-minute narrated intro to the Fizzl Agent Wallet: what it is, setting a
price rule, approving on the dashboard and on Telegram, why it is safe (the key
stays with the agent, presign-guard checks every signature, when in doubt it
stops), the Purchases list and a plain-words receipt, connecting agents, and finding paid services with the search bar (by words or category, with new providers).

Made by [`wallet-video.yml`](../../.github/workflows/wallet-video.yml), the same
pipeline as x402 Doctor's explainer:

1. `tts.py` reads each line of `script.json` with Kokoro (open-weight neural TTS).
2. `record.js` drives Chromium through the live demo (https://wallet.fizzl.eu/demo,
   example data, nothing moves money) and a few drawn scenes, timed to the voice,
   with burned-in captions.
3. `build.py` places each voice line where its scene starts and encodes
   `fizzl-agent-wallet.mp4` (1920×1080, H.264/AAC), an `.srt` and `poster.jpg`.

Run it: Actions → "wallet-video" → Run workflow (pick `script.json` for the intro
or `short.json` for a 30-second version, and optionally a voice), then download
the run's artifact. Edit the narration in `script.json`; the
timing follows the voice.

What's new: `new.json` (~70 seconds), `short-new.json` (30 seconds) and
`new-nl.json`, the same video in Dutch. Kokoro has no Dutch voice, so that
script names a Piper voice (`"voice": {"engine": "piper", "name": "nl_NL-pim-medium"}`,
open weights too); `tts.py` uses it and the workflow downloads it. Its scenes
take their Dutch words from each segment's `labels`, and `tts.py` has Dutch
pronunciation rules (a Dutch voice reads "key" as "kei").

The install walkthrough: `install.json` (~2 minutes) goes from the wallet's
Agents tab to Claude Desktop and back, step by step, with a step label and a
drawn pointer. The browser download and Claude Desktop are drawn (simplified,
and labelled so); the wallet is the live demo, which links the example agent
when you enter a code.

The Fizzl Buy demo: `buy.json` (~75 seconds). First the one-time install of the wallet in Claude and a spending
limit (the live demo); then Claude Desktop, drawn (simplified, and labelled so), buys
tomorrow's forecast for Amsterdam through the wallet, as in the real purchase of 23 Oct 2026; then what Fizzl Buy
did in that one call, the answer, and the live https://buy.fizzl.eu page.

Local dry run without a voice model (silent narration of the right length),
against a local server: `python tts.py --engine silent && DEMO_URL=http://127.0.0.1:3000/demo node record.js && python build.py`.

The Fizzl ad on fizzl.eu/agents (since 24 Oct 2026): [`ad/`](ad/), Higgsfield footage and voice, cut with ffmpeg.
