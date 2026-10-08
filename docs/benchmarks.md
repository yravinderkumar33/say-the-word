# Benchmarks

Measurements that the plan's go/no-go gates depend on. Each entry says what was measured, on what, and how to reproduce it. The gates themselves are in [03 Implementation phases](03-implementation-phases.md); their outcomes are summarised in the [tracker](tracker.md).

**Machine:** MacBook Air, Apple M4 (4 performance + 6 efficiency cores), 16 GB, macOS 26.6.

## The storage process, with a large saved history — 2026-10-05, evening

Measured after the QA report's fixes, with the history and the figures in SQLite in a process of their own. `npm run bench:storage` drives the storage worker as built, in Electron's Node 24.21 with SQLite 3.53.4, over the same `birpc` channel the app uses, with synthetic dictations of about 200 words each in a temporary folder. Times in milliseconds; listing is the newest 50; search is two words, found by a scan of every row (there is no full-text index).

| Saved dictations | Start | Newest 50: median / p95 / slowest | Search: median / p95 | A write: median / p95 / slowest | Database | The storage process | What main is given per answer |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10,000 | 52 | 0.27 / 0.44 / 0.61 | 22.7 / 23.9 | 0.52 / 0.79 / 2.54 | 47 MB | 83 MB | 6.6 KB |
| 100,000 | 133 | 1.44 / 1.95 / 2.83 | 186 / 201 | 1.93 / 3.25 / 4.05 | 471 MB | 83 MB | 6.7 KB |

**Against the plan's targets:** listing p95 under 100 ms, and a write taken p95 under 50 ms: both met by a wide margin at 100,000. Search is reported apart, as planned: 0.2 s over 100,000 long dictations is acceptable for a page that waits 150 ms after typing, and a full-text index would cost size and make deletion harder. What main holds does not grow with the history: 6.6 KB at 10,000 and at 100,000. The database is large because the synthetic dictations are long and each is stored three times over (heard, written, and the lower-cased text searched); real dictations are shorter.

**Dictation while the history works.** `node scripts/test-app.mjs --latency 20 --history-load 100000`: twenty dictations of 8.8 s on the built output, with 100,000 dictations kept on disk, the History page searching and the history being swept every 1.25 s throughout. Release to text and release to paste: **median 402 ms, 95th percentile 448 ms**, slowest 462; decode median 246 ms; microphone live median 38 ms. The gate is 1.0 s at the 95th percentile; without the history's load it was median 384, p95 420 (2026-10-03).

**The signed package.** `npm run pack`: every check passes; the packaged smoke loads the model in 1,427 ms and transcribes the 2.9 s fixture in 186 ms with 0% word error rate. The smoke now also starts the storage process and has it keep a dictation, so that every package shows SQLite working inside the signed app.

## QA regression observations — 2026-10-05

Measured on macOS 26.6.2 during the [end-to-end QA audit](../QA_REPORT_5_10_2026.md). The existing signed package matches all 11 assets of the fresh build and passes its 82 quiet-app scenarios. Its smoke run loads the speech model in **1,153 ms** and transcribes the **2.9-second** synthetic fixture in **143 ms**, with **0% fixture word error rate**. These are single observations, not a new percentile gate.

`node scripts/test-app.mjs --live-ollama 5` passed with the installed **qwen3.5:4b** model: accepted cleanup in **5/5** cases. Release-to-paste: **n=5, median 944 ms, p95/max 1,970 ms, min 861 ms**. Cleanup: **median 622 ms, p95/max 1,521 ms, min 575 ms**. Inputs were synthetic, pastes intercepted, and the data folder isolated. A sample of five does not replace the 20-run latency gate or real-voice qualification. Logs: `docs/qa-2026-10-05/package-check.log` and `ollama-live.log`.

## Residual QA fix verification — 2026-10-04

The fresh signed development package in `dist/.qa-security-fixes` loads the speech model in 1,061 ms and decodes the 2.9-second synthetic smoke fixture in 192 ms with 0% word error rate. These are individual regression observations, not a new percentile or voice-quality gate. Full checks pass 626 TypeScript and 115 Swift tests; the native/pipeline closure probes pass. Built and packaged quiet-app suites each pass 52/52, with 41 intercepted pastes and zero open microphone streams. The one-minute recording uses three chunks and reports release-to-text of 979 ms (built) and 971 ms (packaged), one observation each. Real keyboard/paste timing was not measured because this execution host's helper reports no Accessibility trust.

