# The demo video

A narrated video of fizzl-paypal-guard (under three minutes, 1920×1080), for the PayPal AI Hackathon: the risk, how the guard works, a real run on [the demo page](..) (Claude against the PayPal sandbox, then the agent that believes every email), the owner's approval in Telegram, and the code.

Made by [`paypal-video.yml`](../../../.github/workflows/paypal-video.yml), the same pipeline as the [wallet video](../../../wallet-server/media):

1. `tts.py` reads each line of `script.json` with Kokoro (open-weight neural TTS).
2. The workflow starts the demo server with the sandbox keys and Claude.
3. `record.js` drives Chromium: drawn scenes, then the demo page during a real run. Each line about the run waits until the page shows it. If Claude ever acts on Mallory's or Eve's email, the recording stops, because the narration says it doesn't.
4. `build.py` places each voice line where its scene starts and encodes `fizzl-guard-for-paypal.mp4`, an `.srt` for YouTube's subtitles, and `poster.jpg`.

Run it: Actions → "paypal-video" → Run workflow, then download the run's artifact. Edit the narration in `script.json`; the timing follows the voice.
