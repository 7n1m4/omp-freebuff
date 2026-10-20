// Slice 1 support surface: the recorded freebuff version the screen wordings were
// measured against, and the dump-to-corpus promotion mechanics (copy the dump into
// its version folder so corpusVersions() picks it up). The RECORDED row + pass
// classification side of promotion is enforced by tests/corpus.test.ts, which is
// why a promotion always also touches src/protocol/recorded.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { corpusVersions } from "../src/protocol/corpus";
import { MEASURED_FREEBUFF_VERSION, measuredVersionReport } from "../src/protocol/recorded";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop() as string;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows file locks can hold the tmp dir briefly; the OS cleans tmp.
    }
  }
});

test("matching version reports ok", () => {
  const report = measuredVersionReport(MEASURED_FREEBUFF_VERSION);
  expect(report.ok).toBe(true);
});

test("mismatched version reports both versions and the capture re-measure path", () => {
  const report = measuredVersionReport("9.9.9");
  expect(report.ok).toBe(false);
  expect(report.message).toContain("9.9.9");
  expect(report.message).toContain(MEASURED_FREEBUFF_VERSION);
  expect(report.message).toContain("PI_FREEBUFF_CAPTURE=1 bun test tests/liveCapture.test.ts");
});

test("unreadable version metadata refuses to guess", () => {
  const report = measuredVersionReport(null);
  expect(report.ok).toBe(false);
  expect(report.message).toContain("refusing to guess");
});

test("the measured version has corpus coverage", () => {
  expect(corpusVersions()).toContain(MEASURED_FREEBUFF_VERSION);
});

test("promotion dry-proof: a version-named folder with a dump registers as corpus coverage", () => {
  // The mechanical step of promoting a Screen dump: create the version folder in
  // the corpus and drop the (SHA-named) dump file in; corpusVersions() then
  // covers that version and no drift signal rises for it.
  const tmp = mkdtempSync(join(tmpdir(), "live-support-corpus-"));
  tmpDirs.push(tmp);
  const versionDir = join(tmp, MEASURED_FREEBUFF_VERSION);
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(join(versionDir, "f".repeat(64) + ".ansi"), "placeholder frame\n");
  expect(corpusVersions(tmp)).toContain(MEASURED_FREEBUFF_VERSION);
});