## Independent fix recheck — 2026-10-04

The sign-off review's quiet-app long-recording scenario used three chunks and reported release-to-text of 905 ms in the built app and 885 ms in the signed package (one observation each). The quiet packaged smoke transcribed a 2.9-second synthetic fixture in 129 ms with 0% word error rate and loaded the model in 968 ms. These are regression observations, not a new percentile/real-voice performance gate. Fresh full checks pass 578 TypeScript and 112 Swift tests; the privacy cases found in that earlier review and their subsequent closure are in [the sign-off review](qa-signoff-2026-10-04.md). No real keyboard/paste timing was measured because this execution host's helper lacks Accessibility trust.

## QA regression observations — 2026-10-04

On macOS 26.6.2, the fresh built and existing signed packaged app each passed all 43 quiet-app scenarios. The roughly one-minute synthetic recording was decoded in three pieces; release-to-text was 895 ms (built) and 896 ms (packaged), one observation each. These are regression observations, not new median/p95 latency gates. The real key-tap/paste run was blocked by this execution context's Accessibility trust, so it produced no valid paste-latency measurements. See [the QA audit](qa-audit-2026-10-04.md) for coverage and outstanding defects.

## Speech recognizer: Parakeet TDT 0.6b v3 (int8) on CPU

Measured 2026-10-03 with `npm run bench:stt -- --threads <n>`, in plain Node 22.22 with `sherpa-onnx-node` 1.13.8 (ONNX Runtime 1.28.2). Audio is synthetic speech from three macOS voices (British, American and Indian English), generated by `npm run fixtures`. Decode times are the best of three warm runs.

| Threads | Load   | Memory after load | 8.7 s clip             | 26 s clip    | 57 s clip      | Peak memory |
| ------- | ------ | ----------------- | ---------------------- | ------------ | -------------- | ----------- |
| 2       | 729 ms | 1,598 MB          | 278 ms (31× real time) | 856 ms (30×) | 2,027 ms (28×) | 1,856 MB    |
| **4**   | 805 ms | 1,859 MB          | **216 ms (40×)**       | 662 ms (39×) | 1,650 ms (35×) | 2,487 MB    |
| 6       | 815 ms | 1,859 MB          | 235 ms (37×)           | 713 ms (36×) | 1,717 ms (33×) | 2,544 MB    |

**Gate outcomes**

- **Warm decode of 10 s of audio ≤ 0.5 s: passed.** About 250 ms with four threads.
- **Thread count: four.** It matches the four performance cores; six threads is slower.
- **Single-decode length: 30 s is safe.** Even a 57 s clip decodes in one piece in 1.65 s with peak memory under 2.5 GB. The chunk cap is set to 30 s.

**Things to know**

- **Memory is the cost.** The recognizer holds about 1.6–1.9 GB while loaded. Loading it again takes about a second with a warm file cache, so the app unloads it after ten minutes without dictation and loads it again on the next one, while that dictation is already being recorded.
- **Accuracy on synthetic speech is close to perfect for ordinary sentences**, including a 57-second passage. This says little about a real voice; the personal evaluation set (Phase 3) is the real test.
- **Amounts of money are the weak spot.** "$4,350" came back as "$4350" and once as "$350", and the result for the same recording differed between runs of the process. Within one process, repeated decodes of the same audio are identical.
- **A formatting artifact:** the recognizer writes "is$4,350" with no space before the currency symbol. The app inserts the missing space.
- **Adding inaudible noise made no difference** to any output here. A fixed (not random) noise pattern is kept as insurance against an upstream issue with perfectly silent audio.

## Speech library inside the signed app

Measured 2026-10-03 by `npm run pack`, whose last step runs the packaged app's own `--smoke` check.

