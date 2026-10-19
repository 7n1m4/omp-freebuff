// Unrecognized and degraded screen frames dump under <configDir>/screen-dumps/<version>,
// one file per freeze key. Write-only diagnostics: nothing reads dumps back, and a
// failed dump never fails the caller.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freezeKey } from "./screen";

const SCREEN_DUMPS_DIRNAME = "screen-dumps";
const METADATA_FILENAME = "freebuff-metadata.json";

/** The installed freebuff CLI version from the config-dir metadata file; null on any
 *  failure (missing, corrupt, or version not a string). */
export function metadataVersion(configDir: string): string | null {
  try {
    const meta = JSON.parse(readFileSync(join(configDir, METADATA_FILENAME), "utf8")) as {
      version?: unknown;
    };
    return typeof meta.version === "string" ? meta.version : null;
  } catch {
    return null;
  }
}

/** Whether any unrecognized-frame dump is on record for `version`, the drift-alarm
 *  primitive. Dumps live on disk, write-only, so the record outlives a restart and
 *  never flickers on an intermittent screen. */
export function hasUnrecognizedDump(configDir: string, version: string): boolean {
  try {
    return readdirSync(join(configDir, SCREEN_DUMPS_DIRNAME, version)).some((name) =>
      name.startsWith("unrecognized-"),
    );
  } catch {
    return false;
  }
}

/** Dump one screen frame under screen-dumps/<version>/<kind>-<sha256 of freeze key>.ansi
 *  and return its path, or null when the write was skipped or failed. Countdown repaints
 *  dedupe to one file because the freeze key strips the countdown lines; the file keeps
 *  them. */
export function writeScreenDump(
  configDir: string,
  text: string,
  kind: "unrecognized" | "degraded",
): string | null {
  try {
    // The metadata version names the folder, "unknown" when unreadable, the same key
    // later tickets read the drift record under.
    const version = metadataVersion(configDir) ?? "unknown";
    const hash = createHash("sha256").update(freezeKey(text)).digest("hex");
    const dir = join(configDir, SCREEN_DUMPS_DIRNAME, version);
    const path = join(dir, `${kind}-${hash}.ansi`);
    if (existsSync(path)) return path;
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, text);
    return path;
  } catch {
    return null;
  }
}
