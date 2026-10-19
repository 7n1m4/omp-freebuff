# Screen fixture corpus

Real freebuff screens, flattened, and the acceptance bar for every screen
signature. `tests/corpus.test.ts` replays each file through the host vterm
(`flattenScreen`, backed by `src/host/pty.ts`) and checks it against the
`RECORDED` table keyed by `<version>/<file>`. The files themselves are the
record of each screen's wording.

## Layout

- `<version>/`: one folder per freebuff CLI version. Folders accumulate; a
  capture never replaces another version's files. A folder simply lacks the
  screens never captured on that version. `corpusVersions()` reads these
  folder names, so a version with a folder never raises a drift signal.
- `negative/`: frames no signature may ever recognize — hand-made loosened-
  signature bait and any real capture demoted as genuinely transitional. The
  corpus test fails if one starts matching. Every entry must classify
  `null`/`fail`.
- `synthetic/`: hand-made emulator vectors (split writes, repaints, partial
  lines) and hand-made wording-bait frames that must still recognize as a real
  screen. Not protocol captures.

A file's name names the screen it shows (`ready`, `welcome`, `queued-composer`,
...), except the SHA-named files imported verbatim from the live
`screen-dumps/<version>/` directories — the SHA is their traceability to the
dump dir, so it stays; the table row is where their screen is recorded.

Format: the flattened visible screen, trailing row padding trimmed, behind a
`\x1b[2J\x1b[H` clear+home prefix, so `flattenScreen([fixture])` reproduces it.
Tests replay with `\r\n` line endings, as the PTY emits them.

## Promote a Screen dump

When `screenDrift` is set, a dump under `<configDir>/screen-dumps/<version>/`
holds the drifted screen.

1. Copy the dump into `<version>/` here, keeping the SHA file name. Create the
   folder if the corpus lacks that version.
2. Read the frame and add its `<version>/<file>` row to `RECORDED` in
   `tests/corpus.test.ts`, naming the screen it shows.
3. If a marker no longer matches, adjust `src/protocol/markers.ts` /
   `signatures.ts` until the corpus test passes on every version folder and
   every `negative/` frame stays unrecognized.

Only a genuinely transitional frame (a repaint mid-write that names no screen)
may be demoted: move it to `negative/` and record the one-line reason under
Demotions below. Prefer making the signatures reach `pass`.

## Drop record

- `0.0.193/`, `0.0.198/`, `0.0.199/` from the prototype corpus are dropped:
  pre-0.1.0 dead wordings are out of the port's scope, and the port drops the
  retired strings (single-instance wording, holding banner, `working · Ns`
  ticker, model picker) from the marker table.
- The prototype's retired-wording synthetics (`holding-banner`,
  `dialog-over-picker`, `banner-ready`, ...) are dropped for the same reason;
  the remaining `synthetic/` vectors cover the emulator seam only.
- `continue-wording-answer` moved from `negative/` to `synthetic/`: it is a
  bait proving a transcript quote of the Continue wording stays `ready`, so it
  must recognize — the opposite of a negative. The negative folder means
  "must never match".

## Demotions

None. Every imported dump names a screen: the post-turn idle frames with an ad
box above the composer and no usage row are `displaced` ("placeholder input
box present while the usage row is absent"), which is why the displaced and
draft signatures read a plain bottom band instead of a composer-anchored
region — a diff-painted dump garbles the composer's own border rows, and the
draft footer renders below the composer.