- **Gate: the speech addon loads in the signed, hardened utility process: passed.** `sherpa-onnx-node` 1.13.8 and its platform package are unpacked from the archive (33 MB, four binaries), each signed with the app's identity. Inside the packaged app the model loaded in 1,060 ms, and a 2.9 s recording sent through the overlay's audio port was transcribed in 332 ms with every word right.
- No fallback (sidecar process, other engine) is needed.

## Latency in the running app

Measured 2026-10-03 on the built app under Electron 44.5.1, with the whole pipeline in place: overlay capture, audio port, speech worker, session controller.

| Measure                                        | Runs | Median | 95th percentile | Min    | Max    | Gate                                                  |
| ---------------------------------------------- | ---- | ------ | --------------- | ------ | ------ | ----------------------------------------------------- |
| Shortcut to audio flowing, built-in microphone | 20   | 108 ms | 119 ms          | 99 ms  | 157 ms | median ≤ 200 ms, 95th percentile ≤ 400 ms: **passed** |
| Release to paste sent, 8.8 s utterance         | 20   | 384 ms | 420 ms          | 370 ms | 440 ms | 95th percentile ≤ 1.0 s: **passed**                   |
| of which decoding                              | 20   | 229 ms | 266 ms          | 216 ms | 288 ms |                                                       |

How to reproduce: `npm run test:app -- --real-mic 20` and `npm run test:app -- --latency 20`.

**Measured again on 2026-10-04,** after the audio graph was changed to sleep between dictations (it used to run for as long as the app did, keeping the output device awake):

| Measure                                        | Runs | Median | 95th percentile | Min    | Max    | Gate                                                  |
| ---------------------------------------------- | ---- | ------ | --------------- | ------ | ------ | ----------------------------------------------------- |
| Shortcut to audio flowing, built-in microphone | 12   | 119 ms | 173 ms          | 105 ms | 173 ms | median ≤ 200 ms, 95th percentile ≤ 400 ms: **passed** |
| Release to paste sent, 8.8 s utterance         | 12   | 384 ms | 411 ms          | 376 ms | 411 ms | 95th percentile ≤ 1.0 s: **passed**                   |
| of which decoding                              | 12   | 230 ms | 256 ms          | 222 ms | 256 ms |                                                       |

Waking the audio graph costs about 10 ms on the way to the first audio; the wake-up is started together with opening the microphone, so most of it is hidden behind that.

**Measured once more on 2026-10-04, after the fixes for the audit's findings** (built app, `npm run test:app -- --latency 20`). The fixes changed what happens around a dictation (the recording is held until the session is over; a paste carries an expiry), not the work between release and text, and the figures say the same:

| Measure                                | Runs | Median | 95th percentile | Min    | Max    | Gate                                |
| -------------------------------------- | ---- | ------ | --------------- | ------ | ------ | ----------------------------------- |
| Release to paste sent, 8.8 s utterance | 20   | 377 ms | 445 ms          | 362 ms | 449 ms | 95th percentile ≤ 1.0 s: **passed** |
| of which decoding                      | 20   | 222 ms | 287 ms          | 208 ms | 293 ms |                                     |

