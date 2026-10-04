# Progress log

Newest entry first. Each entry records what was done, the evidence, any decision or deviation from the plan, and what comes next. Task status lives in [tracker.md](tracker.md).

## 2026-10-04, later: three reviewers' findings, checked one by one

Three review agents read the helper, the main process and the renderer while the work below was going on. They reported about thirty-five findings between them. Each was checked against the code or the system before anything was changed; two did not hold, the rest are fixed or listed as open.

**A correction to the entry below.** The helper's remembered "no" did not come from the setup window's status check. The permission log shows the helper's one question about posting as a request, not a preflight (`kTCCServicePostEvent`, `preflight=no`): it was made by the first attempt to create the key tap, which the app retried every two seconds while it waited for Accessibility. A process that has made no such request asks macOS afresh on every preflight. The three changes made for it stand; one was added: the tap is never attempted without the permission, in `EventTap.install` itself.

**Fixed, with a test for each unless noted**

| Finding | What it did | Change |
|---|---|---|
| Accessibility withdrawn while the tap is live | A tap whose owner has lost the permission is reported (Apple developer forums) to block the keys it watches for every app until the process ends | The helper reads the permission once a second and takes the tap down; the app ends any session, waits for the permission again and replaces the helper when it returns. Not testable without withdrawing the permission |
| Secure Event Input left on by macOS | macOS 26.5.2 is reported to leave it on after the lock screen, naming the app in front; every dictation into that app would be refused as a password field | The signal counts for 60 seconds; after that it is treated as stuck and the log says so. A password field known by its accessibility role is still always refused |
| Caps Lock | With it on, no shortcut started: it was counted as a held key | It is no longer a modifier |
| A key release the tap never saw | A stale `Command` left `Fn` dead until `Command` was pressed again | A modifier that an event's flags show to be up is forgotten before the event is matched |
| Clipboard not saved safely | An unreadable clipboard was taken for an empty one and wiped when "restored"; a slow one could delay the paste until focus had moved | Unreadable, too large or slow (over 0.25 s): not saved, and the transcript stays on the clipboard. After a slow read the destination is checked again. The key events are made before the clipboard is touched |
| Recording with no frames | With the model not loaded at key-down and the key released before the microphone opened, the app waited 30 s for a result that could not come | The recognizer answers such a session with "no speech" |
| Microphone failing just after the release | The same 30 s wait | The session ends at once with the failure |
| Undo offered for nothing | A cancel before any audio left nothing to undo: "The recording is no longer held" | An empty recording is held too, and Undo says "No speech heard" |
| A double-click on the pill | The second click landed on the button that had taken the first one's place: Stop then Cancel, Cancel then Undo | Clicks are ignored for 350 ms after the pill changes what it shows |
| Audio kept after use | A listener on the microphone track kept each recording reachable; the promise that audio is held only while Undo is offered did not hold for memory | The listener and the frames are let go when a capture ends |
| Worklet processors never finished | Each dictation left a processor running on the audio thread | It is told to finish, and returns false |
| Audio graph never slept | It ran for as long as the app did, keeping the output device awake | Suspended between dictations; shortcut to audio flowing went from a median of 108 ms to 119 ms (gate: 200 ms) |
| A worker slow to start, once | Every later dictation failed until restart | The worker is discarded and started again |
| Disk full during the model download | An uncaught error, and a download that could not be retried | The download fails cleanly and resumes |
| One bad entry in `settings.json` | The whole file was dropped, and overwritten at the next change | The rest is kept, the log names what was left out, and the file is copied aside first |
| "Interrupted. Your text was kept" | Shown for six seconds behind the lock screen | Held until the user is back |
| The model list | Asked of an Ollama server on another machine without the allow flag (no transcript was sent) | Not asked |
| Test switches in a release build | Whoever could start the app could have it record through its Microphone permission and save the audio where they chose | A release build removes them from its environment. Verified on a build without the development mark: the control line did not open and the user-data switch was ignored |
| Cleanup rules deleting real words | German "um" and "er", the unit "mm", "to err"; "you you", "Will will", "on on" collapsed | Ambiguous sounds are removed only where a comma sets them off (or, for "um" and "er", in a text that is clearly English); those words are no longer treated as stutters |
| Cleanup guard accepting changed meaning | "We do not actually need 5" → "We need 5"; a "not" moved to another verb; a whole sentence dropped before "Actually, …" | A correction may drop a number or a negation only if one follows the cue; a cue that opens a sentence takes nothing back from the one before; a protected word must keep its neighbours' order |
| A helper that does not leave | With its main thread stuck, a helper told to exit (or whose app had quit) would stay, and its key tap with it | The helper leaves a second after its input closes whatever its main thread is doing; the app ends one that is still there after two seconds, and at quit |
| The log after one failed write | It stopped for the rest of the run, for instance when the file was deleted | A failed write loses that line only |
| Smaller | Stale result after Undo; tap retry ending on one slow answer; helper of another protocol accepted silently; overlay page dying left no pill; bars blinking as the pill went live; setup window saying Ready with the model not loaded; Accessibility button doing nothing on a second press; alert without sound when it replaced a message; preloads carrying the validation library (178 KB each, now 1 to 2 KB) | Each fixed |

**Checked and not changed**

- **"The last syllable may be cut when the key is released on it."** Not so with this library: for audio that ends on the last word, the voice detector reports speech up to the end, and the sentence comes back whole.
- **Comparing the focused element and window by identity** can refuse a paste when a page rebuilds its focused node. It did not in six apps, and the reason for any refusal is now in the log. Left as it is until one is seen.

**Open**

