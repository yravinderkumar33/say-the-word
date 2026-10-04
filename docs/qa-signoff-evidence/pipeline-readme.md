# Pipeline sign-off regression check

Run from the repository root with its installed dependencies:

```sh
TSX_TSCONFIG_PATH=tsconfig.node.json node --import tsx docs/qa-signoff-evidence/pipeline-recheck.mts
```

This calls the current production `OllamaClient`, `LocalOnlyGate`, and `Refiner` with in-memory HTTP responses. It opens no sockets, contacts no server, and touches no microphone, clipboard, focus, or settings. The only transcript is a fixed synthetic fixture; output contains request counts and labels only. `inert.test` is inert response metadata, never a network destination.

The script now asserts closure of R2 and R3 from the sign-off report. An exit of zero requires zero transcript requests in every refused warm-up scenario. The previous version reproduced the defects; the historical observations remain in the report.

| Scenario                                            | Required result                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Remote warm-up                                      | One warm-up, no transcript, model blocked                                                              |
| Empty, incomplete or malformed local warm-up        | One warm-up, no transcript, rules-only fallback                                                        |
| Remote metadata in an incomplete warm-up            | One warm-up, no transcript, model blocked immediately                                                  |
| Completed local warm-up ending at its length limit  | One warm-up followed by one successful cleanup; `done_reason: "stop"` is not required for the warm-up  |
| Replacement during the warm cache lifetime          | Request order `one:warm`, `two:warm`; replacement names a remote host and receives no transcript       |
| Replacement while the original warm-up is answering | Request order `one:warm`, `two:warm`; replacement gets its own verification and receives no transcript |

`LocalOnlyGate` returns the verified server, canonical model name and digest. Both completed and in-flight warm evidence use that identity. A warm-up is accepted only after a complete local reply and an unchanged identity check; cleanup checks the identity again before sending text. A replacement requires its own warm-up. Repeated replacements and all identity checks share the existing cleanup deadline, with at most three warm-up attempts.

The unit suite additionally covers canonical aliases, delayed prewarm responses after model/server changes, replacement while an old warm-up remains in flight, missing digests, metadata cache separation by server, cancellation, and replacement retries under the cleanup deadline.

The script retains the original F02 checks that every client entry point uses `redirect: 'manual'` and refuses redirect responses, and the F11 check that models without list capabilities are offered after inspecting their details. The unit suite separately tests real loopback redirects. F04 controller/recovery/audio behavior and the quiet app Undo scenario are covered elsewhere in the repository suites.
