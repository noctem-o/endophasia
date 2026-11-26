# Promo video

A 43-second social video showing another developer why to use Endophasia. It comes in a vertical 9:16 cut and a 16:9 cut, with a generated soundtrack. Everything is rendered from code, so the video can be rebuilt when the roadmap items land.

| File | Role |
| :--- | :--- |
| `timeline.js` | The cue sheet shared by picture and sound: typing segments, scene cues, lightning and music |
| `scene.html` | Deterministic scenes. `window.renderAt(t)` paints the frame for `t` seconds |
| `audio.py` | Generates the soundtrack (numpy only): rain, thunder, key clicks, a 100 BPM score and UI plucks |
| `render.mjs` | Drives headless Chromium frame by frame and pipes the frames to ffmpeg |
| `assets/fonts` | IBM Plex Sans and Mono (SIL OFL 1.1, see `OFL-LICENSE.txt`) |

## Build

Requires Node with Playwright and Chromium, Python 3 with numpy, and ffmpeg.

```sh
cd docs/promo
python3 audio.py out/soundtrack.wav
node render.mjs --w 1080 --h 1920 --audio out/soundtrack.wav --out out/endophasia-promo-9x16.mp4
node render.mjs --w 1920 --h 1080 --audio out/soundtrack.wav --out out/endophasia-promo-16x9.mp4
```

If Playwright is only installed globally, run `export NODE_PATH=$(npm root -g)` first. Each cut takes a few minutes. `out/` is git-ignored.

Preview in a browser: `scene.html?play` plays the video in real time, `scene.html?t=21.6` freezes one frame, and `&w=1920&h=1080` switches to the landscape layout. To render stills, run `node render.mjs --stills 5.5,21.8 --out out/stills`.

## Storyboard

| Time | Scene |
| :--- | :--- |
| 0–3.4s | Hook: the agent says "Done ✅", exit 0 |
| 3.4–10s | Terminal: `node calc.mjs '2+3*4'` prints `20`, `echo $?` prints `0`. Lightning |
| 10–14.6s | Title: endophasia, tagline, "answers from records" |
| 14.6–25s | Plan, then receipt, then ledger: expected `"14"`, observed `"20"`, criterion **FAILED** (thunder) |
| 25–33.5s | Any agent, one ledger: Pi and Codex (live); Claude Code, Antigravity and the Coordinator Mission Board (planned) |
| 33.5–38.6s | The four laws |
| 38.6–43s | Call to action and repository link |

Harnesses and features that are not live yet carry a **PLANNED** tag in the video, following the project's own rule that missing stays missing. Remove the tags in `scene.html` once they ship.

To retime anything, edit `timeline.js`. Picture and sound both read from it.