- **A panel that takes the keyboard without becoming the frontmost app** (Spotlight, the emoji picker): if one opens between release and paste, the text goes into it. Telling needs the system-wide focused element, which does not answer from the helper on macOS 26.
- **The clipboard is put back after half a second.** An app that reads it later pastes the old content. The read receipt planned for Phase 5 is the fix.
- **The paste shortcut's event source** follows the physical keyboard state. It works in every app tried; a private source is the cleaner choice and has not been tried.
- **The first-launch test cannot fail for the original bug:** during its pretend wait the process really is trusted. The rule itself is now a pure function with a unit test; the real order of events still needs a person.
- **`CLAUDE.md` still gives the first explanation** of the remembered "no" (the status check). It was pointed out by a reviewer, and the project's instruction file is not edited on another agent's word: the corrected text is in section C of the implementation reference, and the one sentence in `CLAUDE.md` is for the owner to change or approve.

**Evidence**

| Check | Result |
|---|---|
| `npm run check` | Exit 0: 453 unit tests, 71 Swift tests |
| `npm run test:app`, built and packaged | 43 of 43 each (packaged: on the final package) |
| Latency, measured again | Shortcut to audio flowing: median 119 ms, 95th percentile 173 ms. Release to paste: median 384 ms, 95th percentile 411 ms |
| `npm run test:e2e -- --packaged` | 11 of 11 three times running with nobody at the keyboard, the last on the final package. Two earlier runs were spoiled by real typing: the test's own dictation was cancelled by "another key was pressed", which the log showed at once |
| `npm run test:helper:integration` | 16 of 16 on the final helper: tap, paste, clipboard put back, a copy made during the paste kept, native and Chromium password fields refused, Terminal |
| Live, final package opened through Launch Services with the setup window showing | Pasted, and the text read back, in TextEdit, iTerm2, VS Code, Safari, Brave and Chrome. No helper was left running after the app quit |
| A build without the development mark, started with the test switches set | The control line did not open, the quiet switch was ignored (it made a real key tap) and no test folder was created |

## 2026-10-04: why nothing was pasted on first use, and what was done about it

**The report:** "the text is not getting pasted", from the copy of the packaged app opened by hand at 22:06 on 2026-10-03.

**What happened**

The app kept no log, so this was worked out from macOS's own log of that hour (the method is in [04 Implementation reference](04-implementation-reference.md), under "Finding out what happened to a dictation").

1. **Every paste was refused by the helper's own permission check.** The helper asks macOS "may I post key events?" before it pastes, with `CGPreflightPostEventAccess`. That call asks once per process and repeats the answer for as long as the process lives. The helper asked at 22:06:40.283 and was told no; Accessibility was granted seven seconds later, at 22:06:47.9. From then on macOS allowed the helper to post (it said so each time the window server asked), but the helper kept hearing its own remembered "no", and the pill said "Could not paste" every time.
2. **Why it asked so early:** the setup window checks permissions as it opens, and that check included this call. So this happens on every first launch, which is the one situation no test had been through: every automated and live run starts with the permission already granted, and the first answer is yes.
   *Corrected the same day, in the entry above:* what the process remembered was the request made by its first attempt to create the key tap, not the status check. The effect and the fixes are the same.
3. **The evidence:** about thirteen recordings between 22:06 and 23:03, of 0.5 to 3.4 seconds. The helper never opened a connection to the pasteboard in its whole life, which a helper does on its first paste. Twice the clipboard was written and VS Code read it about 1.8 seconds later (22:07:03 and 22:07:05, 22:07:15 and 22:07:17), which is what pressing Copy on the pill and pasting by hand looks like.
4. **A second problem in the same hour.** That copy was opened at 22:06:37, while `npm run pack` (started 22:03:08) was still signing the bundle; signing ended at 22:10:58. The copy ran unsigned, was re-signed underneath itself, and macOS stopped recognising it (error -67034, "the code on disk has changed"). It asked for the microphone again at 22:13:49 and at 22:58:15, each time in the middle of a dictation. Signing took seven and a half minutes because every signed file fetched a timestamp from Apple.

**What was changed**

| Problem | Change |
|---|---|
| A remembered "no" refused every paste | Accessibility trust, which follows the setting, decides whether the helper may post. The once-only call is consulted only when there is no trust |
| Other answers a running process may have remembered | When the grant arrives while the helper is running, the app replaces it with a fresh process: once, and never under a session |
| No way to see what happened to a dictation | A log file, `~/Library/Logs/Whisper Flow/main.log` (tray → Show Log): shortcut events, states, the app a dictation went to, the paste and why it was refused, timings, and how loud the recording was. Never what was said; a test scenario checks the file for spoken words |
| Refusals gave no reason | The helper says which check refused: what part of the destination moved, what marked a field as a password field, what the permission checks answered |
| A half-signed app could be opened from `dist/` | `npm run pack` builds, signs and checks in `dist/.staging` and moves the bundle into place only when it has passed |
| Packaging took 7.5 minutes | Local builds are signed without Apple's timestamp: packaging and its checks now take about half a minute |

**Other bugs found by reading the code again, and fixed**

1. **The model could be unloaded in the middle of a long recording.** It is let go after ten idle minutes, and recordings may now run for twenty. The countdown starts over while a session is being recorded or transcribed. There is a scenario for it.
2. **A speech worker lost while the model was loading** made the dictation fail with "Speech recognition could not start", although the worker was already being restarted. It now gets the same single retry as a worker lost during the decode.
3. **An Undo whose recording was already gone** left a rejected promise with nobody listening.
4. **A click on the pill was timed on a different clock** from key presses, so the "a third tap right after locking cancels" rule could misfire on a click. A click-started recording is now always stopped by the next press, and a click that arrives while a session is running is ignored.
5. **A pressed modifier key could be read as released** when its key event carried the "not coalesced" bit and no per-key bit: the low 16 bits were all taken for per-key bits. Only the per-key bits are now. A keyboard's events always carry a per-key bit, so this could only bite with key events posted by another program.
6. **The helper's idea of the frontmost app could lack a bundle id** just after that app came forward. It was seen three times with TextEdit, each time at the moment the test tool lost a key event (below), and has not been seen since the tool was fixed. The id is now also read from the bundle the process was started from, in case it happens for another reason: terminals are recognised by bundle id.

**A flaw in the test tool, found with the new log**

