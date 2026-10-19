// Ticket #17 slice 3: freebuff_status (ADR-0001 §5). Proves AC #6 (Lock state,
// Instance pid, Target, foreign live holders, with dead/expired/malformed/own
// records filtered) and AC #7 (nothing this owner did not start is ever killed).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { defaultFreebuffConfigDir, freebuffStatus, readForeignHolders } from "../src/status";
import { writeLock } from "../src/lock";
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
    expect(status).toEqual({ lock: { state: "free" }, foreign: { live: [] } });
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
    const status = freebuffStatus({
      pluginDir,
      freebuffConfigDir: configDir,
      instancePid: 31337,
      ...deps([], { hasLiveTask: () => true }),
    });
    expect(status.lock.state).toBe("self");
    expect(status.instancePid).toBe(31337);
    // The known Instance must not report itself as a foreign holder.
    expect(status.foreign.live).toEqual([]);
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
