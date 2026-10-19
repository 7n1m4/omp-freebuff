// Shared fixture replay for the screen suites: corpus, recognition and freeze-key
// tests all observe the same path a real frame takes, PTY bytes through the host
// vterm to flattened text.
import { readFileSync } from "node:fs";
import { flattenScreen } from "../../src/protocol/screen";

// Fixtures store the flattened screen with \n; the real PTY (ConPTY) emits \r\n, and
// LF alone keeps the column in the emulator, wrapping long rows. Replay as the PTY
// would. `key` is `<folder>/<file>` under tests/fixtures/screen, no extension.
export const replayFixture = async (key: string): Promise<string> =>
  flattenScreen([
    readFileSync(new URL(`../fixtures/screen/${key}.ansi`, import.meta.url), "utf8").replace(/\n/g, "\r\n"),
  ]);