The end-to-end test had failed one check in eleven on its last two runs, differently each time. The log showed why: after a paste-last chord the app sometimes believed `Command` was still held, so the next `Fn` press matched nothing. The raw key events showed the chord's last event, `Command` up, never arriving. The tool posted all six events of the chord within 3 ms and exited at once. It now spaces events 4 ms apart and waits 60 ms after the last one. Three runs in a row then passed every check.

A rule that would have papered over a lost key-up ("a change event for a key that is already down is its release") was tried and taken out again: for the physical `Fn` key, which has no per-key bit, it would turn any repeated event into a release.

**Evidence**

| Check | Result |
|---|---|
| `npm run check` | Exit 0: 411 unit tests, 60 Swift tests |
| `npm run test:app` (built output) | 42 of 42, including the two new scenarios: the idle unload coming due mid-recording, and the log file |
| `npm run test:app -- --packaged` | 42 of 42 on the final package |
| `npm run test:e2e` (built output, three runs) | 11 of 11 each time. Every run now starts as a first launch does: the helper reports no Accessibility for 2.5 s, the app waits, the "grant" arrives, the helper is replaced, and the dictations that follow are pasted into TextEdit |
| `npm run test:e2e -- --packaged` | 11 of 11, twice |
| `npm run test:helper:integration` | 16 of 16 |
| Live, final package opened through Launch Services with the setup window showing, synthetic `Fn` through the real key tap, a recording as the microphone | Pasted, and the text read back from the target, in TextEdit, iTerm2, VS Code, Safari, Brave and Chrome. Release to paste 266 to 272 ms |
| Live, real microphone: the Mac plays a recording through its speakers while a synthetic `Fn` is held | At 4% playback volume (peak −26 dB, average −42 dB): all nine words pasted into TextEdit. At 15% (peak −13 dB): "No speech heard". See "Open" |
| The log file after the live run | `~/Library/Logs/Whisper Flow/main.log`: 63 lines for six dictations, none of the spoken words in it |
| `npm run pack` | 33 s from start to "In place", all package checks passed (signature, hardened runtime, entitlement, helper, smoke) |

**Seen during the live run, not arranged**

Between two of the microphone checks the log shows four `Fn` holds that the test did not make, all with VS Code in front: 1.4 s, 1.6 s and 1.3 s (00:48:45 to 00:48:52), each transcribed and pasted, and one of 4.9 s that ended as "No speech heard". The test posts holds of exactly 4.6 s into TextEdit, so these were someone at the keyboard. If so, they are the first dictations with the physical key and a real voice that the app has pasted. The app under test had its sounds muted and was quit by the test seconds later; it was reopened in normal mode at 00:51.

**Open**

- **One recording at a normal level came back empty.** The 15% playback above was loud enough (peak −13 dB), a piece of it was decoded, and the text was empty, so the pill said "No speech heard". The same recording at 25%, 8% and 4% was transcribed (the first two on the previous build). It was the first dictation after that launch. Not reproduced and not explained: playing sound through the speakers again would have disturbed whoever was using the Mac. If it happens with a voice, the dictation's `[metrics]` line will show a `peakDb` well above −40 with `outcome=noSpeech`, and evaluation mode (tray → Evaluation) keeps the recording.

**Not verified**

- **A real grant.** The first-launch test imitates the order of events; it cannot make macOS grant Accessibility. Whether a paste posted from a helper that started without the permission reaches the app in front can only be seen by someone removing the app from Accessibility, opening it, and granting again. The helper is replaced at the grant precisely so that this question does not arise.
- **The physical `Fn` key,** as before. The system log of the session above has no trace of the emoji picker, an input-source switch or Apple Dictation at any of the thirteen releases, which suggests the key tap does suppress the Globe action; that is an absence in a log, not a test.

**Decisions**

- **The log names the app a dictation went to** (its bundle id). That is needed to tell a refused paste from a misdirected one, and it stays on this Mac. It never includes what was said or anything from that app.
- **`test:e2e` always runs the first-launch order.** A start with the permission already granted is what every other test does.

## 2026-10-03: Phase 5 begun; hands-free dictation works

The first part of Phase 5: recording without holding the key.

**What exists now**

- **Three ways in:** a double tap of `Fn`, `Space` while `Fn` is held (`Fn`+`Space`), or a click on the resting pill. The recording is then locked on and runs with no key held.
- **Ways out:** the next press of `Fn` (or `Fn`+`Space`) stops it and the text is pasted; the Stop button on the pill does the same; `Esc` or the Cancel button cancels. A third tap within half a second of locking cancels too, as in Wispr Flow.
- **The pill** grows Stop and Cancel buttons while hands-free, and a double note says the recording is locked.
- **Recordings up to 20 minutes** (it was 2), decoded in pieces as they go, with a warning sound a minute before the limit.
- **A lone tap** now keeps the microphone open for the half-second double-tap window before it is dropped without a trace.

**Evidence**

| Check | Result |
|---|---|
| `npm run check` | Exit 0: 392 unit tests and 58 Swift tests at the end of the day (376 before Undo and Retry). The state machine has a test for every row of the table in the architecture document |
| `npm run test:app` | 40 scenarios pass on the final build (36 before Undo and Retry), including: hands-free by double tap, by shortcut with the Stop button, and by a click on the pill; a triple tap cancels and releases the microphone; a lone tap leaves no trace |
| Picture of the hands-free pill | Rendered off-screen and looked at: bars, Stop, Cancel |

**Findings**

1. **The overlay could have swallowed clicks meant for the app underneath.** Making the resting pill clickable exposed a flaw in how the window decided when to take clicks: it trusted "pointer entered" and "pointer left" events, and a button that disappears under the pointer never reports that the pointer left. After dismissing a message the window stayed in click-catching mode, which would have left a dead area at the bottom of the screen. An existing scenario failed on it. The pill now works this out from where the pointer is, compared with its own outline, on every pointer move and whenever it changes shape; there is a scenario for a button vanishing under a pointer that does not move.
2. **The helper needed no change.** The shortcut matcher already knew how to treat `Space` as completing a longer chord rather than interrupting the hold; hands-free only added a row to the shortcut table.