The recording of about a minute, decoded in three pieces, took 884 ms and 887 ms from release to text in two runs of the whole suite (895 ms in the audit's run).

**What the numbers include**

- _Shortcut to audio flowing_ runs from the moment the main process learns of the key press to the capture worklet's first block of audio. The first dictation after the app starts is the slowest (157 ms), because the audio graph is created then. Each run was cancelled as soon as audio flowed, so nothing the microphone heard was transcribed. A Bluetooth microphone was not available and is not measured.
- _Release to paste sent_ is 150 ms of deliberate tail (people let go a little early), a few milliseconds to hand over the last partial frame, and the decode. The utterance is a recording played through Chromium's fake capture device, so the microphone itself is not in this number.
- Both were driven through the app's debug control rather than the key. The hop that this leaves out, from the helper's key event to the main process, is one line over a pipe.
- The paste itself (the helper posting `Cmd+V`) comes after "paste sent" and is reported by `npm run test:e2e`.

**Other timings seen**

| Case                                                                   | Release to text                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 2.9 s utterance                                                        | about 320 ms                                                             |
| 57 s dictation, decoded in three pieces while recording                | 842 ms                                                                   |
| Speech worker killed during the recording; restarted, audio sent again | 331 ms (the restart finished before release)                             |
| Speech worker killed just after release; restarted, audio sent again   | 1.0–1.25 s                                                               |
| First dictation after the model was unloaded                           | no different, unless the dictation is shorter than the one-second reload |

- **The piece cap is the knob for long dictations.** At release, whatever follows the last cut is still to be decoded, and that can be most of a 30 s piece: 842 ms above. A lower cap shortens the wait and puts more cuts into the text. It stays at 30 s until the personal evaluation set (Phase 3) can show what cuts cost on a real voice.

## Cleaned mode with a local model

Measured 2026-10-03 with Ollama 0.35.1 and `qwen3.5:4b` on the same machine. Nothing here used a real voice: the inputs are written samples and synthetic speech, so these numbers say how the plumbing, the guard and the timing behave, not whether cleanup helps you. That is what the personal set is for.

**Written samples** (`npm run eval:cleanup -- --samples`): 15 transcripts written to look like dictation, with fillers, stutters, self-corrections, questions, an instruction aimed at the model, numbers, negations and technical terms.

| Text                                    | Corrections needed, on average |
| --------------------------------------- | ------------------------------ |
| As heard                                | 41.9%                          |
| Rules only                              | 37.2%                          |
| Final (model when accepted, else rules) | 9.1%                           |

- The model was asked 14 times and its text was used 13 times. One reply was refused by the guard (it rewrote "priya at example dot com" as an address, which counts as invented text), and one sample was too short to ask about.
- The dictated question was not answered, the dictated instruction was not followed, and "translate this into French" was not translated.
- Two accepted replies made a change beyond the allowed edits, both inside the guard's one-word-in-ten allowance: an added "on" ("meet on Friday"), and "4350 dollars" written as "$4,350". Neither changes the meaning. They are the kind of thing to look for when reading the diffs of the personal set.
- **Cleanup time when the model was asked: median 1.54 s, 95th percentile 2.03 s, slowest 2.03 s,** against a ceiling of 4 s. Loading the model cold took 5.4 s, which the app does at key-down, while the user is speaking.

**In the app** (`npm run test:app -- --live-ollama 6`): six dictations of synthetic speech in Cleaned mode, alternating a 2.9 s and an 8.8 s utterance.

| Measure               | Runs | Median | Slowest  |
| --------------------- | ---- | ------ | -------- |
| Release to paste sent | 6    | 929 ms | 2,092 ms |
| of which cleanup      | 6    | 616 ms | 1,550 ms |

- All six were cleaned by the model and passed the guard; what was pasted matched what was said.
- **Gate: release to text appearing, Cleaned, never more than the last decode plus the ceiling: passed** on these inputs. The fallback rate was 0 of 6 here and 1 of 14 on the written samples.
- The pre-warm at key-down is why the short dictations pay only about 0.6 s for cleanup.

**Measured again on 2026-10-04, after the fixes for the audit's findings** (a transcript now waits for a warm-up that is still on its way, so that a model whose first reply names another machine is never sent it):

| Measure                                                                | Runs | Median   | Slowest  | Cleaned |
| ---------------------------------------------------------------------- | ---- | -------- | -------- | ------- |
| Release to paste sent, model already loaded                            | 6    | 893 ms   | 1,865 ms | 6 of 6  |
| of which cleanup                                                       | 6    | 624 ms   | 1,479 ms |         |
| Release to paste sent, model not loaded when the first dictation began | 6    | 1,867 ms | 2,711 ms | 5 of 6  |

- With the model loaded the figures are the earlier ones: about 0.6 s of cleanup for the 2.9 s utterance and 1.5 s for the 8.8 s one.
- With the model cold, the first dictation gets the rules-only text at its deadline (2.7 s after release), because loading takes about five seconds and that dictation was over in three. That was so before the change too: the request used to wait inside Ollama for the model, and now waits in the app for the warm-up. The five after it were cleaned.

**When Ollama misbehaves** (`npm run test:app`, against a stand-in server): stopped, the rules-only text is pasted at once; never answering, it is pasted at the deadline (about 2 s for a short dictation, never more than 4 s); answering something else, the guard refuses it and the rules-only text is pasted.
