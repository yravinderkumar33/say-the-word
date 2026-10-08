# Design brief

Part of the plan set: [01 Research and decisions](01-research-and-decisions.md) · [02 Architecture and behaviour](02-architecture-and-behaviour.md) · [03 Implementation phases](03-implementation-phases.md) · [04 Implementation reference](04-implementation-reference.md) · 05 Design brief

What the interface should become, the brief that was given to Claude Design, and what has been built from the design so far. Task status is in the [tracker](tracker.md).

## Where the design is

The interface is designed in Claude Design, one round at a time, from the brief below. Round 1 showed three directions; the owner chose **direction A**: a dark pill whose one colour, green, means the microphone is live, and windows that look at home on a Mac.

- **Project:** "Whisper Flow interface design", <https://claude.ai/design/p/9f36730e-333c-4777-af56-b995e0d47467>.
- **Files:** `Round 1 Directions.dc.html`; `Round 2 Direction A.dc.html` (the pill, Home, the components, the tokens); `First Run.dc.html`; `Home and History.dc.html`; `Dictionary Cleanup Privacy.dc.html`; `Settings About Apps Snippets.dc.html`; `Icons and Menu.dc.html` (the menu-bar icon's five states, the menu, the app icon); `Accessibility.dc.html` (the review of all of them: contrast, focus order, what VoiceOver says, and the look with Increase Contrast and Reduce Transparency). Each is a page template with a script: the values, the states and the timings are in the script.
- **The design is the specification.** Sizes, colours and durations are taken from it and named in `src/renderer/tokens.css`. Where the design and the engine disagree, the engine's behaviour is kept and the difference is listed below.
- **Left out by the owner's decision (2026-10-04): Dictionary, Apps and Snippets.** Neither the screens nor what they would do is built, and the sidebar does not list them. The dictionary a settings file can still hold is applied as before; nothing in the interface edits it.

## What is built

Every screen of the design except those three, on 2026-10-04. Round 2 came first; the rest followed in one piece of work.

| Part of the design | Where it is | Notes |
| --- | --- | --- |
| Tokens | `src/renderer/tokens.css`, mapped for Tailwind in `src/renderer/styles.css` | Light and dark for the windows, one look for the pill, and the Increase Contrast, Reduce Motion and Reduce Transparency variants |
| The pill: every state, variant and message | `src/renderer/overlay/Pill.tsx`, `pill-view.ts`, `pill-store.ts`; decided in `src/main/dictation/pill-presenter.ts` and `pill-messages.ts` | What VoiceOver says for each state is `spokenFor` in `pill-view.ts`. The pill follows three settings: sounds, shown at rest or only while dictating, and the dictation key it names |
| A way without the pointer for every pill button | `src/main/windows/tray.ts` | Undo Cancel, Retry, Stop Dictation, Cancel Dictation, Paste Last Dictation, Copy Last Dictation |
| Home | `src/renderer/hub/Home.tsx`, `home-status.ts` | The status line: "Ready", or the one thing needed with its one button. Paused, and another app on the same key, are two of those things |
| The first run | `src/renderer/hub/FirstRun.tsx`, `first-run.ts` | Welcome, Microphone, Accessibility, Keys (only when another dictation app is on the key), Try it, Cleaned mode, Ready. `firstRun` in the settings says whether it is still to be gone through; Settings can show it again |
| History, and a dictation opened | `History.tsx`, `HistoryDetail.tsx`, `DictationRow.tsx`, `history-view.ts`; kept by `src/main/history/history-store.ts` | In memory unless the owner chooses otherwise in a system dialog. Search, pause, how long it is kept, Delete All; opened: outcome, mode, the reason with one fix button, heard beside written with the differences marked, timings |
| Cleanup | `Cleanup.tsx`, `cleanup-view.ts` | The two modes as cards, Ollama's state with one action, the models that run on this Mac, a refusal in words, and "Try it": one sentence three ways with the time each took |
| Privacy | `Privacy.tsx`, `privacy-view.ts`; facts from `src/main/privacy/` | What was contacted since launch (counted by the app itself), what is stored and how much, Show in Finder and Delete for each, Delete Everything |
| Settings | `Settings.tsx`, `settings-view.ts`, `mic-test.ts` | Shortcuts, microphones in order with a ten-second test, sounds, the pill, Open at login and Show in Dock, the speech model and how long it stays in memory, the log, the Ollama address |
| About | `About.tsx`, `src/shared/third-party.ts` | Version, the licences (the speech model's among them), and the coffee link once there is an address |
| The menu-bar icon in five shapes, and the menu | `src/shared/icon-shapes.ts`, `raster.ts`, `src/main/windows/tray-icon.ts`, `tray.ts` | Ready, live, needs attention, paused, saving: told apart by shape, drawn in code. The menu in the design's order, with Recent and Pause |
| The app icon | `scripts/make-icon.ts`, `build/icon.icns` | `npm run icon` draws it from the same shapes |
| The app menu | `src/main/windows/app-menu.ts` | In place of Electron's own, which offered the developer tools |
| Components | `src/renderer/hub/components.tsx` | Keys (keycaps), button, link, segmented control, pop-up, switch, radio mark, field, chip, app tile, notice, meter, progress bar, saving bar |
| The figures line | `src/main/store/usage.ts` | Counts only, in `usage.sqlite` |
| The "Buy me a coffee" link | `src/main/support.ts` | Hidden until an address is set |

**How it is looked at.** `npm run pictures` makes about sixty pictures from a quiet instance: the menu-bar icon's five shapes, the pill's states, every page in light and dark, the first run step by step, and the pill and two pages drawn as Increase Contrast and Reduce Transparency draw them.

**Where the build differs from the design, and why**

The pill and Home (Round 2):

- **"Loading the speech model…" is said while the text is awaited, not while the microphone opens.** The design shows it on the Starting pill. In the app a recording starts at once and the model loads meanwhile, so the wait for the model is felt after the key is released.
- **"No sound from …" is said only when nothing has been heard since the recording began**, and "no sound" means silence in the signal (about -76 dB). A pause in the middle of a dictation is not a silent microphone, and a working one in a quiet room is far louder (about -57 dB on the development Mac).
- **The mark for waiting text stays through a press that is no dictation.** The design clears it "when the next dictation starts". A lone tap, or `Fn` with an arrow key, starts a recording and drops it without a trace, and the text is still there to be fetched.
- **A message waits under the pointer for a minute at most.** The design holds it for as long as the pointer stays. A recording kept for Undo or Retry is held while its message shows, and that must end when nobody is there to move the pointer.
- **A pill that is not shown at rest does not show the mark for waiting text either.** The setting says "only while dictating"; the text is in the menu-bar menu and in History.
- **While dictation is paused the pill and the menu name no shortcut.** The hint for waiting text says "Unpasted dictation · paused until 11:42" and keeps its Copy button, and the menu drops ⌘⌃V and ⌘⌃C from beside its two items: the shortcuts are off then, and the items still work.
- **Recent says "Not pasted: Secure Input" or "Not pasted: interrupted"** where the design has only "focus moved" and "Cancelled": those are the other ways a dictation with text ends without a paste.

The first run:

- **The download starts when "Get started" is pressed, not by itself at the first step.** The rule is that the app downloads only what the user starts. The step says what will be fetched and how large it is.
- **The Keys step is shown only when another dictation app is running on the same key**, and it has no button that quits that app: it says to quit it from its own menu, and goes on by itself when that is done. The variant for a Globe key that is set to do something else is not built: whether a tap of the key reaches the system is the gate that still waits on a person.
- **"Continue without the check" appears when nothing has been heard for ten seconds.** A microphone that works and a room where one cannot speak aloud should not end the setup. After a minute the check lets the microphone go and offers "Listen Again": "on during this check" is not for as long as the window is left open on that step.
- **The drawing of the pill beside the practice box moves by itself**, not with the real level: the level stays in the overlay page, where the microphone is.
- **Settings has "Setup guide: Show Again"**, which the design does not: the steps teach the gestures, and are otherwise seen once.
- **Shown again, the Cleaned step starts from the settings in force.** Its Skip keeps the mode in use ("Skip and keep Cleaned"); on a first run it still keeps Verbatim. The step shows the model the settings name, even when Ollama does not list it, and "Use Cleaned" with nothing picked changes only the mode: an Ollama that is not running yet does not cost the model already chosen.

History:

- **An opened dictation cannot name the app the focus moved to.** The app records where the text was meant for. The reason says that the focus moved, and offers Copy.
- **"Use the Raw Text" copies it.** The dictation was pasted, or not, a while ago, into a place that may be gone.
- **"Add a Correction to the Dictionary…" is left out**, with the dictionary.
- **The list in memory holds the last 1,000 dictations.** A list that is "gone when the app quits" should not grow for as long as the app runs.

Cleanup, Privacy, Settings, About:

- **The two mode cards are the mode switch.** In the design they are an illustration, with the switch on Home.
- **A refused model is refused for the engine's reasons**: it would run on another machine, it is not there, or the address is not this Mac's. The design's example of a model too large for the Mac's memory is not something the app measures.
- **Privacy has a fourth stored thing, the word counts**, and Delete Everything covers it. The figures line needs them, and a page that lists what is stored lists all of it.
- **There is no shortcut recorder.** The dictation key is a choice of two (`Fn`, or `Control`+`Option` for keyboards without it), and the other shortcuts are shown and fixed. A recorder decides what a system-wide key tap swallows, and that can only be checked with a physical keyboard; the check of `Fn` itself is still waiting on a person.
- **A microphone is used in the order set, and until one is set the system's default is.** The design starts with an order.
- **"Save every dictation" can be switched off in Settings and on only in the menu.** A page can stop the saving and cannot start it.
- **About has no "Check for Updates"**, and says so: the app looks nowhere for a newer one until Phase 8. The links to the source and to "Report a problem" are not shown until the repository has an address, and the note from the maker waits for the coffee link's address.
- **The app icon has one look.** The design's dark variant is not shipped.

Throughout:

- **The page titles share one position.** The design's files place them four to eight pixels apart.
- **The sidebar is solid.** The design allows a translucent one.
- **Text one size larger is the View menu's Zoom In.** A web page has no system text size to follow.

## What the interface should gain

Ordered by how much each changes whether someone other than its author can use the app. "Planned" means the Phase 5 or 6 list in [03 Implementation phases](03-implementation-phases.md) already has it; "new" means it does not. What is built is in the table above.

### First: what a new user cannot do without

1. **A guided first run with a practice dictation** (planned, expanded). One step per screen; the 671 MB model downloads in the background from the first step; a microphone check with a live meter; a practice field where a first dictation, hands-free and Esc-then-Undo are each tried once; a closing cheat sheet with "Open at login". New here: the practice, and a "keys" step shown only when the Globe key or another dictation app would get in the way. _Today the checklist ends at "Ready" without the user having dictated once, and nothing teaches hands-free, Esc or ⌘⌃V._
2. **A main window with navigation** (planned): Home, History, Dictionary, Cleanup, Settings, Privacy, About. _Today every control is a menu-bar submenu, a file or a log._
3. **Settings** (planned; three items new). A shortcut recorder with a Ctrl+Option fallback for keyboards without Fn; microphone order, each with a Test button and meter; sounds on/off and volume; pill shown at rest or only while dictating; Open at login, starting without a window. New: how long the speech model stays in memory, the Ollama address, and a notice when the chosen microphone is missing (today it falls back silently).
4. **A dictionary editor** (the feature works; it has no UI). "When I hear … write …" pairs, plus "add a correction" from a past dictation. _Today it means editing `settings.json` and restarting the app, and the next menu change overwrites an edit made while the app runs._
5. **Recent dictations, then History** (the buffer exists; history is planned). First, the last 20 texts the app already holds in memory, listed with Copy and raw beside final, labelled "gone when you quit". Then, once the storage decisions in doc 02 are made, history on disk with retention, pause, search and delete all. _The recovery buffer is the safety net and nobody can see it; a pill message lasts six seconds._
6. **A pill that explains itself** (hover hint and right-click menu planned; the rest new). Words on slow starts ("Waiting for the microphone…"); a timer in hands-free and a countdown in the last minute; "No sound from <microphone>" after a few silent seconds; an icon per kind of message; a mark that stays while unpasted text is waiting; Cancel shown only when processing runs long. _Someone looking at their document learns of a failure only from a low sound._
7. **Cleaned mode set up in a window** (exists in the menu). Ollama's state with one action (Start Ollama, planned); models with the refusal reason in words; "Rules only (no model)", which needs a file edit today; the before/after example; what Cleaned may and may never change.
8. **"What happened to my dictation?"** (new). Each dictation's outcome, with the reason it was not pasted or not cleaned in plain words and one fix button, in History and on Home's status line. The log already records all of it, without the words. Also plain wording for raw errors that reach the pill today (`paste: text is too long`, engine errors). _The first report from real use was "the text is not getting pasted", and the answer was in a log file._
9. **An identity** (new). An app icon; menu-bar icon states for ready, microphone live, needs attention, paused, saving; one accent colour; a real app menu in place of Electron's default (which offers Developer Tools); an About page showing the licences the speech model requires (Parakeet is CC-BY-4.0, and no window shows it).

### Next: what makes it better than the alternatives

10. **A Privacy page with live facts** (new): what is stored, where and how much, each with Delete; what has been contacted over the network since launch; evaluation recordings; the log. _Local-only is the reason to choose this app, so show it instead of stating it._
11. **Rules per app** (new; leads into Phase 7): Verbatim in terminals and editors, Cleaned in mail and chat, "never dictate into this app".
12. **A "Try it" comparison** (new): one sentence as Verbatim, rules only and Cleaned side by side with timings. It is `eval:cleanup` as a screen.
13. **The menu-bar menu rearranged** (new): status, Paste last, Copy last, Recent ▸, Mode, Microphone, Pause dictation for 1 hour, Open, Advanced ▸, Buy me a coffee…, Quit. Undo and Retry appear in the menu while the pill offers them, which gives keyboard and VoiceOver users a way to reach them. Evaluation and Show Log move under Advanced; saving can still be switched on only from the menu, as the code intends (a page can stop the saving, not start it).
14. **Snippets** (planned, Phase 6).
15. **One figures line on Home** (new, optional): words today and this week, typical release-to-text. Measured numbers only, no "time saved" estimate. The plan left Wispr Flow's "insights" out; this is a far smaller local version, and the coffee note below hangs on it.
16. **Buy me a coffee** (asked for by the owner; next section).

**Leave room for, design later:** Command Mode's pill state (Phase 7), styles and tones, more languages and a second engine (Parakeet has no Hindi), Check for updates (Phase 8), a live word count during long recordings.

**Not recommended:** accounts, sync, notes and meeting recording (already out of your plan); streaks and badges; system notifications for routine outcomes; transcript text shown on the pill; a meter that opens the microphone just because a page is open (it would make "On only while you dictate" untrue); any embedded widget or remote content.

## Buy me a coffee

- **Where:** the About page (a few sentences from the maker, the button, "Opens buymeacoffee.com in your browser"); a quiet link at the foot of the sidebar; "Buy me a coffee…" in the menu-bar menu; and once, after a milestone such as 10,000 words, one sentence on Home's figures line until dismissed (needs the count from item 15).
- **Never:** on the pill, during a dictation, as a pop-up, or twice.
- **Inside the privacy rules:** it is a link the user clicks, opened in their browser. The address is a constant in the main process and the page asks main to open it (`openLink('support')` on `HubBridge`, answered in `src/main/index.ts` with `shell.openExternal`). Pages cannot navigate or open windows (`src/main/security.ts`) and the content policy allows nothing remote, so the button is drawn in the app and Buy Me a Coffee's own widget and button image are not used. Doc 02's network rule gains one clause: links the user clicks open in the browser.
- **Waiting on the owner:** the page address. It goes in `SUPPORT_URL` in `src/main/support.ts`; until it is there the link, the menu item and the sidebar entry are not shown. Nothing ships with a placeholder link.

## The brief

Paste this into a new Claude Design project, with pictures of the current interface and `src/renderer/styles.css`, `src/renderer/overlay/Pill.tsx` and `src/renderer/hub/App.tsx` attached. It asks for three directions on one static page and stops. Pictures can be made without taking the keyboard or the focus: start the app as `scripts/test-app.mjs` does and use `capture-pill`, `capture-hub` and `capture-tray` on the control line (see "Test tools and safeguards" in the reference).

```text
# Whisper Flow: design the interface of a local-first dictation app for macOS

"Whisper Flow" is a working title and will change. Keep the name in one place so it can be swapped, and do not build the icon on its letters.

## What I need

Whisper Flow is a macOS menu-bar app: hold a key, speak, and the text is typed into whatever app you are using. The engine underneath is finished and dependable. The interface is a developer's placeholder: a tiny status pill, a one-page setup checklist and a menu-bar menu. Design the real interface: one a new user can set up without help, that explains itself while they dictate, and that makes the app's main promise visible, which is that everything runs on their Mac.

Work in rounds and stop after each one so that I can steer. The round to do now is described at the very end. Everything between here and there is reference for all the rounds.

If pictures or source files of the current app are attached, they are the "before": they show how it behaves today. Where their wording or look differs from this brief, the brief wins.

## The product

- Hold Fn and speak; let go, and the text is pasted where the cursor is. For longer dictation, press Fn twice (or Fn+Space), speak with hands free, and press Fn again to stop. Esc cancels. ⌘⌃V pastes the last dictation again; ⌘⌃C copies it.
- Two modes. Verbatim keeps every word, with the punctuation and capitals the recognizer gives it. Cleaned is the same words tidied (hesitations, false starts, punctuation) by a model running on this Mac. Cleaned never changes numbers, names, email addresses, links or a "not", and never rephrases or adds anything.
- The model for Cleaned runs in Ollama, a separate free app that the user installs; Whisper Flow does not include it. "Rules only" is Cleaned without a model: chosen on purpose, or used when Ollama is not running or the model is too slow. It is not a third mode: the mode switch always has two positions.
- Private by construction. Speech is recognized on the Mac. There is no account, no cloud and no telemetry, and what was said is written to disk only if the user chooses to keep a history.
- Careful about where text lands: only in the place the user was in when they stopped speaking, and never in a password field. When a paste is refused, the text is kept and offered back.
- Fast. The microphone is live about a tenth of a second after the key goes down, and the text arrives about 0.4 s after it is released (about a second in Cleaned mode, at most about four).

Who uses it: people who write all day (messages, email, documents, code, prompts to coding tools). Many are leaving a cloud dictation app because they want their voice to stay on their machine. They are at home on a Mac but not all are technical. They dictate dozens of times a day, so the interface must be readable at a glance and never in the way.

## Fixed constraints

- macOS 14 to 26 on Apple Silicon. The shipped app is built with Electron, React 19 and Tailwind CSS 4, and your design will be handed to Claude Code to build. From Round 2 on, express colour, type, spacing, radius, shadow and motion as named tokens (CSS variables) and build screens from a small set of reusable components.
- The shipped app loads nothing from the network, so the design must not depend on web fonts, icon libraries or remote images. Use the system font (SF Pro through `system-ui`) and draw icons yourself as simple inline SVG. For other apps' icons, draw a neutral rounded square with the app's initial; the real app reads them from the system.
- In prototypes, simulate audio levels, permissions, downloads and Ollama. Do not ask for the real microphone.
- Three surfaces exist: the pill (a floating overlay), the main window, and a native menu-bar menu. Native menus are standard macOS menus: list their items, do not style them.
- The pill lives in a transparent, always-on-top strip of 420 × 140 px at the bottom centre of the screen, just above the Dock, on every Space and over full-screen apps. It never takes keyboard focus, and clicks pass through the strip everywhere except on the pill's own controls. The strip is fixed; the pill's sizes inside it are yours (today: 40 × 8 px at rest, 28 to 32 px tall and up to 400 px wide when active), and it may grow to two lines. Everything it draws, including a hover hint, must fit in the strip. It has one look that does not follow the system's light or dark mode, because what is behind it has nothing to do with the system appearance, and it must read on light, dark and busy backgrounds alike. At rest it should almost disappear.
- The main window opens at 900 × 720, can shrink to 720 × 480, and follows the system's light or dark appearance. It may use an inset title bar with the traffic lights over a sidebar, and the sidebar may be translucent; nothing else should depend on blur.
- Key names are variables: shortcuts can be changed, and keyboards without Fn use Ctrl+Option. Design with Fn (the key with the globe on newer keyboards), draw keys as a keycap component, and check each string with ⌃⌥ in its place.
- UI text is British English with -ize spellings, as in the existing strings: "Cancelled", "recognizer", "licence".
- The pill's position and behaviour are fixed by the engine; its look is yours. Do not reuse the shapes, colours, icon or wording of Wispr Flow, superwhisper or any other dictation app.

## Direction

- A quiet, exact instrument that belongs on a Mac: calm surfaces, generous spacing, strong typographic hierarchy. Closer to a well-made system utility than to a marketing page. No gradients for their own sake, no sparkles, no mascots, no streaks or badges.
- Colour: one accent, plus amber for "what you say is being saved" and one colour for problems. The two status colours never appear without an icon and words.
- A rule to try: the accent means the microphone is live. It appears while audio is being captured (the pill while listening, level meters) and almost nowhere else, so one glance answers "am I being heard?".
- Today's mark is five level bars (the menu-bar icon). The pill is the signature of the product, and the app icon can grow from it.
- Voice: short, plain, exact sentences that say what the app does and what it never does. No exclamation marks, no "Oops", no contractions, no hype. Lines to keep as they are: "Focus moved, so nothing was pasted". "It sees shortcut keys only, never what you type." "On only while you dictate." "Everything runs on this Mac."
- Motion: quick (about 200 ms) and meaningful. The pill changes shape from one state to the next instead of swapping.

## Surfaces (reference: build none of this until a round asks for it)

### 1. The pill

It has six states, listed first. Text waiting, the busy nudge and Command Mode are variants, not states. Sounds accompany some states, but each must be unmistakable with the sound off. A successful dictation has no state of its own: the pill returns to rest as the text appears.

- Resting. Ready, nearly invisible. Once the pointer has rested on it for half a second it grows a little and shows "Hold Fn to dictate · click for hands-free". A click always starts hands-free. A right-click opens a native menu: Paste last dictation, Copy last dictation, Microphone, Mode, Hide the pill for 1 hour (dictation still works), Open Whisper Flow.
- Starting. The microphone has been asked for and is not live yet: it is too early to speak. Usually a tenth of a second, so a short Starting must not flash. With a slow microphone it lasts longer, and after about a second words appear: "Waiting for the microphone…" or "Loading the speech model…".
- Listening. Speak now. Something that moves with the real audio level. If nothing is heard for a few seconds: "No sound from MacBook Pro Microphone" (names vary; shorten long ones in the middle).
- Listening, hands-free. The same with no key held: elapsed time (0:42), Stop as the main action, Cancel beside it. In the last minute before the 20-minute limit, a countdown.
- Processing. The text is on its way: usually under half a second in Verbatim and about a second in Cleaned. A Cancel button appears only after one second; Esc cancels throughout. In Cleaned mode, a sign that the text is being tidied.
- Message (called "recovery" in the code). Something the pill has to say after the fact. A few words, at most one offer (Undo after a cancel, Retry after a failure), Copy when there is text to give back, and an icon-only Dismiss. It leaves after six seconds, and the timer holds while the pointer is over the pill.

Messages come in four kinds. Give each kind its own icon and visual weight; colour may reinforce it but never carry it. The buttons each message has are in brackets; where there are none, it has only Dismiss.
- Plain: "Cancelled" [Undo] · "No speech heard". And two confirmations that leave after two seconds with no Dismiss: "Copied" · "Nothing to paste yet".
- Protected, text kept: "Focus moved, so nothing was pasted" [Copy] · "Password field: nothing was pasted" [Copy] · "Secure Input is on: nothing was pasted" [Copy]
- Problem: "Could not paste" [Copy] · "Interrupted. Your text was kept" [Copy] · "The recognizer took too long" [Retry] · "The microphone disconnected" · "No microphone was found" · "Stopped at the 20-minute limit"
- Note: "The clipboard now holds this dictation" · "That setting could not be saved"

Variants:
- Text waiting. Not in the current app, so the attachments do not show it. A message has gone but unpasted text remains: a small mark on the resting pill, and on hover "Unpasted dictation · ⌘⌃V to paste" with a separate Copy button. A click on the pill itself still starts hands-free. The mark clears when the text is pasted or copied, or the next dictation starts.
- Busy nudge. The key was pressed while the last dictation is still processing.
- Command Mode, for later: a visibly different listening look (hold Fn+Ctrl and speak an instruction about the selected text).

### 2. First run (in the main window)

One step per screen. Progress shows named steps, not "2 of 7", because two of them can be absent. The speech model (671 MB) starts downloading at the first step and carries on in a slim bar at the foot of the window while the user does the rest.

1. Welcome. One sentence on what it does, and the promise: "Everything runs on this Mac."
2. Microphone. Ask for permission, choose a microphone, show a live level meter, and wait until the app confirms it hears the user. "On only while you dictate, and during this check."
3. Accessibility. Why it is needed: "Lets Whisper Flow notice the Fn key and paste into the app you are using. It sees shortcut keys only, never what you type." A simplified drawing, in the app's own style, of the Accessibility list in System Settings with the Whisper Flow row and its switch highlighted. The step completes by itself when the switch is turned on.
4. Keys, shown only when needed. Either the Globe key is set to do something else (fix: System Settings › Keyboard › "Press 🌐 key to" › "Do Nothing"), or another dictation app is running and would fight over Fn (fix: quit it, or choose Ctrl+Option here).
5. Try it. A practice text field and three short exercises, each ticked off as it is done: hold Fn and say a sentence; press Fn twice for hands-free; press Esc to cancel, then Undo. A small legend shows what the pill is saying as it changes. If the model is still downloading, the exercises wait behind the bar: "The speech model is still downloading: 412 of 671 MB."
6. Cleaned mode, optional. The example below; Ollama's state; a choice of local model; "Skip and keep Verbatim".
   Spoken: "um so let's meet thursday no wait friday at 3 pm and uh bring the the q3 report"
   Verbatim: "Um, so let's meet Thursday, no wait, Friday at 3 PM and uh bring the the Q3 report."
   Cleaned: "So let's meet Friday at 3 PM and bring the Q3 report."
7. Ready. A one-card summary of the gestures, an "Open at login" switch, and where the app lives from now on (the menu bar and the pill).

Failures to design: permission refused ("Open System Settings"); download stopped ("The download stopped. What was downloaded is kept." with Try again); model damaged ("Check the model files").

### 3. The main window

A sidebar and a content area. Pages: Home, History, Dictionary, Cleanup, Settings, Privacy, About, and later Apps and Snippets.

- Home. In order of weight: the status line, the largest thing on the page; the mode switch and the microphone (a pop-up that changes it); the gestures; the last three dictations; then one figures line (words today and this week; typical time from release to text) with "Counted on this Mac. Never sent anywhere." The status line is "Ready. Hold Fn to dictate", or the one thing that needs attention with its fix button. What can need attention, in order: Accessibility is off · the microphone is not allowed · the speech model is missing or damaged · no microphone was found · Fn is taken by the system or another app · dictation is paused · Cleaned is using rules only because Ollama is not running. Home may scroll at 720 × 480, but the status line and the mode switch stay in view.
- History. Grouped by day. Each row: time, the app's icon, the first line (the widest element). A chip only when the outcome is not "Pasted" (Copied · Not pasted: focus moved · Not pasted: password field · Cancelled · No speech); the mode as a small glyph only when it is not the user's usual one. On hover: Copy. Opening a row shows the final text beside the raw text with the differences marked; the outcome and the mode spelled out; why it was not pasted, or why it was cleaned with rules only, in plain words with one fix button; the timings; "Use the raw text"; "Add a correction to the dictionary"; Delete. Header: search, a "Pause history" switch, how long history is kept (only until I quit · 7 days · 30 days · until I delete it), Delete all. Choosing to keep history on disk is confirmed in a native macOS dialog. Design the empty state, the history-paused state, and the default "only until I quit" state, which says the list is held in memory and is gone when the app quits.
- Dictionary. "When I hear … write …" pairs, for example "cloud code → Claude Code", "wisper → Whisper", "q3 → Q3". Add, edit, delete, import, export. A line saying it applies in both modes. An empty state with two examples.
- Cleanup. Verbatim and Cleaned as two cards, using the example above. Ollama's state as one row with one action: not installed (Get Ollama, which opens ollama.com in the browser) · not running (Start Ollama) · running (no action). A model picker that lists only models that run on this Mac, plus "Rules only (no model)"; a refused model is shown with the reason in the app's own words, such as "the chosen model does not run on this Mac". A short table of what Cleaned may change and what it never changes. A "Try it" box: type a sentence and see Verbatim, rules only and Cleaned side by side, with the time each took.
- Settings. Shortcuts (a recorder for dictate, hands-free, cancel, paste last, copy last, with a warning when one is taken). Microphone (an order of preference; a Test button on each row that shows a live meter for ten seconds and then lets the microphone go; no meter runs merely because the page is open). Sounds (on or off, volume, a play button for each of the five cues: speak now, stopped, hands-free on, did not paste, busy). Pill (show at rest, or only while dictating). General (Open at login, Show in Dock). Speech model (Parakeet v3, 671 MB, 25 European languages; loaded or resting; keep it in memory for 10 minutes, 1 hour or always, with what each costs: about 1.9 GB while loaded, about a second to load). Advanced (Show log, which "never contains what you said"; Copy diagnostics; Ollama address; evaluation recordings, below).
- Evaluation recordings. An advanced, off-by-default switch labelled "Save every dictation (recording and text)", which writes each recording and its text to a folder on the Mac so that the recognizer can be scored on the user's own voice. It is separate from History. It can be switched on only in the menu-bar menu; the main window shows that it is on and can switch it off. While it is on, an amber bar sits at the top of every page: "Every dictation is being saved", with "Stop saving".
- Privacy. Plain statements with live facts beside them: where speech is recognized; what has been contacted over the network since launch (normally "Nothing", or "127.0.0.1, Ollama on this Mac"); what is stored and how much (history, evaluation recordings, log), each with Show in Finder and Delete; and "Delete everything".
- About. Version, licences and attributions, "Check for updates" (manual), links to the source code and to "Report a problem" (both open in the browser), and "Buy me a coffee" (below). There is no separate help section.
- Later pages, one screen each so the navigation has room for them: Apps (a mode per app, for example Verbatim in Terminal and code editors and Cleaned in Mail and Slack; "Never dictate into this app") and Snippets (a spoken phrase that expands to saved text).

Use realistic content. Sample history: a Slack reply about moving a meeting, an email paragraph in Mail, a commit message in VS Code that was not pasted because focus moved, a prompt typed into Terminal, a cancelled dictation, a note in Notes cleaned with rules only.

### 4. Menu-bar icon and menu

The icon at 18 px is a monochrome template image, which macOS tints itself, so its states are told apart by shape alone: ready, microphone live, needs attention, paused, saving every dictation. One state at a time; when several apply the order is live, needs attention, paused, saving.

The menu, in order: a status line · the Undo or Retry offer, for as long as the pill shows it, because the pill cannot be reached from the keyboard · Paste last dictation ⌘⌃V · Copy last dictation ⌘⌃C · Recent ▸ (the last five; choosing one copies it) · Mode ▸ · Microphone ▸ · Pause dictation for 1 hour (shown as "Resume dictation" while paused) · Open Whisper Flow · Advanced ▸ (Save every dictation, Show saved dictations, Show Log) · Buy me a coffee… · Quit. A note to you, not menu text: pausing turns the shortcuts off, for games or presenting.

### 5. App icon

On the macOS rounded-square shape, checked at 1024, 32 and 16 px, with a dark variant.

## "Buy me a coffee"

The app is free and open source, and its maker would like a modest way to be thanked. It must never interrupt work.
- On About: two or three sentences from the maker, a "Buy me a coffee" button, and the line "Opens buymeacoffee.com in your browser".
- A small, quiet link at the foot of the sidebar. In the menu-bar menu, the item named in section 4.
- After a milestone ("Whisper Flow has typed 10,000 words for you."), the figures line on Home gains that one sentence and the quiet link, until dismissed. Once only.
- Never on the pill, never during a dictation, never as a pop-up or a badge. Use an original cup glyph and plain text, not the platform's own button image or widget.

## Accessibility

WCAG AA contrast in both appearances; the resting pill is exempt, because it is meant to recede and its actions have keyboard shortcuts or menu items. Never colour alone: pair it with an icon or words. Every control in the main window reachable by keyboard, with a visible focus ring. The pill cannot take focus, so for each pill state write the sentence VoiceOver should speak and name the keyboard or menu route to each of its buttons. Provide for Reduce Motion, Increase Contrast and Reduce Transparency. Text that survives one size larger.

## Round 1: what to make now

One static page with three bands labelled A, B and C, one visual direction per band. No motion, no interaction, no token sets, no other screens.

The directions must differ in structure, not only in palette. The same in all three: the system font, a sidebar with a content area, the wording. Different in each: how the pill shows live audio (level bars in at least one, something other than bars in at least one); the pill's body (solid dark, solid light, outlined); Home's layout and density (plain rows, cards); and where colour is allowed (A: the accent only while the microphone is live; B: no accent at all, live shown by shape and motion; C: your choice).

In each band:
- The pill at 3× on a strip that is half white and half near-black, in its six states: Resting; Starting; Listening; Listening hands-free at 0:42 with Stop and Cancel; Processing; and one Message, "Focus moved, so nothing was pasted", with Copy and Dismiss. Then the Listening pill once at actual size over a busy wallpaper.
- Home at 900 × 720, twice: in light with "Ready. Hold Fn to dictate", and in dark with one thing needing attention ("Waiting for the Accessibility permission", with an "Open System Settings" button). Show the status line, the mode switch, the microphone, the gestures and three recent dictations, with the full sidebar.
- One app-icon sketch at 256 px and at 16 px. The full icon work comes later.

Under each band, say in a sentence or two what it is going for and where it takes a risk. Then tell me which one you would choose and why.
```

**Follow-ups, one at a time, after choosing a direction**

1. "Direction A. Build the foundations (tokens for colour in light and dark, type, spacing, radius, shadow, motion) and the pill: every state, variant and message in the brief, with a control to step through them, at actual size and at 3× over a white document, a dark code editor and a busy wallpaper, with the transitions and a reduced-motion version."
2. "Now the first run as a click-through prototype, with a small panel to simulate: permission granted or refused, download progress and a stopped download, a damaged model, Ollama absent."
3. "Now Home and History: the row, the opened row, and the empty, history-paused and 'only until I quit' states, in light and dark."
4. "Now Dictionary, Cleanup and Privacy, each with its empty and problem states."
5. "Now Settings and About, and Apps and Snippets as one screen each."
6. "Now the menu-bar icon in its five states, the menu, and the app icon: keep the Round 1 idea and show two alternatives, each at 1024, 32 and 16 px on the macOS rounded-square shape, with a dark variant."
7. "Review everything for contrast, meaning carried by colour alone, focus order and screen-reader sentences; then show the pill and Home with Increase Contrast, Reduce Transparency and text 15% larger. Do not make the resting pill more prominent. List what you changed."
8. "Prepare the handoff for Claude Code: tokens as CSS variables in a Tailwind CSS 4 `@theme` block, the component list with props and states, and the pill's states named exactly as in the code: resting, starting, listening, listening hands-free, processing, recovery."

## Handing a round back

In Claude Design: Export → Handoff to Claude Code → Send to local coding agent. The handoff names a `claude_design` connector; where that is not set up, the project's files can be read with the design tools after `/design-login`. The pictures in the project (`shots/`) are not needed: the page files say everything.