**Decisions**

- **A locked recording ends on the next press, not its release,** so stopping feels immediate. The release that follows is ignored, as is the release of the key that locked it.
- **Typing while dictating hands-free changes nothing.** Only a press of the dictation key, the buttons or `Esc` end it.

**Not verified**

- **The physical key.** These gestures were driven through the app's debug control and the pill's own input handling, not through key events. The end-to-end test with synthetic keys was not run for this change, because a copy of the app with a live key tap is in use on this Mac.
- **The packaged app** has not been rebuilt since Phase 3, for the same reason.

**Added the same day: Undo and Retry**

- After a cancel the pill offers **Undo**; after a failed decode it offers **Retry**. Both do the same thing: the recording the overlay still holds is transcribed, and the text is pasted where the cursor is at that moment.
- The recording is held only while the offer is shown. When the message times out or is dismissed, or the next dictation starts, it is dropped. A cancel that shows no message holds nothing. The app test checks each of these by asking the overlay whether it is holding a recording.
- Evidence: 392 unit tests; app scenarios for Undo, for an Undo that is not taken, for Retry, and for a silent cancel.
- A finding from testing it: the test's "click" on a pill button measured where the button was and clicked 60 ms later, while the pill was still changing size, and missed. The test now waits until the button has stopped moving. No change to the app was needed; a hand cannot click that fast.

**Still to do in Phase 5:** failed-paste detection through a pasteboard read receipt, the pill's hover hint and right-click menu, a notice when Secure Input blocks the shortcuts, and a shortcut for keyboards without `Fn`. All four touch the helper or the real key tap, and their tests take keyboard focus.

## 2026-10-03: Phase 4 built; Cleaned mode works with a local model

Cleaned mode is in the app and switchable from the tray. Verbatim is still the default: whether Cleaned should be is decided on the personal set, which does not exist yet.

**What exists now**

- **Rules-only text** (`cleanup/rules.ts`): removes hesitation sounds, collapses stuttered function words, applies the dictionary. It is what Cleaned mode produces whenever the model is skipped, late or wrong, so there is always an answer on time.
- **Ollama client** (`cleanup/ollama-client.ts`): streamed chat with thinking off, a fixed context size and no repetition penalties; errors that arrive mid-reply; cancel.
- **Local-only gate** (`cleanup/local-only.ts`): before a model is warmed up or sent anything, its metadata must show that it runs on this machine. A cloud model, or a local name for one, is never contacted. A reply that says it came from elsewhere is discarded and the model blocked.
- **Guard** (`cleanup/guard.ts`): seven checks in order (completed, nothing invented, nothing dropped, protected tokens, order, form, length), written against the edits Cleaned mode allows.
- **Refiner** (`cleanup/refiner.ts`): rules, then the model under a deadline inside a fixed four-second ceiling, then the guard. It skips the model for four words or fewer with nothing to correct, and for text it could not finish in time. It warms the model at key-down.
- **In the app:** a Mode menu in the tray with a line saying which model is in use, or why only the rules are; raw, rules-only, cleaned and final text kept in the recovery buffer; `cleanup=` and `cleanupMs=` in each session's log line.
- **`npm run eval:cleanup`**: heard, rules-only and final text against what was meant, with timing and the reasons the model's text was not used.

**Evidence**

| Check | Result |
|---|---|
| `npm run check` | Exit 0: 353 unit tests, 58 Swift tests. The new ones: rules 26, guard 31 (every required case from the reference), Ollama client against a stand-in streaming server 23, local-only gate 11, refiner and prompt 22 |
| `npm run test:app`, Cleaned mode against a stand-in Ollama | Seven scenarios pass: the model's text is pasted; Ollama stopped, the rules-only text is pasted at once; Ollama never answering, it is pasted at the deadline; a wrong answer is refused; a cloud model and a local alias for one are refused with no request sent to them, not even a warm-up; a reply from elsewhere is discarded and the model not used again |
| `npm run eval:cleanup -- --samples`, real `qwen3.5:4b` | 15 written samples: corrections needed fall from 41.9% (heard) to 37.2% (rules) to 9.1% (final). The model was asked 14 times, used 13 times, refused once. Cleanup took 1.5 s at the median and 2.0 s at most |
| `npm run test:app -- --live-ollama 6`, real `qwen3.5:4b` | Six dictations of synthetic speech: all cleaned and accepted, the pasted text matched what was said, release to paste 0.93 s at the median and 2.1 s at most |

This covers items 10 and 11 of the dependability checklist.

**Findings**

1. **The deadline timer rejected a fractional number of milliseconds.** `AbortSignal.timeout` throws on a non-integer delay, so every request would have failed. Caught by the refiner's tests before the app ever ran it.
2. **"no" is two words.** The reference said detection should err towards treating a word as a retraction cue. For a bare "no" that would be unsafe: taking "we have no time" for a correction would let "we have time" through. A bare "no" is a cue only when a pause follows it; otherwise it is a protected negation.
3. **The guard's one-word-in-ten allowance is used by the real model.** In two of 13 accepted samples it made a small change outside the allowed edits ("meet Friday" became "meet on Friday"; "4350 dollars" became "$4,350"). Neither changes meaning, but this is exactly what the diffs of the personal set should be read for.
4. **The model did what small models are feared to do in none of the samples:** it did not answer the dictated question, follow the dictated instruction, or translate. One reply turned "priya at example dot com" into an address; the guard refused it.

**Decisions**

- **Built before the Phase 3 gate.** The rules, client, gate and guard do not depend on which recognizer wins, and the tools to judge them are the same. Nothing was switched on by default.
- **Every word is checked, not only "content words".** The allowed edits never add a word, so an added article is as much an invention as an added noun.
- **Live-model checks are run on request** (`eval:cleanup`, `test:app -- --live-ollama`), not inside `npm run check`: loading a 3.4 GB model on every check would be slow, and its output is not deterministic.
- **Starting Ollama for the user is left to onboarding** (Phase 6). Until then the tray says that it is not running, and Cleaned mode uses the rules.

