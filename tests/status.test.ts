// Ticket #17 slice 3: freebuff_status (ADR-0001). Proves AC #6 (Lock state,
// Instance pid, Target, foreign live holders, with dead/expired/malformed/own
// records filtered) and AC #7 (nothing this owner did not start is ever killed).
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { defaultFreebuffConfigDir, freebuffStatus, readForeignHolders } from "../src/status";
import { writeLock } from "../src/lock";
import { writeTaskArchive } from "../src/archive";
import { ensureJunction } from "../src/workspace";

let pluginDir: string;
let configDir: string;

beforeEach(() => {
  pluginDir = mkdtempSync(join(tmpdir(), "status-plugin-test-"));
  configDir = mkdtempSync(join(tmpdir(), "status-config-test-"));
});

afterEach(() => {
  rmSync(pluginDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;
// Foreign pids that exist on no machine, so injected liveness is unambiguous.
const DEAD_PID = 999_999_999;

const writeHolder = (name: string, record: object): void => {
  writeFileSync(join(configDir, name), JSON.stringify(record));
};

const deps = (alive: number[] = [], extra?: { hasLiveTask?: () => boolean; ownInstancePid?: number }) => {
  const alivePids = new Set([process.pid, ...alive]);
  return {
    now: () => NOW,
    isPidAlive: (pid: number) => alivePids.has(pid),
    ...extra,
  };
};

// Ground truth for the status size total: every byte under dir, per the fs.
const bytesOnDisk = (dir: string): number =>
  readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
    const path = join(dir, entry.name);
    return total + (entry.isDirectory() ? bytesOnDisk(path) : statSync(path).size);
  }, 0);

describe("defaultFreebuffConfigDir", () => {
  test("is the manicode dir under the home directory, path only (AC #6)", () => {
    expect(defaultFreebuffConfigDir()).toMatch(/[\\/]\.config[\\/]manicode$/);
  });
});

describe("readForeignHolders", () => {
  test("lists live holders with pid, model and expiresAt (AC #6)", () => {
    writeHolder(`freebuff-live-${process.pid}.json`, {
      ownerPid: process.pid,
      model: "glm-5.3-flash",
      expiresAt: NOW + 1_000,
    });
    expect(readForeignHolders(configDir, deps())).toEqual({
      live: [{ pid: process.pid, model: "glm-5.3-flash", expiresAt: NOW + 1_000 }],
    });
  });

  test("excludes dead-owner, expired, malformed and own records (AC #6)", () => {
    writeHolder(`freebuff-live-${DEAD_PID}.json`, {
      ownerPid: DEAD_PID,
      model: "m",
      expiresAt: NOW + 1_000,
    });
    writeHolder("freebuff-live-777.json", { ownerPid: 777, model: "m", expiresAt: NOW - 1 });
    writeFileSync(join(configDir, "freebuff-live-888.json"), "{not json");
    writeHolder("freebuff-live-889.json", { model: "m" });
    writeHolder("freebuff-live-890.json", {
      ownerPid: "not-a-number",
      model: "m",
      expiresAt: NOW + 1_000,
    });
    writeHolder(`freebuff-live-${process.pid}.json`, {
      ownerPid: process.pid,
      model: "mine",
      expiresAt: NOW + 1_000,
    });
    expect(readForeignHolders(configDir, deps([], { ownInstancePid: process.pid }))).toEqual({ live: [] });
  });

  test("a missing config dir yields no holders", () => {
    expect(readForeignHolders(join(configDir, "missing"), deps())).toEqual({ live: [] });
  });
});

describe("freebuffStatus", () => {
  test("free Lock and no Workspace: no record fields, no target (AC #6)", () => {
    const status = freebuffStatus({ pluginDir, freebuffConfigDir: configDir, ...deps() });
    expect(status).toEqual({
      lock: { state: "free" },
      foreign: { live: [] },
      archive: { count: 0, totalBytes: 0 },
      abandoned: [],
      screenDrift: false,
    });
  });

  test("reports the junction Target normalized, undefined when absent (AC #6)", () => {
    const workspace = join(pluginDir, "freebuff-ws");
    const repo = join(pluginDir, "repo-dir");
    mkdirSync(repo);
    const status1 = freebuffStatus({ pluginDir, freebuffConfigDir: configDir, ...deps() });
    expect(status1.target).toBeUndefined();
    ensureJunction(workspace, repo);
    const status2 = freebuffStatus({ pluginDir, freebuffConfigDir: configDir, ...deps() });
    expect(status2.target).toBe(repo);
  });

  test("held-by-other carries the record fields; instancePid from the record (AC #6)", () => {
    writeLock(pluginDir, {
      ownerPid: 424242,
      instancePid: 525252,
      kind: "keeper",
      startedAt: new Date(NOW).toISOString(),
    });
    const status = freebuffStatus({
      pluginDir,
      freebuffConfigDir: configDir,
      ...deps([424242]),
    });
    expect(status.lock).toEqual({
      state: "held-by-other",
      ownerPid: 424242,
      instancePid: 525252,
      kind: "keeper",
      startedAt: new Date(NOW).toISOString(),
    });
    expect(status.instancePid).toBe(525252);
  });

  test("self state prefers the in-process known instancePid (AC #6)", () => {
    writeLock(pluginDir, {
      ownerPid: process.pid,
      instancePid: null,
      kind: "extension",
      startedAt: new Date(NOW).toISOString(),
    });
    writeHolder(`freebuff-live-31337.json`, {
      ownerPid: 31337,
      model: "glm-5.3-flash",
      expiresAt: NOW + 120_000,
    });
    const status = freebuffStatus({
      pluginDir,
      freebuffConfigDir: configDir,
      instancePid: 31337,
      ...deps([31337], { hasLiveTask: () => true }),
    });
    expect(status.lock.state).toBe("self");
    expect(status.instancePid).toBe(31337);
    // The known Instance must not report itself as a foreign holder, but its
    // record is the Hour-session source: two minutes left.
    expect(status.foreign.live).toEqual([]);
    expect(status.hourMinutesLeft).toBe(2);
  });

  test("an expired own live record leaves the Hour-session remainder undefined", () => {
    writeHolder(`freebuff-live-31337.json`, {
      ownerPid: 31337,
      model: "glm-5.3-flash",
      expiresAt: NOW - 1,
    });
    const status = freebuffStatus({
      pluginDir,
      freebuffConfigDir: configDir,
      instancePid: 31337,
      ...deps([31337]),
    });
    expect(status.hourMinutesLeft).toBeUndefined();
  });

  test("the drift alarm rises for an unrecognized dump the corpus does not cover", () => {
    const corpusDir = mkdtempSync(join(tmpdir(), "status-corpus-test-"));
    writeFileSync(join(configDir, "freebuff-metadata.json"), JSON.stringify({ version: "9.9.9" }));
    mkdirSync(join(configDir, "screen-dumps", "9.9.9"), { recursive: true });
    writeFileSync(join(configDir, "screen-dumps", "9.9.9", "unrecognized-abc.ansi"), "frame");

    // The corpus already covers 9.9.9: the promotion is the fix, no drift.
    mkdirSync(join(corpusDir, "9.9.9"), { recursive: true });
    expect(
      freebuffStatus({ pluginDir, freebuffConfigDir: configDir, corpusDir, ...deps() }).screenDrift,
    ).toBe(false);

    // An uncovered version: the dump is unpromoted drift.
    expect(freebuffStatus({ pluginDir, freebuffConfigDir: configDir, ...deps() }).screenDrift).toBe(true);
  });

  test("foreign live holders are listed alongside the Lock state (AC #6)", () => {
    writeHolder(`freebuff-live-${process.pid}.json`, {
      ownerPid: process.pid,
      model: "glm-5.3-flash",
      expiresAt: NOW + 60_000,
    });
    const status = freebuffStatus({ pluginDir, freebuffConfigDir: configDir, ...deps() });
    expect(status.foreign).toEqual({
      live: [{ pid: process.pid, model: "glm-5.3-flash", expiresAt: NOW + 60_000 }],
    });
  });

  test("reports Task archive count, totalBytes and newestId", () => {
    const write = (now: number, answer: string) =>
      writeTaskArchive({
        pluginDir,
        now,
        prompt: "p",
        target: null,
        model: "m",
        instancePid: null,
        verdict: null,
        phaseLog: [],
        startedAt: now - 1000,
        answer,
        chatMessages: "{}",
        screen: "screen",
        stderr: "",
      });
    const older = write(NOW, "first answer");
    const newer = write(NOW + 1000, "second answer, deliberately longer");

    const status = freebuffStatus({ pluginDir, freebuffConfigDir: configDir, ...deps() });

    // On-disk bytes are the source of truth for the size total.
    expect(status.archive).toEqual({
      count: 2,
      totalBytes: bytesOnDisk(pluginDir),
      newestId: newer.taskId,
    });
    expect(newer.taskId > older.taskId).toBe(true);
  });

  test("carries the abandoned report for meta-only archives (#23)", () => {
    const tomb = "2023-11-14T22:13:20.500Z";
    const { taskId } = writeTaskArchive({
      pluginDir,
      now: NOW,
      prompt: "abandoned prompt",
      target: "C:\\work\\demo-app",
      model: "m",
      instancePid: 4242,
      verdict: null,
      phaseLog: ["submitting@2023-11-14T22:13:15.100Z", "working@2023-11-14T22:13:16.000Z", `abandoned@${tomb}`],
      startedAt: NOW - 6000,
    });

    const status = freebuffStatus({ pluginDir, freebuffConfigDir: configDir, ...deps() });

    expect(status.abandoned).toEqual([
      { taskId, prompt: "abandoned prompt", target: "C:\\work\\demo-app", phase: "working", diedAt: tomb },
    ]);
  });

  test("kills nothing: held-by-other plus foreign live holders, zero killPid calls (AC #7)", () => {
    writeLock(pluginDir, {
      ownerPid: 424242,
      instancePid: 525252,
      kind: "extension",
      startedAt: new Date(NOW).toISOString(),
    });
    writeHolder(`freebuff-live-${process.pid}.json`, {
      ownerPid: process.pid,
      model: "m",
      expiresAt: NOW + 60_000,
    });
    const killPid = mock(async (_pid: number) => {});
    const status = freebuffStatus({
      pluginDir,
      freebuffConfigDir: configDir,
      killPid,
      ...deps([424242, 525252]),
    });
    expect(status.lock.state).toBe("held-by-other");
    expect(status.foreign.live).toHaveLength(1);
    expect(killPid).not.toHaveBeenCalled();
  });
});
