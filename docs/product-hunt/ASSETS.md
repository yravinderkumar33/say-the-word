# Product Hunt launch gallery

Prepared 2026-10-09 for Say the Word.

Upload the PNGs in this order:

1. `01-speak-naturally.png` — a clearly labelled illustrated workflow: hold Fn, speak, release to paste.
2. `02-local-cleanup.png` — the real Cleanup screen and optional local Ollama mode.
3. `03-private-by-design.png` — the real Privacy screen.
4. `04-hands-free.png` — the real completed setup screen and dictation shortcuts.

Use `thumbnail-240.png` for the thumbnail. `thumbnail-512.png` is also provided. Both are the existing app icon drawn from `src/shared/icon-shapes.ts`, on the gallery's cream background.

All four gallery PNGs are exactly **1270 × 760**. The thumbnails are square. Every PNG is below **3 MB**. These dimensions and size limits were checked against [Product Hunt's launch preparation guide](https://www.producthunt.com/launch/preparing-for-launch) and [submission help](https://help.producthunt.com/en/articles/479557-how-to-post-a-product), which recommend 1270 × 760 and require at least two gallery images.

## Sources and accuracy

The screenshots are from `dist/.pictures-say-the-word`, the quiet screenshot run recorded on 2026-10-09 in `docs/progress.md`. Exact source PNGs are preserved in `source/`. The SVG files embed them unchanged and display them proportionally at gallery size. No screenshot text, controls, model names, statuses or data were changed. Only the screenshot's outer corners are masked for the gallery frame. These screens use synthetic fixture content, not personal dictation.

The first gallery image is original vector artwork representing the documented workflow, labelled **Illustrated workflow**. It does not claim to be an actual screenshot of Mail or another application. The other three use real application captures.

Product claims were checked against `README.md`, `CLAUDE.md`, the current release notes in `docs/progress.md`, and the depicted UI. The gallery includes the macOS 14 / Apple Silicon requirement and qualifies offline use with the one-time speech model download. It does not make hardware-independent latency promises.

No app was built, started, stopped or interacted with to prepare this gallery. No keyboard, clipboard or browser automation was used.

## Re-render

From the repository root:

```sh
node --import tsx docs/product-hunt/render-gallery.mts
```

The renderer uses the repo's `tsx` and requires `sharp`. If `sharp` is installed elsewhere, provide `SHARP_PACKAGE_PATH` with its package directory. SVG source is also provided alongside every PNG. The screenshot source copies make rendering independent of `dist/` once they exist.

Verification: inspected all four gallery images and the 240 px thumbnail at full size; confirmed dimensions and file sizes programmatically; compared preserved screenshot bytes against their originals.