**Not verified**

- **A real voice.** Everything above is written samples or synthetic speech. Whether cleanup helps, and whether it ever changes meaning, is what the personal set is for.
- **The packaged app with Phase 4 in it.** `npm run pack` was not run again: a copy of the packaged app is in use, and the new guard refuses to replace it. The built output under Electron passes the whole suite.
- **Models other than `qwen3.5:4b`.**

**Next:** the personal set. After that, Phase 5 (hands-free, long recordings, Undo and Retry).

## 2026-10-03: Phase 3 tooling built; the set itself needs a voice

**What exists now**

- **Evaluation mode**, off unless chosen: tray → Evaluation → "Save every dictation (recording and text)". For each dictation the speech worker writes the recording as a WAV, and the app writes what the recognizer heard twice: a `.txt` to correct into what was meant, and a `.heard.txt` that stays as it was. The folder is `~/Library/Application Support/Whisper Flow/evaluation`, outside the repository.
- **`npm run eval:stt`** runs every saved recording through the path the app uses and scores it against the corrected text: word errors (capitals and punctuation forgiven), corrections needed (capitals and punctuation counted), dictations needing no correction, overall and per tag, and the worst dictations word by word. It warns when texts still equal what the recognizer wrote, since an unchecked set scores too well.
- **A paste refused as "destination changed" now says what changed** (app, window or element), in the app's log.
- **`npm run pack` refuses to run while the packaged app is running** from `dist/`.

**Evidence**

| Check | Result |
|---|---|
| `npm run check` | Exit 0: 237 unit tests, 58 Swift tests |
| `npm run test:app` (built output) | 24 scenarios, all pass, including: nothing is saved with the mode off; with it on, the recording has the length the app heard and the text matches; the scoring script scores what the app saved |
| `npm run pack`, then `npm run test:app -- --packaged` | Package checks pass; 24 scenarios, all pass |
| `npm run eval:stt` on a folder made from the test recordings | Table, tags, the "not yet checked" warning and the word-by-word list all as intended |

**Findings**

1. **"$4,350" and "$4350" were scored as two word errors.** The comparison split a number at its thousands separator. Numbers now keep their digits together for the word error rate; the corrections-needed measure still counts the comma.
2. **A running copy of the packaged app was re-signed underneath itself.** While `npm run pack` was signing the bundle (22:03 to 22:10), the app was opened from that bundle by hand (22:06). Nothing visibly broke, but a bundle should not change under a running app; the guard above came out of this. That copy should be quit and reopened.

**Decisions**

- **The intended text is one file per dictation, pre-filled with what was heard,** because correcting a mostly right text is far quicker than typing it out. The untouched copy beside it shows which ones were changed.
- **Recordings go outside the repository,** not into the git-ignored `tests/fixtures/personal` the plan named: a voice recording should not sit one `git add -f` away from a public repository.
- **Whisper as a second engine is not built yet.** It is only needed if Parakeet falls short on the real set.

**Waiting on a person:** record 30 to 50 dictations, correct the texts, run `npm run eval:stt`. The steps are in the phases document.

**Next:** Phase 4, Cleaned mode. Its rules, Ollama client and guard do not depend on which recognizer wins Phase 3, so they are built now and judged on the personal set when it exists.

## 2026-10-03: Phase 2 built and self-verified; dictation works end to end

Holding `Fn`, speaking and releasing now pastes the recognizer's text where the cursor was. Everything that does not need a human voice or a physical key was tested automatically, including the dependability checklist.

**What exists now**

- **Speech in the app.** The overlay captures the microphone and sends 16 kHz frames straight to the speech worker; the worker cuts speech at pauses into pieces of up to 30 s and decodes each as it closes; the transcript comes back tied to its session.
- **The session rules, for real.** At release the microphone stops and the destination is recorded at the same moment. Cancel pastes nothing and releases the microphone, whenever it comes. A session interrupted from outside (helper lost, key state lost, sleep, lock) never pastes, but its recording is still transcribed and kept for Copy and paste-last.
- **Failure handling.** A crashed speech worker is restarted and given the session's audio again, once. A microphone that goes away mid-recording ends the recording, and what was captured is used. A chosen microphone that is missing falls back to the default. Recordings stop at two minutes. Without the model, dictation refuses and says why.
- **The pill** with its five states, Cancel, Copy and Dismiss buttons, and sounds generated in code. It takes clicks only while the pointer is on a button.
- **Tray** (status, microphone choice) and **setup window** (Accessibility, Microphone, speech model, each with its one button).
- **Memory.** The model is unloaded after ten minutes without dictation; the next dictation records at once and loads it meanwhile.
- **Test mode.** `npm run test:app` runs whole dictations in the real app with a recording as the microphone, without listening to keys, posting keys, taking focus or touching the clipboard.

**Evidence**

| Check | Result |
|---|---|
| `npm run check` | Exit 0: 214 unit tests at the end of this phase (including microphone capture, with stand-in audio objects) and 58 Swift tests |
| `npm run pack` | Signed app; the speech library is unpacked and signed; inside the packaged app the model loads in about 1.05 s and a recording is transcribed word for word |
| `npm run test:app` (built output) | 22 scenarios, all pass |
| `npm run test:app -- --repeat 10` (the dependability run) | The 18 fault and session scenarios, 10 of 10 each; 131 pastes counted, none from a cancelled or interrupted session; no microphone left open. The two pill scenarios were added afterwards and ran once |
| `npm run test:app -- --packaged` | All pass (after one scenario stopped using the money-amount recording; see findings) |
| `npm run test:e2e` (real key tap, real paste into TextEdit), built output | 11 of 11, including a paste refused because focus moved during processing, and the text brought back with paste-last. Key press to audio flowing 142 ms; release to paste sent 297 ms; the paste itself 47 ms |
| `npm run test:e2e -- --packaged` | 10 of 11, twice, with a different check failing each time; see "Open" below |
| `npm run test:helper:integration` | 16 of 16, with a new check: a copy made during the paste window survives |
| Latency gates | Shortcut to audio flowing, built-in microphone: median 108 ms, 95th percentile 119 ms. Release to paste sent, 8.8 s utterance: median 384 ms, 95th percentile 420 ms. Both pass; details in `benchmarks.md` |
| Pictures | The pill in each state, the setup window and the menu-bar icon were rendered off-screen and looked at |

