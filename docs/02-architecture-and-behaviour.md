# Architecture and behaviour

Part of the plan set: [01 Research and decisions](01-research-and-decisions.md) · 02 Architecture and behaviour · [03 Implementation phases](03-implementation-phases.md) · [04 Implementation reference](04-implementation-reference.md) · [05 Design brief](05-design-brief.md)

## Architecture

```
          ┌──────────────────────── Electron app (TypeScript) ────────────────────────┐
 keys ──► │ flow-helper (Swift) ──JSON lines──► main process                          │
          │  event tap · paste · AX reads        session state machine · pipeline     │
          │                                        │                       │          │
 mic ───► │ overlay renderer ────MessagePort────► speech worker         Ollama client ─┼─► 127.0.0.1:11434
          │  the pill + mic capture               (utility process:                    │
          │ hub renderer (React)                   voice detection + Parakeet)         │
          │  onboarding · history · settings                                           │
          └────────────────────────────────────────────────────────────────────────────┘
```

| Process                         | Language                  | Owns                                                                                                                |
| ------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Main                            | TypeScript                | Lifecycle, tray, windows, session state machine, pipeline, settings (JSON), recovery buffer, Ollama client          |
| `flow-helper`                   | Swift                     | Active key event tap, destination capture, paste transaction, accessibility reads, permission checks                |
| Speech worker                   | TypeScript + native addon | Voice detection, chunking, Parakeet decoding. Crash-isolated in an Electron `utilityProcess` and respawned on exit. |
| Overlay renderer                | TypeScript/React          | The pill, microphone capture (AudioWorklet, 16 kHz mono), sounds                                                    |
| Hub renderer                    | TypeScript/React          | The first run, Home, history, Cleanup, Settings, Privacy and About (Dictionary and Snippets are not built)          |
| Ollama (the user's own install) | n/a                       | Cleanup LLM over HTTP on loopback, local models only                                                                |

### One dictation, end to end

Every dictation is a session with its own id (see [Session rules](#session-rules)).

1. **`Fn` down.** The helper reports the shortcut. Main creates the session, the overlay requests the microphone, and the pill shows _Starting microphone_. In Cleaned mode, main also pre-warms the Ollama model.
2. **Microphone live.** When audio starts to flow, the start sound plays and the pill switches to _Listening_. Audio frames flow from the overlay straight to the speech worker. Speech is grouped into pieces of up to 30 s that end at a pause, and each piece is decoded as soon as it closes, while the recording continues.
3. **`Fn` up.** Two things happen at the same moment: the overlay stops the microphone (after a 150 ms tail, because people let go a little early), and the helper records the paste destination: app, window, focused element, and whether it is a password field. The worker decodes what is left and returns the transcript.
4. **Text.** Verbatim mode uses the transcript as is. Cleaned mode applies conservative rules, then Ollama cleanup under a fixed time ceiling, then an output guard; any failure falls back to the rules-only text. The raw transcript is always kept.
5. **Paste.** Main confirms the session is still current and not cancelled. The helper re-reads the destination. If it is unchanged and not a password field, the helper pastes: save clipboard, set text, `Cmd+V`, restore the clipboard 0.5 s later unless something new was copied. Otherwise nothing is pasted, the clipboard is left alone, and the pill offers Copy.
6. **Recovery buffer.** The session's raw and final text go into an in-memory buffer, so paste-last and copy-last work whatever happened in step 5.

### Session rules

The state machine below covers gestures. These rules cover everything asynchronous around them.

- **Identity.** Each session gets an id at `Fn` down. Audio frames, worker results, Ollama results and paste requests all carry it. A result whose id is not the current session's, or that arrives when the session is not waiting for it, is dropped.
- **One session at a time.** Pressing the shortcut while a session is processing is ignored, and the pill shows a "still processing" cue. Queuing a second recording is later work.
- **Cancel is terminal.** It releases the microphone (including a microphone request that only resolves after the cancel), tells the worker to drop the session, aborts the Ollama request, and blocks the paste. The cancel is recorded in the recovery buffer.
- **A cancel can be taken back for a few seconds.** After `Esc`, the Cancel button or a triple tap, the pill says "Cancelled" and offers Undo for six seconds. The overlay holds the recording for exactly that long: when the message goes, or the next dictation starts, it is dropped. Undo transcribes it and pastes the text where the cursor is then. This holds wherever the cancel came: a recording is kept until its session is over, so a cancel made while the text was being cleaned can be taken back too. If an Undo or a Retry itself fails, the text an earlier attempt left stays in Recovery. A cancel that leaves no message (a quick tap, another key during the hold) holds nothing.
- **An interruption is not a cancel.** When something outside the user's control ends a session (the helper is lost, the key tap loses track of the keyboard, the Mac sleeps or locks), nothing is pasted, but the recording is still stopped and transcribed, and the text goes to the recovery buffer. The pill offers Copy, and paste-last works.
- **Point of no return.** Once the paste command has been sent to the helper, the session is finished and cancel no longer applies.
- **Destination is fixed at release.** A session may paste only into the destination recorded when recording stopped. This is stricter than pasting into whatever is focused, because several seconds of local processing leave room to switch apps.

| Event                                                                                    | Behaviour                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Microphone permission missing, or the microphone fails to open                           | The session ends before Listening, with no start sound. Recovery explains why.                                                                                                                                                                                                               |
| Microphone is slow to open (Bluetooth)                                                   | The pill stays on Starting until audio flows, so it is visible that speech is not yet being captured.                                                                                                                                                                                        |
| The microphone chosen in the tray is not connected                                       | The system default microphone is used instead.                                                                                                                                                                                                                                               |
| Microphone disconnects mid-recording                                                     | Capture stops. What was captured is transcribed and handled as a normal stop, with a notice.                                                                                                                                                                                                 |
| No speech detected                                                                       | Nothing is pasted; brief notice.                                                                                                                                                                                                                                                             |
| Recording reaches the length limit                                                       | Treated as a stop, with a notice. The limit is 20 minutes, with a warning sound a minute before.                                                                                                                                                                                             |
| Speech worker crashes                                                                    | The worker respawns and the overlay sends the session's audio again, once; the dictation then completes as usual, about a second later. A second failure ends the session with a message and a Retry button. After three crashes in a row the worker is left alone until the next dictation. |
| The decode fails or takes too long                                                       | The session ends with a message and a Retry button, which works for as long as the message is shown.                                                                                                                                                                                         |
| The speech model is not loaded                                                           | Normal after ten minutes without dictation: the model is unloaded to free about 1.9 GB of memory. The next dictation records at once and loads the model meanwhile, which takes about a second.                                                                                              |
| Helper exits                                                                             | Shortcuts are unavailable until it restarts (automatic, with backoff). An active session is interrupted: its text is kept in Recovery, never pasted.                                                                                                                                         |
| Sleep, screen lock or user switch during a session                                       | The session is interrupted: its text is kept in Recovery, never pasted. On wake, key state is reconciled so no key is stuck down.                                                                                                                                                            |
| Ollama not running, too slow, or its output fails the guard                              | The rules-only text is pasted and the reason is recorded.                                                                                                                                                                                                                                    |
| Destination changed, or a password field is focused                                      | No paste. Recovery offers Copy, and paste-last works. A field counts as a password field by its role, or because Secure Input is on in its app; apart from the documented terminal exception, the second is never set aside because of time or background history.                           |
| The helper cannot get to a paste in time (the clipboard's owner is slow to hand it over) | No paste, however late the helper is free again: the request says when the app stops waiting. Recovery offers Copy.                                                                                                                                                                          |
| The clipboard cannot be copied whole before the paste                                    | The paste goes ahead and the text stays on the clipboard: a partial copy is never put back as if it were the original. The pill says "The clipboard now holds this dictation".                                                                                                               |
| The user moves to another app while the helper waits on a slow clipboard                 | No paste: after a wait the helper asks the recorded app itself whether it is still in front. Recovery offers Copy.                                                                                                                                                                           |
| A setting cannot be saved                                                                | It is not changed. The menu shows the setting still in force and the pill says so.                                                                                                                                                                                                           |
| Ollama answers with a redirect                                                           | It is not followed. The rules-only text is pasted and the tray says why.                                                                                                                                                                                                                     |
| The user copies something during the paste window                                        | The user's newer clipboard is kept; nothing is restored over it.                                                                                                                                                                                                                             |

### Privacy rules

- **Typing stays private.** The helper reports only shortcut events. It never forwards ordinary typing to the app.
- **Inference stays local.** Ollama is reached on loopback by default, and any model that Ollama would run on a remote host is refused. A redirect from the Ollama address is never followed. The transcript is never the first thing a model is sent: a valid complete reply to the instructions must establish locality for the verified server, canonical model name and digest, and a model whose reply names another machine is blocked before any transcript goes to it. Details are in [04 Implementation reference](04-implementation-reference.md), section F.
- **Network use is limited** to loopback Ollama, model downloads the user starts, and update checks the user starts (there is none yet). The first run starts the model download with its "Get started" button, and says so before the click. No telemetry. A link the user clicks opens in their browser: Buy me a coffee, Ollama's download page, the source and its issues. A page names the kind of link and never an address; the addresses are constants in the main process, and the app itself fetches nothing from them.
- **What was contacted can be looked at.** Every address the app tries is written down as it is tried (`src/main/privacy/network-ledger.ts`): Ollama and the model download note themselves, and are asked for by the main process. **A page of the app asks for nothing over the network, and anything one does ask for is refused in the main process** (`src/main/privacy/page-requests.ts`), whatever the page's own content policy says: the policy binds a page that is still the app's own, and this binds the process that draws it. A refusal is written down as one. In a development run the server the pages come from, on this Mac, is let through. The Privacy page shows the list since launch, by host and purpose and nothing more. The app tests end by checking that every address in it was on this Mac.
- **Nothing sensitive is written without a decision.** Transcript text is never logged. Transcripts live in memory, and are gone when the app quits, unless the user chooses on the History page to keep them for 7 days, 30 days or until deleted. That choice is put again in a dialog of the system's, drawn by the main process, and nothing is written before it is answered with yes. Audio is never kept by the history. The other exception is evaluation recordings, which the user switches on in the menu; the main window says so on every page for as long as they are on, and can switch them off but not on.
- **Nothing is deleted without being asked either.** Delete All on the History page, each Delete on the Privacy page and "Delete Everything" are put in the same kind of dialog, which names what goes and how much. A single dictation is deleted at once: it is one row, and the user pressed Delete on it.
- **Counts are kept, words are not.** `usage.sqlite` holds how many words were dictated on each of the last fourteen days that had any dictation and how long recent dictations took from release to paste. Home shows them ("Counted on this Mac. Never sent anywhere."). It never holds a word of what was said.
- **What the app says about itself is what it does.** The setup window, the macOS microphone prompt and the README describe both ways of recording (a held key, and hands-free until stopped) and the one case in which audio is kept.

## Behaviour to clone

Verified against the installed Wispr Flow's configuration and the official docs.

| Action                         | macOS default                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| Push-to-talk                   | hold `Fn`                                                                                   |
| Hands-free                     | `Fn`+`Space` to start and again to stop; or double-tap `Fn` within 0.5 s; or click the pill |
| Command Mode                   | hold `Fn`+`Ctrl` (experimental, off by default, as in Wispr Flow)                           |
| Cancel                         | `Esc`, swallowed during dictation so it does not reach the app                              |
| Paste / copy last transcript   | `Cmd`+`Ctrl`+`V` / `Cmd`+`Ctrl`+`C`                                                         |
| Macs without an Apple `Fn` key | `Ctrl`+`Opt` set, as Wispr Flow does: chosen in Settings, or offered when another app is on `Fn` |

### Session state machine

Pure TypeScript, unit-tested with a fake clock.

| State                       | Event                                                 | Result                                                       |
| --------------------------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| idle                        | `Fn` down                                             | start capture → holding                                      |
| idle                        | pill click, or hands-free shortcut                    | start capture → locked                                       |
| holding                     | `Fn` up after ≥ 0.3 s                                 | stop → processing                                            |
| holding                     | `Fn` up sooner                                        | tap pending: keep capturing until 0.5 s after start          |
| holding                     | `Space` while `Fn` held                               | lock sound → locked                                          |
| holding                     | another key (for example `Fn`+arrow)                  | silent cancel → idle                                         |
| tap pending                 | `Fn` down again within 0.5 s                          | lock sound → locked (double-tap)                             |
| tap pending                 | 0.5 s elapses                                         | silent cancel → idle                                         |
| locked                      | `Fn` press or hands-free shortcut                     | within 0.5 s of locking: cancel; otherwise stop → processing |
| locked                      | stop button                                           | stop → processing                                            |
| locked                      | another key, or the release of the key that locked it | nothing: typing while dictating hands-free is fine           |
| any recording               | 19 min / 20 min                                       | warning sound / stop → processing, with a notice             |
| holding, locked, processing | `Esc` or cancel button                                | cancel → Recovery → idle                                     |
| processing                  | `Fn` down                                             | ignored; the pill shows a "still processing" cue             |
| processing                  | paste-last shortcut                                   | cancel processing and paste the previous transcript          |

- The 0.5 s windows are documented by Wispr Flow. The 0.3 s tap threshold is a starting value (Wispr Flow does not publish its own) and is a tunable constant.
- Every row is implemented (`src/main/hotkeys/session-machine.ts`). A locked recording is ended by the next press of the key, not by its release, so stopping feels immediate.
- A lone tap costs half a second of open microphone: the recording runs until the double-tap window closes, and is then dropped without a trace.

### The pill

- **Look and position:** a small dark capsule, bottom-centre above the Dock, on all Spaces and over fullscreen apps. It follows the display the cursor is on. It has one look that does not follow the system's appearance, because what is behind it has nothing to do with the appearance. Its sizes, colours and timings are the design's (see [05 Design brief](05-design-brief.md)) and are named in `src/renderer/tokens.css`.
- **Focus:** it never takes focus, and it is click-through outside its controls. Because it cannot be reached from the keyboard, everything it offers is also in the menu-bar menu.
- **One colour:** green means the microphone is live. It appears on the bars while audio is being captured and nowhere else on the pill.

| State                 | Shows                                                                                                                                                                                                                                                                   | Means                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Resting               | A capsule of 36 × 6 px, half transparent. When the pointer has rested on it for half a second: "Hold Fn to dictate · click for hands-free"                                                                                                                              | Idle. A click starts a hands-free recording                                             |
| Starting microphone   | Taller, with flat, dim bars and no sound yet. After a second: "Waiting for the microphone…"                                                                                                                                                                             | The microphone has been requested but no audio is flowing; speech is not being captured |
| Listening             | Taller again, with green bars moving with the real audio level, after the start sound. If nothing at all has been heard for three seconds: "No sound from MacBook Pro Microphone"                                                                                       | Capture is live                                                                         |
| Listening, hands-free | The same, with the time it has run (in its last minute, the time left), Stop and Cancel; a double note when it locks                                                                                                                                                    | Capture is live and no key is held                                                      |
| Processing            | A light travelling along a line. "Tidying" in Cleaned mode. After a second, a Cancel button, and "Loading the speech model…" if that is what the wait is for. `Esc` cancels throughout                                                                                  | Decoding and cleanup                                                                    |
| Message               | An icon for its kind, a few words, at most one offer (Undo after a cancel, Retry after a failed decode), Copy when the session left text behind, and Dismiss. It goes after six seconds; a confirmation ("Copied") has no buttons and goes after two                    | Something to say after the fact                                                         |

- **Kinds of message.** Each has its own icon and weight, so that it is told apart without reading and never by colour alone: _plain_ (a cancel, no speech), _protected_ (the app refused to paste on purpose and the text is safe), _problem_ (something failed; semibold, with a red keyline), _note_ (worth knowing, nothing to do) and _confirm_.
- **Text waiting.** When a message that offered Copy has gone, the resting pill keeps a small mark. Its hint says "Unpasted dictation · ⌘⌃V to paste" and has a Copy button. The mark goes when the text is pasted or copied, or a later dictation is pasted. A press of the key that turns out to be no dictation (a lone tap, `Fn` with an arrow key) leaves it alone: the text is still there to be fetched.
- **A message waits under the pointer.** Its six seconds stand still while the pointer is on the pill, for a minute at most: a recording kept for Undo or Retry is held for as long as its message shows.
- **A message's time starts when it is shown.** One that comes while the pill is busy with a dictation (a recording that stopped at the limit, for example) is shown when the text has been dealt with, for its full time.
- **A message goes when its text is fetched.** `Cmd`+`Ctrl`+`V` while "Focus moved, so nothing was pasted" is showing pastes the text and takes the message away; an offer to Retry stays.
- **A press while processing** is answered with a small shake and "Still on the last dictation", and the single low note.
- The bars are driven by captured audio, so a moving indicator always means capture is working.
- **Sounds:** a rising pair of notes when audio starts to flow (speak now), a falling pair when recording stops, a low pair when a dictation did not end in a paste, and a single low note when the shortcut is pressed during processing. They are generated in code; no sound files ship. Things the user did on purpose (cancel, copy) are silent. Every state can be told with the sound off.
- **Messages** are listed in `src/main/dictation/pill-messages.ts`, for example "Focus moved, so nothing was pasted", "Password field: nothing was pasted", and "Secure Input is on: nothing was pasted" when that is all that marks the field.
- **What VoiceOver says** for each state is `spokenFor` in `src/renderer/overlay/pill-view.ts`, sentence for sentence as the design's accessibility review lists them. Rest is not announced; neither is Listening with a key held (the sound says "speak now", and a voice would be recorded with the dictation). A wait is said only once it has lasted a second. Every sentence that mentions something to do names the key or the menu item that does it, in words: "Command Control C copies it", never `⌘⌃C`.
- **Accessibility settings.** With Reduce Motion the pill jumps between shapes and the bars still follow the voice. With Increase Contrast the active pill is black with a white keyline, its one action white on black, and a problem's red keyline thicker. With Reduce Transparency its see-through details become greys of the same value. The pill at rest is the same in every setting: it is meant to recede.
- **Two settings act on it.** "Show it only while dictating" draws nothing at rest (the mark for waiting text included; the menu still has Paste Last Dictation). While dictation is paused, its hint says until when, and a click on it starts nothing.
- **The log has the rest.** A message has room for a few words. Which check refused a paste, which app the text was meant for and how loud the recording was go to the log file (menu-bar icon → Show Log), which never holds what was said.

Later (Phase 5): the right-click menu at rest (hide for 1 hour, microphone, paste last transcript).

### The main window

A sidebar of six pages and the page chosen: Home, History and Cleanup, then Settings, Privacy and About. It opens on Home. The sidebar is one stop for the keyboard (the arrows move through it); the page in view is told by its fill and its weight, and by an outline as well under Increase Contrast. Dictionary, Apps and Snippets were designed and are not built: the owner left them out (the dictionary of the settings file still applies).

- **Home** says "Ready. Hold Fn to dictate", or the one thing that stands in the way with the one button that moves it forward: the speech model's download first (it takes the longest and needs one click), then Accessibility, then the microphone, then a pause ("Paused until 11:42", Resume) and another app on the same key ("Wispr Flow is also listening to Fn", Use ⌃⌥ Instead). The line is read out when it changes, and a download's percentage is not read out at every step. Under it: the mode (with a sentence on what the choice means, why Cleaned is using the rules only when that is so, and Start Ollama when that would help), the microphone, the gestures, the last three dictations as the History page lists them, and the figures line.
- **History** lists every dictation, newest first, under its day. A row has a chip only when the dictation was not simply pasted (each with its own icon), and a glyph only when its mode was not the usual one. The header has the search, "Pause history", how long dictations are kept, and Delete All. A line under it says where the list lives: neutral for memory, amber for disk. The list is worked from the keyboard (arrows, Return opens, ⌘C copies, Delete removes) and each row has the system's menu with the same things.
- **An opened row** shows how the dictation ended and in which mode; why, in plain words, when it was not pasted or was tidied with the rules only, with the one thing that can be done about it; what was heard beside what was written, with the words that were taken out struck through and the capitals and punctuation that were added underlined (each mark carries hidden words for VoiceOver, which reports neither); "Use the Raw Text"; and where the time went.
- **Cleanup** shows the two modes on the same sentence (the one in use has a keyline and "your mode"; choosing the other switches), whether Ollama is running, installed or absent with the one action for each, the model (only models that run on this Mac, or "Rules only"), a refused model with the reason in the app's words, what Cleaned may and never changes, and "Try it": a sentence typed or dictated, as Verbatim, with the rules only and Cleaned, with the time each took. A result a dictation would not have waited for is dimmed and marked "Too slow to use".
- **Settings** is one page that scrolls: the shortcuts (the dictation key can be `Fn` or Control and Option together; the others are fixed for now), the microphones in the order they are tried (dragged, or moved with the arrow keys, with a ten-second Test on each), sounds (on or off, volume, each cue to play), the pill (at rest, or only while dictating), Open at login and Show in Dock, how long the speech model stays in memory, and under Advanced the log, Copy Diagnostics, the Ollama address (an address on this Mac only), the saving of dictations (shown, and switched off; never on) and the setup guide again.
- **Privacy** puts each promise beside a fact read from the running app: where speech is recognized, what has been contacted since launch, and what is stored (the history, the evaluation recordings, the log, the word counts) with how much, Show in Finder and Delete.
- **About** has the icon, the version, the licences of everything the app ships (checked against the installed packages by a test), and, once there is a Buy Me a Coffee address, the maker's note. The links to the source and to "Report a problem" appear when the repository has an address; there is no update check yet, and the page says so.
- **In a small window**, or with larger text (⌘+), Home's status line and its two controls stay in place and the rest scrolls under them.
- **The amber bar** ("Every dictation is being saved", with "Stop Saving") sits at the top of every page while evaluation recordings are on. Amber is used for saving and nothing else: that bar, the line on History when it is on disk, and the chip on Privacy.
- **What a page can change** goes through `changeSettings`, and a page cannot write what it likes: the microphone must be one the system offers, the model one that runs on this Mac, the Ollama address one on this Mac, and the saving of dictations can only be stopped.
- **The first run** takes the window's place until it has been gone through: Welcome, Microphone (with a level meter that waits until it has heard you), Accessibility, Keys (only when another dictation app is on the same key), Try it (a practice box and three exercises, ticked off as each way of dictating ends in a paste, with a picture of what the pill is saying), Cleaned mode (optional; shown again from Settings it starts from the mode and model in force) and Ready. The speech model's download is started by "Get started" and shown at the foot of the window from then on. A dictation begun or targeted inside the app’s own windows is excluded permanently from history and evaluation recording for that session. The Saving bar remains accessible during setup. An install that was set up before there was a first run is taken to be set up; Settings shows the guide again.

### The menu-bar icon and menu

- **The icon** is a template image drawn in code (`src/shared/icon-shapes.ts`), so it has one colour and tells its states apart by shape: five bars when ready; a filled capsule with the bars cut out while the microphone is live; three bars and an exclamation mark when something needs the user; five dots while paused; bars standing on a line while every dictation is being saved. When several hold, the first of these is shown. Its tooltip is the status line, which names what stands in the way in the same order as Home, and is worked out again when the pointer reaches the icon.
- **The menu**: the status line; Undo Cancel or Retry while the pill offers it, and Stop and Cancel during a hands-free recording; Paste and Copy Last Dictation; Recent (the last five, choosing one copies it); Mode; Microphone (the ones connected, and those in the order of preference that are not); Pause Dictation for 1 Hour, or Resume; Open; Advanced (Save Every Dictation, Show Saved Dictations, Show Log); Buy me a coffee, once there is an address; Quit.
- **Pause** turns every shortcut off for an hour (the helper is given an empty table, so the keys are the user's own again), for a game or a presentation. A dictation under way is ended with its text kept. It ends by itself at the time it shows, also when the Mac slept in between, on Resume, or when the app is started again.
- **The app's own menu** replaces Electron's default: Settings… (⌘,), the Edit menu that makes Copy and Paste work in the window's fields, and Zoom for larger text. With no Dock icon the menu bar does not show it; its shortcuts work all the same.

### Text handling

The first milestones ship two modes. Wispr Flow's four cleanup strengths and four tones come later, once their exact edits are written down and evaluated.

|                       | Verbatim                         | Cleaned                         |
| --------------------- | -------------------------------- | ------------------------------- |
| What you get          | The recognizer's text, untouched | The same words, tidied          |
| Uses Ollama           | No                               | Yes, with a rules-only fallback |
| Wispr Flow equivalent | None                             | Light                           |
| Arrives in            | Milestone 1                      | Milestone 2                     |

Example (illustrative, not measured output):

- **Spoken:** "um so let's meet thursday no wait friday at 3 pm and uh bring the the q3 report"
- **Verbatim:** "Um, so let's meet Thursday, no wait, Friday at 3 PM and uh bring the the Q3 report."
- **Cleaned:** "So let's meet Friday at 3 PM and bring the Q3 report."

Allowed edits, which the guard and its tests are written against:

| Edit                                                        | Verbatim | Cleaned                                 |
| ----------------------------------------------------------- | -------- | --------------------------------------- |
| Dictionary replacements (once the dictionary exists)        | yes      | yes                                     |
| Remove hesitation sounds (um, uh, er) and stutters          | no       | yes                                     |
| Fix punctuation and capitalization                          | no       | yes                                     |
| Apply a self-correction, keeping only the corrected version | no       | yes                                     |
| Spoken commands ("new line", "new paragraph")               | no       | yes                                     |
| Fix an obviously mis-recognized word                        | no       | yes, tightly limited                    |
| Change numbers, names, emails, URLs or negations            | never    | never, except inside a retracted phrase |
| Reorder, rephrase, summarize, translate or add content      | never    | never                                   |

The raw transcript is kept for every session, so "use the raw transcript" is always available when cleanup or a rule got something wrong.

**Deferred until defined and evaluated**

- **Medium and High levels** (Wispr Flow parity): their allowed edits are not specified yet.
- **Styles:** four categories (personal, work, email, other), each set to formal / casual / very casual / excited. Proposed exact edits, not yet evaluated:
  - Formal: no change.
  - Casual: drop the final period.
  - Very casual: casual, plus lowercase sentence starts.
  - Excited: the final period becomes "!".
- **Lists** and the full spoken-punctuation set.
- **Snippets:** a spoken trigger phrase expands to saved text (Phase 6).

### History and recovery

- **First milestones: memory only.** The recovery buffer holds the last 20 sessions: raw transcript, final text and outcome. It is cleared on quit. The overlay holds a session's audio until the session is over (pasted, refused or failed), so that a crashed speech worker can be given it again and a cancel at any point can be taken back. After a cancel or a failed decode it holds it for as long as the Undo or Retry offer is shown, and no longer.
- **What it provides:** paste-last (`Cmd`+`Ctrl`+`V`), copy-last (`Cmd`+`Ctrl`+`C`), the Copy, Undo and Retry actions on the pill and in the menu-bar menu, and the raw transcript. It is the safety net, and it is not the history: pausing the history does not empty it.
- **A paste that looked successful is still recoverable.** The app cannot prove text appeared in the editor, so every session goes into the buffer regardless of the paste outcome.
- **The history** (`src/main/history/history-store.ts`) is what the History page, Home's "Recent" and the menu's Recent list. It is kept from the records the session controller makes, whatever the outcome: a dictation that was refused, cancelled or heard nothing is listed too, with how it ended.
  - **What is stored for each dictation:** what was heard and what was written, the app it was meant for (by name), how it ended, the mode and how the text was tidied, how long the recording was, and where the time went. Never the audio.
  - **Where:** in a SQLite database kept by a process of its own (the storage process, below). By default the database is in that process's memory, with the newest 1,000 dictations. Keeping the history on disk is a choice confirmed in a system dialog; then it is `history/history.sqlite` in the app's data folder (`0700` folder, `0600` file). It is not encrypted. Main keeps the eight newest rows as the pages show them (each with its first 240 characters) and the counts, and a copy of a write only until the storage process has written it; a page asks for the list, an opened dictation or a copy when it needs one.
  - **How long:** each dictation is deleted by the time it was made, at the start, as dictations arrive, and every hour. Switching to "Only until I quit" moves every dictation into memory and then deletes the files; the 1,000 limit does not apply for the rest of that run. The page groups the list by local days itself.
  - **At launch, nothing is deleted on the strength of a default.** The files are removed at the start only when the settings file itself states "only until I quit" (`SettingsStore.stated`), and a setting saved since says nothing about it: an unstated `historyKeep` is not written when anything else is saved (QA-01). When the file does not state it (it is damaged, was reset, or was written by a build that does not know the entry), "only until I quit" is merely the default: the files stay where they are, unopened and unlisted, History and Privacy say that they are there (`leftOnDisk`), choosing a time under Keep lists them again, and Delete All removes them. The question that a time puts counts what it would list again and what it would delete at once, before anything is opened.
  - **The format before the database:** a day's JSON file is moved into the database in one transaction with a receipt, and removed only once the receipt is there; a file that cannot be read is kept and counted; a changed file that was moved before is not moved again. A day's file that was never finished is removed at the start.
  - **Pause:** while "Pause history" is on, new dictations are not added anywhere; dictation, paste-last and the figures go on as before.
  - **Delete:** one row at once, on the page's word (a key that is held deletes one row, not one for each repeat); all of it, after the dialog, which says that Paste Last and Copy Last still have the last dictations (Delete Everything takes those too). Every file the history owns is counted whether or not it can be read, Delete is offered while any is there, and a file that will not go is said, file by file (QA-07). The questions name a file that cannot be read also when dictations are listed beside it, and say that it is deleted too.
  - **Search** looks in what was written, what was heard and the app's name.
  - **Not listed:** a tap that was no dictation, and a dictation into the app's own windows (the practice of the first run, a sentence tried on the Cleanup page). Whether the keyboard is in one of the app's own windows is noted as the recording begins and again when the destination is read: a practice that is cancelled or interrupted while the key is held never gets as far as the second.
- **Evaluation recordings are separate and opt-in.** When "Save every dictation" is switched on in the tray menu, each dictation's recording and the text the recognizer heard are saved for the Phase 3 comparison. The folder is `~/Library/Application Support/Whisper Flow/evaluation`, outside the repository, so a recording of someone's voice cannot be committed by accident. The folder keeps its original name after the Say the Word rename for compatibility. This is the one place where the app writes what was said to disk, and it is off unless chosen.
  - **Which dictations:** those begun while it is on, and not in one of the app's own windows (QA-03). What is saved is decided when the session is over and its recording let go, from how it ended last: a dictation is saved with what was heard, also after Undo or Retry, and one in which no speech was heard is saved with nothing beside it to correct; a cancel that was not taken back is not saved.
  - **Stop Saving** takes back every session not yet saved, its recording included, even one being written at that moment (QA-04); turning it on again does not reach back. What was saved stays, until Privacy deletes it.

## Repo layout

As built up to Phase 2; later phases add the entries marked with their phase.

```
whisper-flow/
├─ package.json · electron.vite.config.ts · electron-builder{,.dev}.yml · tsconfig.{node,preload,web,worklet}.json
├─ native/flow-helper/                      SwiftPM package, the only non-TypeScript code
│   ├─ Sources/FlowHelperCore/              logic, unit-tested: protocol, shortcut matcher, dispatcher, password-field rule,
│   │                                       Secure Input history, modifier state, the rule for when the helper may post keys,
│   │                                       the order of a paste and its expiry, the clipboard copy
│   └─ Sources/FlowHelper/                  main · EventTap · Target · PasteTransaction · KeyLayout · SecureInput · SystemActions · TestTools
├─ src/shared/                              helper-protocol · stt-protocol · ipc · ipc-channels · ipc-values · bridge · keycodes (the
│                                           shortcut table for either dictation key) · audio-format · wav · wer · jsonl ·
│                                           raster · icon-shapes (the icons, drawn in code) · third-party (whose work ships) ·
│                                           test-switches (which builds may act on the test switches)
├─ src/main/
│   ├─ index.ts                             lifecycle, single instance, wiring, test switches, --smoke
│   ├─ smoke.ts · debug-control.ts          self-check; control line for the automated tests
│   ├─ quitting.ts                          one quit at a time: the storage's last writes and the helper's tidy exit
│   ├─ log-file.ts                          the log on disk: what happened to each dictation, never what was said
│   ├─ test-switch-policy.ts                a release build drops the test switches before anything reads them
│   ├─ app-url.ts · app-protocol.ts · security.ts   the app:// pages, and who may talk to main
│   ├─ native/helper-bridge.ts              spawn, JSON-lines RPC, restart with backoff, replacement on a late permission grant
│   ├─ hotkeys/                             session-machine (the state machine above) · route-helper-event (and its log lines)
│   ├─ dictation/
│   │   ├─ session-controller.ts            session ids, cancel and interruption rules, point of no return
│   │   ├─ speech-service.ts                microphone commands, worker lifecycle, model load and unload, recording limit
│   │   ├─ wire-dictation.ts                connects helper, speech, pill, power events
│   │   ├─ pill-presenter.ts · pill-messages.ts   what the pill shows and says
│   │   ├─ recovery-buffer.ts               last 20 sessions, in memory: what paste-last and Undo fetch
│   │   ├─ evaluation-sessions.ts · evaluation-recorder.ts   which dictations "Save every dictation" saves, and where
│   │   ├─ pause.ts                         "Pause dictation for an hour"
│   │   └─ session-metrics.ts               per-session timings and loudness, for the latency gates and the log
│   ├─ history/                             history-store (SQLite, in the storage process) · from-session
│   ├─ storage/                             storage-host (main's side) · storage-service · storage-worker · sqlite
│   ├─ hub/                                 wire-hub (what the pages may ask for) · questions (what each dialog asks) · ollama-address
│   ├─ privacy/                             network-ledger (every address tried) · stored (what is on disk, and deleting it)
│   ├─ system/                              confirm (the system dialog) · login-item · other-dictation-app · diagnostics
│   ├─ microphones.ts                       the order of preference, and which one a dictation uses
│   ├─ stt/                                 stt-host · stt-worker · transcriber · chunk-planner · vad · sample-buffer ·
│   │                                       model-catalog · model-store · models-dir · engines/sherpa-parakeet
│   ├─ cleanup/                             Cleaned mode: rules · ollama-client · local-only · prompts · guard · refiner ·
│   │                                       ollama-app (whether Ollama is installed, and starting it)
│   ├─ text/words.ts                        what a word, a hesitation, a correction and a protected token are; snippets and style later
│   ├─ windows/                             overlay-window · hub-window · tray · tray-status (the menu-bar line,
│   │                                       in Home's order) · tray-icon · app-menu · load-renderer
│   ├─ support.ts                           where "Buy me a coffee" leads, once there is such a page
│   └─ store/                               settings (one JSON file) · settings-changer ·
│                                           usage (counts of words and timings, for Home's figures, in usage.sqlite)
├─ src/preload/{overlay,hub}.ts
├─ src/renderer/tokens.css · styles.css     the design's tokens; the pill's and the windows' styles
├─ src/renderer/microphone.ts               the microphone request and the level scale, shared by the pill and Settings
├─ src/renderer/overlay/                    Pill.tsx · pill-view (what to draw, what VoiceOver says) · pill-store · sounds ·
│                                           capture/{mic-capture,pcm.worklet,load-worklet}
├─ src/renderer/hub/                        App (sidebar and pages) · Home · History · HistoryDetail · Cleanup · Settings · Privacy ·
│                                           About · FirstRun · DictationRow · components · mic-test (the level meter) · use-facts ·
│                                           and what each page says, apart from the window and tested: home-status · history-view ·
│                                           cleanup-view · privacy-view · settings-view · first-run · model-step · format
├─ scripts/                                 build-helper · check-build · check-pack · setup-signing · download-model ·
│                                           make-fixtures · make-icon · bench-stt · pipeline-cli · eval-stt · eval-cleanup ·
│                                           test-helper · test-app · test-e2e · capture-ui · check-not-running · pack ·
│                                           check-out-free · run-from-out (who is using out/) · bench-storage ·
│                                           lib/ (args, build-output, mac-in-use, speech, evaluation-text, wav)
├─ tests/{unit,renderer,fixtures}/          fixtures/audio/ and fixtures/personal/ are git-ignored
└─ docs/                                    this plan set, tracker, progress log, benchmarks
```

Nothing is borrowed for the interface: the sounds are generated in code, and the menu-bar icon and the app icon are drawn in code from the same shapes (`npm run icon` writes `build/icon.icns`).


### The storage process

History and the figures are kept by a utility process of their own (`src/main/storage/`): `node:sqlite` is synchronous, and in this process it holds up nothing else. Main talks to it through `storage-host.ts`, with `birpc` pairing each answer to its request; `storage-service.ts` is what the process does with a request, and `storage-worker.ts` is the process around it. Every answer comes with a snapshot: the counts, the eight newest rows, the figures, and which writes the process holds without having written them.

- **Paste never waits for the history.** A dictation's write is handed over and main goes on. A write the disk will not take now (a folder that has stopped taking writes, a database that will not open) is held by the storage process, listed all the same, and written when the disk takes it again; main keeps its own copy until then, so that a storage process that stops can be given it again. Dictations and counts wait in separate lanes: a counts database that cannot be opened keeps no dictation out of the history. A write the process refuses for what it carries is dropped and said, never tried forever. What waits is tried again after a second, then less often, up to every half a minute (`p-retry`), and the History page says so while anything waits (QA-06). At most 1,000 writes, or 16 MB, wait in each lane; a dictation that arrives when its lane is full is not kept, and the page says that too, while a count that does is only logged.
- **A storage process that stops** is started again at the next request. One that will not start is not kept, and is not started again at every request. History kept on disk loses nothing: what was held is given to the new process. History held in memory goes with the process, and the History page says how many dictations were lost, until Delete All. Quitting waits at most three seconds for what is still to be written, and meanwhile up to a second and a half for the helper to put the clipboard back; a second Quit waits for the first, and no storage process is started at quit only to be closed. A change of Keep or Pause made while the process could not be told is what the next one starts with.
- **The databases** use DELETE journaling, full synchronisation and secure deletion. A database that is damaged, or was written by a newer build, is kept as it is and said, never replaced by an empty one. In memory, no file is made at all. `usage.sqlite` holds words per day for fourteen days and the last forty timings per mode, numbers only; it is made when there is something to count. The process's own output goes to the app's log, apart from `node:sqlite`'s notice that it is experimental. An operation that was carried out is not reported as failed because a read after it failed.

### Delete Everything (QA-05)

It goes further than the stores on disk, and its dialog says so. Every saving of a recording is called off first, then the dictation under way is cancelled without the path that keeps its text, the recovery buffer is emptied, Undo and Retry are withdrawn, every recording held for them is let go, a result still on its way for one of those sessions is not kept when it arrives, and the pages are put back to nothing. Dictation, Paste Last, Copy Last and the pages' requests wait until it is over: two deletions at once each count. Then the history, the recordings, the log and the counts are deleted, each waited for, and what would not go is said. Settings and the speech model stay; text already pasted into another app is not the app's to delete.
