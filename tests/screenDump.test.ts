// Ticket #16 slice 3: the screen dump module. Unrecognized and degraded frames dump
// under <configDir>/screen-dumps/<version>, deduplicated by freeze key, per freebuff
// version; only unrecognized dumps arm the drift alarm.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { freezeKey } from "../src/protocol/screen";
import { hasUnrecognizedDump, metadataVersion, writeScreenDump } from "../src/protocol/screenDump";

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "screen-dump-test-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

const writeMetadata = (version: string): void => {
  writeFileSync(join(configDir, "freebuff-metadata.json"), JSON.stringify({ version }));
};

const expectedName = (kind: string, text: string): string =>
  `${kind}-${createHash("sha256").update(freezeKey(text)).digest("hex")}.ansi`;

describe("metadataVersion", () => {
  test("valid metadata file yields its version string", () => {
    writeMetadata("9.9.9");
    expect(metadataVersion(configDir)).toBe("9.9.9");
  });

  test("missing metadata file yields null", () => {
    expect(metadataVersion(configDir)).toBeNull();
  });

  test("corrupt metadata file yields null", () => {
    writeFileSync(join(configDir, "freebuff-metadata.json"), "{not json");
    expect(metadataVersion(configDir)).toBeNull();
  });
});

describe("writeScreenDump", () => {
  test("unrecognized frame writes the dump and returns its path", () => {
    writeMetadata("1.2.3");
    const text = "unrecognized frame\n7h 12m left\n";
    const path = writeScreenDump(configDir, text, "unrecognized");
    expect(path).toBe(join(configDir, "screen-dumps", "1.2.3", expectedName("unrecognized", text)));
    expect(existsSync(path!)).toBe(true);
    expect(readFileSync(path!, "utf8")).toBe(text);
  });

  test("same freeze key with ticking countdown dedupes to one file", () => {
    writeMetadata("1.2.3");
    const first = writeScreenDump(configDir, "frame\n7h 12m left\n", "unrecognized");
    const second = writeScreenDump(configDir, "frame\n7h 13m left\n", "unrecognized");
    expect(second).toBe(first);
    const files = readdirSync(join(configDir, "screen-dumps", "1.2.3"));
    expect(files).toEqual([expectedName("unrecognized", "frame\n7h 12m left\n")]);
  });

  test("different freeze key writes a second file", () => {
    writeMetadata("1.2.3");
    writeScreenDump(configDir, "frame one\n", "unrecognized");
    writeScreenDump(configDir, "frame two\n", "unrecognized");
    const files = readdirSync(join(configDir, "screen-dumps", "1.2.3"));
    expect(files.length).toBe(2);
  });

  test("degraded frame writes its own file but does not arm the drift alarm", () => {
    writeMetadata("1.2.3");
    const text = "degraded frame\n";
    const path = writeScreenDump(configDir, text, "degraded");
    expect(path).toBe(join(configDir, "screen-dumps", "1.2.3", expectedName("degraded", text)));
    expect(existsSync(path!)).toBe(true);
    expect(hasUnrecognizedDump(configDir, "1.2.3")).toBe(false);
    writeScreenDump(configDir, text, "unrecognized");
    expect(hasUnrecognizedDump(configDir, "1.2.3")).toBe(true);
  });

  test("unreadable metadata sends dumps to unknown/", () => {
    const path = writeScreenDump(configDir, "no metadata\n", "unrecognized");
    expect(path).toBe(join(configDir, "screen-dumps", "unknown", expectedName("unrecognized", "no metadata\n")));
    expect(existsSync(path!)).toBe(true);
  });

  test("unwritable configDir returns null without throwing", () => {
    const filePath = join(configDir, "not-a-dir");
    writeFileSync(filePath, "occupied");
    expect(writeScreenDump(filePath, "doomed\n", "unrecognized")).toBeNull();
  });
});

describe("hasUnrecognizedDump", () => {
  test("unknown version has no dump", () => {
    expect(hasUnrecognizedDump(configDir, "1.2.3")).toBe(false);
  });

  test("nonexistent configDir has no dump", () => {
    expect(hasUnrecognizedDump(join(configDir, "void"), "1.2.3")).toBe(false);
  });
});