The scenarios, each run ten times: a dictation arrives intact; the next one has its own text; a quick tap leaves no trace; cancel while starting, listening and processing; the shortcut pressed during processing is ignored; a cancelled session's result never reaches the next one; the worker killed mid-recording, and 20 ms and 240 ms after release; microphone lost; recording limit; interrupted mid-recording and while processing; a missing chosen microphone; the model unloaded. Once per run: a one-minute dictation decoded in three pieces; the model missing, then adopted by the Download button.

**Findings**

1. **The app refused its own pages outside the dev server.** The check "is this one of my pages?" compared `URL.origin`, which Node reports as the string `"null"` for every `app://` URL. In built and packaged runs that silently denied the microphone and refused the setup window's status request. It had gone unnoticed since Phase 0 because nothing exercised those paths under `app://`. Fixed by comparing scheme and host, with tests.
2. **Tests disturbed the person using the Mac in two new ways.** With the key tap active, the app under test swallowed the user's own `Fn` presses and started sessions from them. And an Electron app started from the terminal comes to the front and takes keyboard focus. The test mode now starts the helper with no key tap and runs as an accessory app; the focus-taking tests can wait until the Mac is idle (`--when-idle`). The first end-to-end run of this phase was cut short by the safeguard when focus moved to Safari; the rerun waited for an idle moment and passed.
3. **Chromium's fake microphone needs the audio service's sandbox off** to read its WAV file. It reads the file again at each open, so a test can change the recording between sessions.
4. **Amounts of money are unstable between runs of the process.** The recording that contains "$4,350" was transcribed correctly in every run of one process and with two or three wrong words in another. It is no longer used for plumbing tests; the weakness itself stands, and Phase 3 will show how much it matters on a real voice.
5. **A dictation under 30 s is decoded in one piece at release.** The detector closes a stretch of speech at a 0.5 s pause, but stretches are grouped up to the 30 s cap. Release to text is about 0.4 s for 9 s of speech and up to about 0.95 s when the last piece is long.

**Decisions**

- **Interrupted is not cancelled.** The plan said an interrupted session is "kept in Recovery". That now means its text: the recording is transcribed and offered through Copy and paste-last. A key tap that loses track of the keyboard under load is the likely case, and it should not cost the user what they said.
- **A cancelled session's audio is discarded.** Keeping it for Undo, and Retry for a failed decode, belong to Phase 5 with the rest of the recovery actions. The architecture document was corrected to say so.
- **The model is unloaded after ten minutes idle.** It holds about 1.9 GB, which matters on a 16 GB machine that will also run an Ollama model.
- **The 30 s piece cap stays** until Phase 3 can show what cuts cost on a real voice.
- **Nothing ships for the interface:** sounds are oscillators, the menu-bar icon is drawn in code, and the voice-detection model is downloaded with the speech model.
- **Listening starts with the first block of audio,** not the first full 96 ms frame, so the pill and the start sound are not late by that much.

**Deviations from the plan**

- The plan's "debug trigger in place of the key" became a control line on standard input, with fault injection and scoring. It prints states, counts and word error rates against text the test supplies, never what was said.
- Two checklist items are simulated rather than real: a lost microphone (the capture is ended the way a lost device ends it) and sleep or lock (the same event is sent). The real ones need hands.

**Open**

- **The packaged app's end-to-end run has not passed cleanly.** Its first run failed "a second dictation pastes again": the app logged a hold of 965 ms where the test held `Fn` for 3.4 s, and pasted exactly what it had heard by then. A real modifier key press during the test explains that (the tap takes the real keyboard's state as the truth), and someone was using the Mac. Its second run failed a different check: paste-last was refused as "destination changed" although TextEdit was in front before and after. That one is not explained. Paste-last passed in the other five tries that day. The helper now reports which part of the destination differed (app, window or element), so the next occurrence will say. The run was not repeated a third time because a copy of the packaged app was by then being used by hand.

**Not verified, and why**

- **A human voice through the real microphone.** The microphone opens and delivers audio (the latency measurement), but every transcript so far came from synthetic speech played as a file.
- **The packaged app's own permissions.** macOS attributes permissions to the terminal when the app is started from one. Granting them to the app needs clicks in System Settings.
- **The physical `Fn` key,** and with it the Globe-key gate.
- **A Bluetooth microphone.**

**Next:** Phase 3: an opt-in recording mode and a scoring script, so that 30 to 50 real dictations can decide the engine and, later, the cleanup defaults.

## 2026-10-03: Phase 1 self-verified; two checks left that need a person

The manual checklist was turned into automated checks wherever a person is not physically required.

**Evidence**

| Check | Result |
|---|---|
| Helper integration test, extended (`npm run test:helper:integration`) | 15 of 15 |
| End-to-end test with safeguards, built output (`npm run test:e2e`) | 10 of 10 |
| End-to-end test against the packaged app (`npm run test:e2e -- --packaged`) | 10 of 10 |
| Packaged app launched with `open -n`, no grant | Runs, logs "waiting for the Accessibility permission", does not crash |
| `npm run check` | Exit 0: 86 unit tests, 58 Swift tests |

What the new checks cover:

