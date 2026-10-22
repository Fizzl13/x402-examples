# The demo video

A narrated video of fizzl-paypal-guard (under three minutes, 1920×1080), for the PayPal AI Hackathon: the risk, how the guard works, a real run on [the demo page](..) (Claude against the PayPal sandbox: a refund within the limits, a warranty claim and a $300 refund for the owner, two scams, and a refund the customer's bank already paid; then the agent that believes every email), and the code.

Made by [`paypal-video.yml`](../../../.github/workflows/paypal-video.yml), the same pipeline as the [wallet video](../../../wallet-server/media):

1. `tts.py` reads each line of `script.json` with Kokoro (open-weight neural TTS).
2. The workflow starts the demo server with the sandbox keys and Claude.
3. `record.js` drives Chromium: drawn scenes, then the demo page during a real run. Each line about the run waits until the page shows it. If the run goes otherwise than the narration says (Claude acts on Mallory's or Eve's email, or doesn't try Grace's or Frank's refund), the recording stops.
4. `build.py` places each voice line where its scene starts and encodes `fizzl-guard-for-paypal.mp4`, an `.srt` for YouTube's subtitles, and `poster.jpg`.

Run it: Actions → "paypal-video" → Run workflow, then download the run's artifact. Edit the narration in `script.json`; the timing follows the voice.
