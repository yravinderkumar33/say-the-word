# Say the Word — social explainer

A 36-second product animation based on the app's implemented behaviour, using the owner-confirmed name **Say the Word**. The application now uses the same product name. The existing GitHub repository remains at `yravinderkumar33/whisper-flow`.

## Ready-to-post files

- `deliverables/say-the-word-feed.mp4` — 1080 × 1350 (4:5)
- `deliverables/say-the-word-landscape.mp4` — 1920 × 1080 (16:9)
- `deliverables/say-the-word-cover-feed.png`
- `deliverables/say-the-word-cover-landscape.png`
- `deliverables/posting-copy.txt` — suggested X and LinkedIn copy

Both MP4s are 36 seconds, 30 fps, H.264, yuv420p, with AAC stereo audio. The story is conveyed on screen; there is no voiceover. Music is original deterministic synthesis, with no external samples. Source and loudness measurements are in `sound-design/`.

## Story

| Time | Scene |
| --- | --- |
| 0–4.8 s | Less typing. More thinking. Private dictation for Mac. |
| 4.8–13.2 s | Hold fn, speak, release; text is pasted after release. |
| 13.2–19.2 s | Optional local cleanup removes fillers; Ollama is named. |
| 19.2–25.2 s | On-device speech and the actual Privacy screen. |
| 25.2–30 s | Double-tap fn for hands-free dictation. |
| 30–36 s | Say the Word branding, early-preview GitHub CTA and requirements. |

The composer and key/pill interactions illustrate the workflow. They are not a real-time screen recording. The Privacy panel uses the actual repository screenshot from `docs/qa-2026-10-05/screenshots/privacy-dark.png`. No unsupported speed, accuracy or universal-app guarantee is used. The CTA links to the existing public repository because the source documents no shipped public installer.

## Edit and preview

```sh
cd promo-video
npm install
npm run dev -- --no-open
```

Select `SayTheWord-Feed` or `SayTheWord-Landscape`. Each scene is also registered in the Scenes folder. The `music` composition prop disables the soundtrack when false. Copy and CTA are in `src/scenes/`; shared styling and the five-bar motif are in `src/design.tsx`.

## Export

```sh
npx remotion render SayTheWord-Feed deliverables/say-the-word-feed.mp4 --crf=18 --pixel-format=yuv420p --audio-codec=aac --audio-bitrate=192k
npx remotion render SayTheWord-Landscape deliverables/say-the-word-landscape.mp4 --crf=18 --pixel-format=yuv420p --audio-codec=aac --audio-bitrate=192k
npx remotion still Cover-Feed deliverables/say-the-word-cover-feed.png
npx remotion still Cover-Landscape deliverables/say-the-word-cover-landscape.png
```

Rendering on this Mac was verified with `--browser-executable='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'`.

`npm run lint` runs ESLint and TypeScript checks. Visual QA inspected both sizes, including dictation before/after, cleanup, privacy, hands-free and the ending. Codec, dimensions, duration and complete decoding were checked with ffprobe/ffmpeg.

The delivered MP4s were normalized from Remotion's full-range output to limited-range BT.709/yuv420p with FFmpeg, retaining AAC audio and a fast-start MP4 header for consistent playback.