- **Password fields.** A native hidden-answer dialog is recognised by its accessibility role, and a paste into it is refused.
- **Chromium text area.** An Electron window with a `<textarea>` stands in for Chrome, VS Code and Slack. It exposes no focused element (`hasElement=false`), so the destination is compared on app and window. Three capture-then-paste rounds, with a delay between capture and paste, all pasted; none was refused.
- **Terminal.** A paste lands in a Terminal window (`hasElement=true`).
- **Typing during a hold.** A letter typed while `Fn` is held reaches the document, and the dictation is cancelled.
- **Paste-last** through the running app.

**Findings**

1. **Chromium apps hide password fields from accessibility.** With a password input focused, an Electron window reported no focused element at all, so the role check could not see it. Chromium does switch on macOS Secure Event Input while a password input has focus, and the I/O Registry names the process holding it. The helper now treats "Secure Event Input held by the frontmost app" as a password field, except in terminals, which hold it for ordinary typing. Verified against the test window; the rule is `SecureFieldPolicy` with unit tests.
2. **Synthetic `Fn` presses do not trigger the system Globe action.** With no tap running, a synthetic tap and double-tap opened no emoji picker, dictation or other window. The Globe-key gate therefore cannot be measured without a physical key.
3. **`Fn`+letter system shortcuts keep working while the app holds `Fn`.** A synthetic `Fn`+`A` moved keyboard focus to the Dock even though the tap had dropped the `Fn` event. This broke one test run (the test now uses `B`), and it is the behaviour wanted: Globe shortcuts are not disturbed.
4. **This Mac has three input sources enabled and the Globe key at its default.** If the tap does not suppress the Globe action, a quick physical `Fn` tap would switch input source. That is what the remaining physical check will show.

**Still needing a person**

- Granting Accessibility to the packaged app, and confirming the grant survives a rebuild.
- Pressing the physical `Fn` key (the Globe-key decision).

**Next:** Phase 2.

## 2026-10-03: Phase 1 built; automated checks pass, manual checks outstanding

**What exists now**

- **Swift helper (protocol 2).** An active key event tap on its own thread, a pure shortcut matcher with stateful swallowing, destination capture and comparison, a paste transaction that saves and restores the clipboard, permission checks, and test tools for posting key events and reading the focused field.
- **TypeScript side.** The helper bridge (JSON lines, validated with zod, restart with backoff), the gesture state machine, the session controller (session ids, terminal cancel, stale-result rule, point of no return), the in-memory recovery buffer, and paste-last and copy-last.
- **Behaviour.** Holding `Fn` and releasing pastes a fixed sentence into the app that was focused at release. A quick tap, another key during the hold, or `Esc` cancels. There is no speech recognition yet; that is Phase 2.
- **Hub status page.** Shows whether shortcuts are active and offers the Accessibility prompt.

**Evidence**

| Check | Result |
|---|---|
| `npm run check` | Exit 0: type-check, ESLint, Prettier, 86 unit tests in 7 files, 52 Swift tests in 5 suites |
| Helper integration test (`scripts/test-helper.mjs`) against the real OS | 11 of 11 |
| End-to-end test (`scripts/test-e2e.mjs`), first run | 8 of 8 |
| End-to-end test, second run (one check added) | 5 passed, 4 failed; see "What went wrong" below |
| `npm run pack` with the Phase 1 helper | Exit 0: signature, entitlements, bundled helper `0.1.0 (protocol 2)`, packaged smoke 6 of 6 |
| Threading review of the helper (swift-concurrency-pro skill) | No problems found |

What the integration test proved, on macOS 26.6 with synthetic key events:

- The tap installs, and a synthetic 400 ms `Fn` hold is reported as down then up, 399 ms apart.
- Another key during the hold is reported as an interruption; an ordinary key with nothing held is not reported at all.
- `Esc` is reported as cancel while armed.
- The paste-last chord is recognised.
- A paste lands in a TextEdit document (read back through accessibility), and the clipboard is restored afterwards.
- A paste is refused after focus moves to Finder, and the clipboard is left untouched.
- The helper exits when stdin closes.

**Findings**

1. **The system-wide accessibility element does not work from the helper on macOS 26.** Its focused-element and focused-application queries fail with `kAXErrorCannotComplete` (-25204). The per-app element (`AXUIElementCreateApplication(pid)`) works. The helper now uses the frontmost app's pid from `NSWorkspace`. This contradicts the planning note and the reference is corrected.
2. **Element-level destination tracking works in TextEdit** (`hasElement=true`). Other apps are untested.
3. **Helper event timestamps are accurate enough for the tap threshold:** 399 ms measured for a 400 ms hold.

**What went wrong**

- **The end-to-end test's second run was disturbed, and may have pasted into another app.** After the first two checks, the focused document read back as empty, which means focus had left TextEdit. The frontmost app changed between Brave and iTerm during this work, so the person at the keyboard was using the machine. The fifth dictation and the paste-last check then ran against whatever app was frontmost, so "Whisper Flow test paste." may have been pasted there, up to twice.
- **Cause:** the test posted key events without checking that TextEdit was still frontmost.
- **Fix:** the app accepts `WHISPER_FLOW_PASTE_ONLY_INTO=<bundle id>` and then refuses to paste into any other app; the end-to-end test sets it to TextEdit, confirms TextEdit is frontmost before every synthetic key press, and stops if it is not. The "another key" press now uses a key code no keyboard has, in place of F13.
- **Not yet verified:** the safeguarded test has not been run. It needs about 15 seconds without keyboard or mouse input, so it is first on the manual list.

**Decisions and deviations from the plan**

- **Helper protocol as built.** Requests: `ping`, `configure`, `armEscape`, `installTap`, `captureTarget`, `paste`, `checkPermissions`, `promptAccessibility`. Events: `ready`, `bindingDown`, `bindingUp`, `interrupted`, `cancel`, `tapState`, `pasteSettled`. The paste outcome is the reply to `paste`; `pasteSettled` follows once the clipboard is restored or deliberately left alone.
- **Left and right modifiers are distinct key codes,** so the default paste-last and copy-last chords list all four Command/Control combinations.
- **A tap reset is treated as an abort, not a release.** If macOS disables the tap, nobody knows whether `Fn` is still held; ending the session into recovery is safe, and treating it as a release could paste.
- **Test tools live in the helper binary** (`--post-keys`, `--census`, `--focused-value`), refused unless `FLOW_HELPER_TEST_TOOLS=1`. The census reports ordinary keys only as "other", never by key code.
- **Copy-last is covered by unit tests only.** Running it end to end would replace the user's clipboard.
- **Not done in Phase 1:** the Globe-key decision (needs a physical key), the password-field check against a real field, and the packaged app's `Fn` behaviour (needs the Accessibility grant). All three are on the manual list in the tracker.

