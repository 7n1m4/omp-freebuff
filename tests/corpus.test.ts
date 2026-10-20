// The per-version screen fixture corpus, replayed through the emulator and the one
// screen read (classifyScreen). Every fixture in a version folder is a real capture
// of a known screen and classifies at level pass; `negative/` holds frames no
// signature may ever recognize; `synthetic/` holds hand-made emulator vectors. The
// RECORDED table (src/protocol/recorded.ts) is the recorded classification each file
// must reproduce exactly (tests/fixtures/screen/AGENTS.md).
import { readdirSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { corpusVersions } from "../src/protocol/corpus";
import { RECORDED } from "../src/protocol/recorded";
import { classifyScreen } from "../src/protocol/screen";
import { replayFixture } from "./helpers/replay";

const corpusDir = new URL("./fixtures/screen/", import.meta.url);
const FOLDERS = [...corpusVersions(), "negative", "synthetic"].sort();

const onDisk = (folder: string): string[] =>
  readdirSync(new URL(`${folder}/`, corpusDir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ansi"))
    .map((entry) => entry.name.replace(/\.ansi$/, ""))
    .sort();

describe("screen fixture corpus", () => {
  test("holds exactly the version folders on disk", () => {
    expect([...corpusVersions()].sort()).toEqual(
      readdirSync(corpusDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^\d/.test(e.name))
        .map((e) => e.name)
        .sort(),
    );
  });

  test("accounts for every fixture file: no unlisted, no phantom rows", () => {
    expect(Object.keys(RECORDED).sort()).toEqual(
      FOLDERS.flatMap((folder) => onDisk(folder).map((name) => `${folder}/${name}`)).sort(),
    );
  });

  describe.each(FOLDERS)("%s", (folder) => {
    test.each(onDisk(folder))("%s.ansi classifies exactly as recorded", async (name) => {
      const key = `${folder}/${name}`;
      const expected = RECORDED[key];
      expect(expected, `no recorded row for ${key}.ansi`).toBeDefined();
      const read = classifyScreen(await replayFixture(key));
      expect(`${read.identity}/${read.level}`, `${key}.ansi`).toBe(`${expected.screen}/${expected.level}`);
    });
  });

  test("every version-folder fixture recognizes at pass", () => {
    for (const [key, row] of Object.entries(RECORDED)) {
      if (!/^\d/.test(key)) continue;
      expect(`${key}: ${row.level}`).toBe(`${key}: pass`);
    }
  });

  test("every negative fixture matches no known screen", () => {
    for (const [key, row] of Object.entries(RECORDED)) {
      if (!key.startsWith("negative/")) continue;
      expect(`${key}: ${row.screen}/${row.level}`).toBe(`${key}: null/fail`);
    }
  });
});
