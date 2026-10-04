# Storage audit evidence

These two scripts reproduce three defects found on 2026-10-04. They import the production storage modules without changing them. Run from the repository root after installing its dependencies:

```sh
node --import tsx docs/qa-audit-evidence/storage-repro.ts
node --import tsx docs/qa-audit-evidence/download-error-repro.ts
```

Both scripts use fresh temporary directories and synthetic bytes, then remove their temporary files. They do not launch Electron, access real settings or speech models, record audio, read transcripts, touch the clipboard, take focus, or make network requests. Their injected `fetchImpl` supplies all responses in memory; the `.invalid` URLs are placeholders.

`storage-repro.ts` should currently print:

```json
{"check":"failed settings write","failure":"EISDIR","memory":"cleaned","persisted":"verbatim"}
{"check":"same-sized model corruption","ready":true,"repairFetchCalls":0,"actualChecksumMatches":false}
```

The first line confirms that a failed save changes runtime settings while persisted settings retain the previous value. The second confirms that equal-length corruption remains marked ready and is skipped by a download retry despite a different actual checksum.

`download-error-repro.ts` should currently print:

```json
{"check":"write error while network stalled","after200ms":{"done":false}}
{"afterNetworkResumes":{"done":true,"error":"EISDIR"}}
```

This confirms that the filesystem error is not surfaced while the response stream is stalled after a small chunk. Closing the synthetic stream allows the existing error to surface. The 200 ms observation is a bounded diagnostic interval, not a product timeout requirement.

These are observational repro scripts, not regression tests: exit code zero means the diagnostic completed, and the output above confirms the defects. Corrected implementations should produce different results. Each failure is simulated with a directory at the intended temporary-file path; no disk is filled and no permissions are changed.
