// Ticket #17 slice 2: the turn-scoped Lock protocol (ADR-0001, ADR-0004).
// Proves AC #2 (record spans the child, gone on every exit path), AC #3 (wait,
// then busy naming the holder; never take over a running Turn) and AC #4 (dead
// owner, old record, own pid without a live Task are all reclaimed).
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  LockBusyError,
  STALE_LOCK_MS,
  claimLock,
  classifyLock,
  pidAlive,
  readLock,
  reclaimLock,
  releaseLock,
  setLockInstancePid,
  withLock,
  writeLock,
  type LockDeps,
  type LockRecord,
} from "../src/lock";

let pluginDir: string;

beforeEach(() => {
  pluginDir = mkdtempSync(join(tmpdir(), "lock-test-"));
});

afterEach(() => {
  rmSync(pluginDir, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;
const startedAt = (at: number = NOW): string => new Date(at).toISOString();
// Pids that do not exist on this machine and never will be ours.
const FOREIGN_OWNER = 111_111_111;
const FOREIGN_INSTANCE = 222_222_222;

const seed = (record: Partial<LockRecord>): LockRecord => {
  const full: LockRecord = {
    ownerPid: FOREIGN_OWNER,
    instancePid: FOREIGN_INSTANCE,
    kind: "extension",
    startedAt: startedAt(),
    ...record,
  };
  writeLock(pluginDir, full);
  return full;
};

// Injected liveness: only the given pids are alive, never a reclaim target. The
// clock advances only through sleep, so deadline math progresses per poll.
const deps = (alivePids: number[], extra?: Partial<LockDeps>): LockDeps => {
  let now = NOW;
  return {
    now: () => now,
    isPidAlive: (pid: number) => alivePids.includes(pid),
    hasLiveTask: () => false,
    sleep: async (ms: number) => {
      now += ms;
    },
    ...extra,
  };
};

describe("STALE_LOCK_MS", () => {
  test("is the 30-minute staleness threshold (AC #4)", () => {
    expect(STALE_LOCK_MS).toBe(30 * 60 * 1000);
  });
});

describe("readLock / writeLock / releaseLock / setLockInstancePid", () => {
  test("absent lock.json reads as null", () => {
    expect(readLock(pluginDir)).toBeNull();
  });

  test("writeLock then readLock round-trips the record", () => {
    const record = seed({});
    expect(readLock(pluginDir)).toEqual(record);
  });

  test("exclusive write creates once and surfaces EEXIST on a second take", () => {
    const record: LockRecord = {
      ownerPid: process.pid,
      instancePid: null,
      kind: "extension",
      startedAt: startedAt(),
    };
    writeLock(pluginDir, record, { exclusive: true });
    expect(() => writeLock(pluginDir, record, { exclusive: true })).toThrow();
    expect(readLock(pluginDir)).toEqual(record);
  });

  test("releaseLock deletes and tolerates absence", () => {
    seed({});
    releaseLock(pluginDir);
    expect(readLock(pluginDir)).toBeNull();
    expect(() => releaseLock(pluginDir)).not.toThrow();
  });

  test("setLockInstancePid fills instancePid on the existing record", () => {
    seed({ instancePid: null });
    setLockInstancePid(pluginDir, 4242);
    expect(readLock(pluginDir)?.instancePid).toBe(4242);
  });

  test("setLockInstancePid is a no-op without a record", () => {
    expect(() => setLockInstancePid(pluginDir, 4242)).not.toThrow();
    expect(readLock(pluginDir)).toBeNull();
  });
});

describe("classifyLock", () => {
  test("absent record is free", () => {
    expect(classifyLock(null, deps([]))).toBe("free");
  });

  test("live foreign owner is held-by-other", () => {
    const record = seed({});
    expect(classifyLock(record, deps([FOREIGN_OWNER]))).toBe("held-by-other");
  });

  test("our own pid with a live Task is self", () => {
    const record = seed({ ownerPid: process.pid });
    expect(classifyLock(record, deps([process.pid], { hasLiveTask: () => true }))).toBe("self");
  });

  test("our own pid with no live Task is stale (AC #4)", () => {
    const record = seed({ ownerPid: process.pid });
    expect(classifyLock(record, deps([process.pid]))).toBe("stale");
  });

  test("dead ownerPid is stale (AC #4)", () => {
    const record = seed({});
    expect(classifyLock(record, deps([]))).toBe("stale");
  });

  test("record older than STALE_LOCK_MS is stale, at exactly the threshold is not (AC #4)", () => {
    const old = seed({ startedAt: startedAt(NOW - STALE_LOCK_MS - 1) });
    const edge = seed({ startedAt: startedAt(NOW - STALE_LOCK_MS) });
    expect(classifyLock(old, deps([FOREIGN_OWNER]))).toBe("stale");
    expect(classifyLock(edge, deps([FOREIGN_OWNER]))).toBe("held-by-other");
  });
});

describe("claimLock", () => {
  test("takes a free slot with instancePid null before any spawn (AC #2)", async () => {
    const result = await claimLock(pluginDir, "extension", deps([]) as LockDeps & { deadlineMs: number });
    if (!result.claimed) throw new Error(`expected claim, got ${JSON.stringify(result)}`);
    expect(readLock(pluginDir)).toEqual({
      ownerPid: process.pid,
      instancePid: null,
      kind: "extension",
      startedAt: startedAt(NOW),
    });
    result.release();
    expect(readLock(pluginDir)).toBeNull();
  });

  test("reclaims a record whose owner pid is dead (AC #4)", async () => {
    const killPid = mock(async (_pid: number) => {});
    seed({ instancePid: null }); // dead owner (no alive pids), nothing to kill
    const result = await claimLock(pluginDir, "extension", {
      ...deps([]),
      killPid,
      deadlineMs: 5_000,
    });
    expect(result.claimed).toBe(true);
    expect(killPid).not.toHaveBeenCalled();
    expect(readLock(pluginDir)?.ownerPid).toBe(process.pid);
  });

  test("reclaims a record grown older than STALE_LOCK_MS, killing the recorded instance (AC #4)", async () => {
    const killPid = mock(async (_pid: number) => {});
    seed({ startedAt: startedAt(NOW - STALE_LOCK_MS - 1) });
    const result = await claimLock(pluginDir, "extension", {
      ...deps([FOREIGN_OWNER, FOREIGN_INSTANCE]),
      killPid,
      deadlineMs: 5_000,
    });
    expect(result.claimed).toBe(true);
    expect(killPid).toHaveBeenCalledTimes(1);
    expect(killPid.mock.calls[0][0]).toBe(FOREIGN_INSTANCE);
    expect(readLock(pluginDir)?.ownerPid).toBe(process.pid);
  });

  test("reclaims a record naming our own pid with no live Task behind it (AC #4)", async () => {
    const killPid = mock(async (_pid: number) => {});
    // Stale by identity: our pid, the Extension reloaded in place, no Task.
    seed({ ownerPid: process.pid, instancePid: null });
    const result = await claimLock(pluginDir, "extension", {
      ...deps([process.pid]),
      killPid,
      deadlineMs: 5_000,
    });
    expect(result.claimed).toBe(true);
    expect(killPid).not.toHaveBeenCalled();
    expect(readLock(pluginDir)?.ownerPid).toBe(process.pid);
  });

  test("waits out a live foreign holder, then reports busy naming the holder (AC #3)", async () => {
    const record = seed({});
    const killPid = mock(async (_pid: number) => {});
    const result = await claimLock(pluginDir, "extension", {
      ...deps([FOREIGN_OWNER]),
      killPid,
      deadlineMs: 1_000,
      pollMs: 100,
    });
    expect(result).toEqual({ claimed: false, busy: true, holder: record });
    expect(killPid).not.toHaveBeenCalled();
    expect(readLock(pluginDir)).toEqual(record);
  });

  test("never takes over our own running Turn (AC #4 contrast)", async () => {
    const record = seed({ ownerPid: process.pid, instancePid: null });
    const result = await claimLock(pluginDir, "extension", {
      ...deps([process.pid], { hasLiveTask: () => true }),
      deadlineMs: 1_000,
      pollMs: 100,
    });
    expect(result.claimed).toBe(false);
    if (!result.claimed) expect(result.holder).toEqual(record);
  });
});

// A torn write leaves a file readLock rejects (numeric startedAt, truncated
// JSON): it names no live owner, so it is a Stale Lock — reclaimable whatever
// it claims (#14) — and a claim must take the Lock, never spin on EEXIST.
describe("malformed lock.json on disk (torn write)", () => {
  const seedRaw = (content: string): void => {
    writeFileSync(join(pluginDir, "lock.json"), content);
  };

  test("claimLock reclaims a numeric startedAt and leaves a well-formed record", async () => {
    seedRaw(
      JSON.stringify({ ownerPid: FOREIGN_OWNER, instancePid: FOREIGN_INSTANCE, kind: "extension", startedAt: NOW }),
    );
    const killPid = mock(async (_pid: number) => {});
    const result = await claimLock(pluginDir, "extension", {
      ...deps([]),
      killPid,
      deadlineMs: 5_000,
      pollMs: 100,
    });
    if (!result.claimed) throw new Error(`expected claim, got ${JSON.stringify(result)}`);
    // One poll passes between the reclaim and the take, so the record carries
    // the clock after that sleep.
    expect(readLock(pluginDir)).toEqual({
      ownerPid: process.pid,
      instancePid: null,
      kind: "extension",
      startedAt: startedAt(NOW + 100),
    });
    expect(killPid).not.toHaveBeenCalled();
  });

  test("claimLock reclaims truncated garbage JSON", async () => {
    seedRaw('{"ownerPid": 111111111, "kind": "ext');
    const result = await claimLock(pluginDir, "extension", { ...deps([]), deadlineMs: 5_000 });
    if (!result.claimed) throw new Error(`expected claim, got ${JSON.stringify(result)}`);
    expect(readLock(pluginDir)?.ownerPid).toBe(process.pid);
  });

  test("reclaimLock deletes a malformed record", async () => {
    seedRaw(JSON.stringify({ ownerPid: FOREIGN_OWNER, instancePid: null, kind: "keeper", startedAt: NOW }));
    await reclaimLock(pluginDir, deps([]));
    expect(readLock(pluginDir)).toBeNull();
    expect(existsSync(join(pluginDir, "lock.json"))).toBe(false);
  });

  test("a missing file is still free and valid records classify unchanged", () => {
    expect(readLock(pluginDir)).toBeNull();
    expect(classifyLock(null, deps([]))).toBe("free");
    const live = seed({});
    expect(classifyLock(live, deps([FOREIGN_OWNER]))).toBe("held-by-other");
  });
});

describe("withLock", () => {
  test("record exists inside the callback before any child, gone after return (AC #2)", async () => {
    const inside = await withLock(
      pluginDir,
      "extension",
      deps([]) as LockDeps & { deadlineMs?: number },
      async (lock) => {
        const record = readLock(pluginDir);
        lock.setInstancePid(4242);
        expect(readLock(pluginDir)?.instancePid).toBe(4242);
        return record;
      },
    );
    expect(inside).toEqual({
      ownerPid: process.pid,
      instancePid: null,
      kind: "extension",
      startedAt: startedAt(NOW),
    });
    expect(readLock(pluginDir)).toBeNull();
  });

  test("releases when the callback throws (AC #2)", async () => {
    await expect(
      withLock(pluginDir, "extension", deps([]) as LockDeps & { deadlineMs?: number }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(readLock(pluginDir)).toBeNull();
  });

  test("busy holder surfaces as LockBusyError without touching the record (AC #2, AC #3)", async () => {
    const record = seed({});
    let ran = false;
    try {
      await withLock(pluginDir, "extension", { ...deps([FOREIGN_OWNER]), deadlineMs: 1_000 }, async () => {
        ran = true;
      });
    } catch (error) {
      expect(error).toBeInstanceOf(LockBusyError);
      const busy = error as LockBusyError;
      expect(busy.busy).toBe(true);
      expect(busy.holder).toEqual(record);
    }
    expect(ran).toBe(false);
    expect(readLock(pluginDir)).toEqual(record);
  });
});

describe("pidAlive", () => {
  test("our own pid is alive, a pid far out of range is not", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(999_999_999)).toBe(false);
  });
});