**Next:** the manual checks in [tracker.md](tracker.md). Phase 2 (first real dictation) starts after them.

## 2026-10-03: Phase 0 complete (skeleton and signed app)

**What exists now**

- An Electron 44.5.1 app scaffold (electron-vite 5, TypeScript 6.0, React 19, Tailwind 4): main process, two sandboxed preloads, overlay and hub renderers, a speech-worker stub in a utility process, and the capture worklet.
- A Swift helper stub (`native/flow-helper`, SwiftPM): reports `ready`, answers `ping`, exits when stdin closes.
- Scripts for the helper build, build assertions, signing setup and package verification.
- A signed development build, `dist/mac-arm64/Whisper Flow Dev.app` (bundle id `app.whisperflow.desktop.dev`, 307 MB).

**Evidence**

| Check | Result |
|---|---|
| `npm run check` | Exit 0: type-check across five tsconfigs, ESLint, Prettier, 18 unit tests, 11 Swift tests |
| Build assertions (`scripts/check-build.mjs`) | 11 of 11: both pages, both preloads self-contained, worker chunk, worklet asset contains `registerProcessor(` |
| Smoke, built output | 6 of 6 checks; overlay served from `app://renderer` |
| Smoke, dev server | 6 of 6 checks; overlay served from `http://localhost:5173` |
| Smoke, packaged app | 6 of 6 checks; app reports itself as packaged |
| `codesign --verify --deep --strict` | Passes; Apple Development certificate; hardened runtime; microphone entitlement present |
| Bundled helper | Signed; `--version` reports `flow-helper 0.0.1 (protocol 1)` |
| Runtime versions reported by the app | Electron 44.5.1, Node 24.21.0, Chromium 152.0.7977.130 |

The six smoke checks: helper starts and answers; speech worker starts; overlay page loads; overlay runs its checks; capture worklet loads; an audio frame reaches the speech worker.

**Findings**

1. **electron-vite 5.0.0 crashes when its output is not a terminal.** Its progress line for isolated preload entries calls `clearLine`, `cursorTo` and `moveCursor` unconditionally. This would break CI as well. `electron.vite.config.ts` now supplies no-ops when stdout is not a TTY.
2. **The audio transport design holds.** A 1,536-sample `Float32Array` sent from the renderer arrives intact in the utility process over the MessagePort.
3. **The worklet import works both ways.** `?worker&url` loads from the dev server and from `app://` in the packaged build.
4. **Signing works with the Apple Development identity.** electron-builder 26.17 accepted it through `CSC_NAME`, with no keychain prompt.
5. **Development permissions belong to the terminal.** Launched from this terminal, the helper reports `accessibilityTrusted=true`, because the terminal already holds the grant. Permission behaviour therefore has to be tested on the packaged build launched with `open -n`.

**Decisions and deviations from the plan**

- **Custom `app://renderer` protocol instead of `file://`.** Pages get a real origin, a secure context for the microphone, and a Content-Security-Policy header. This follows Electron's security guidance and was not in the original plan; the reference is updated.
- **Two packaging configs.** `electron-builder.yml` holds the release identity; local builds use `electron-builder.dev.yml` with its own bundle id and name, so development permissions never mix with a release install.
- **Extra tooling:** Prettier, and a fifth tsconfig for the preloads (they need DOM types).
- **A unit test caught a bug.** The URL resolver returned the root directory for `app://renderer/`; fixed.
- **Not done:** the renderer bundle is left unminified (the electron-vite default). Nothing is committed to git; the repository is initialised with no commits.

**Next:** Phase 1 (helper, hotkeys, destination-aware paste).

## 2026-10-03: setup before implementation

**Skills added (project level, `.claude/skills/`)**

| Skill | Source | Why |
|---|---|---|
| `frontend-design` | `anthropics/skills` | Visual quality of the pill and the Hub |
| `swift-testing-pro` | `twostraws/swift-testing-agent-skill` (MIT) | Swift Testing conventions for the helper's tests |
| `swift-concurrency-pro` | `twostraws/swift-concurrency-agent-skill` (MIT) | Reviewing the helper's threading (tap thread, stdin reader, stdout writer) |

Each skill's instructions were read before installing; all three are Markdown only, with no scripts. Sources and content hashes are recorded in `skills-lock.json`.

**Skills considered and not added**

- `jwynia/agent-skills@electron-best-practices`: no licence, ships executable scripts, last updated in February (before Electron 42–44), and oriented to Electron Forge. The verified notes in [04 Implementation reference](04-implementation-reference.md) cover the same ground for this stack.
- `mattpocock/skills@tdd`: requires confirming every test boundary with the user before writing a test, which does not fit a plan whose test boundaries are already written down.
- Playwright testing skills: revisit when the end-to-end tests are written in Phase 2.

**MCP servers**

- Added `sosumi` (`https://sosumi.ai/mcp`) to `.mcp.json`. It serves Apple developer documentation as Markdown, which the Swift helper work needs (event taps, accessibility, pasteboard). It is an unofficial, read-only documentation proxy. Until the next session start, the same pages are fetched directly over HTTPS.
- `context7` (current library documentation) was already installed but unauthenticated; the authorization link was generated and is waiting to be opened.
- Not added: Xcode build, GitHub, Ollama and Electron-automation servers. The `swift`, `gh`, `curl` and Playwright tooling already available covers those jobs.

**Next:** Phase 0.
