// Ticket #26 slice 3: the headless entry as a real child process. Exits 0,
// tees keeper.log into the repo root, drives exactly one stub Instance and
// kills it. The real freebuff CLI is never spawned.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeTaskArchive } from "../src/archive";
import { eventsOf, readInputLog } from "./helpers/stubInputLog";

const repoRoot = join(import.meta.dir, "..");
const stubPath = join(import.meta.dir, "helpers", "stub-freebuff.mjs");
const keeperLog = join(repoRoot, "keeper.log");
const TIMINGS = { settleMs: 4_000, ackMs: 1_500, pollMs: 25, pasteSettleMs: 60, pressThrottleMs: 120 };

let pluginDir = "";
let configDir = "";
let target = "";

beforeEach(() => {
  pluginDir = mkdtempSync(join(tmpdir(), "keeper-entry-plugin-"));
  configDir = mkdtempSync(join(tmpdir(), "keeper-entry-config-"));
  target = mkdtempSync(join(tmpdir(), "keeper-entry-target-"));
  rmSync(keeperLog, { force: true });
});

afterEach(() => {
  rmSync(keeperLog, { force: true });
  for (const dir of [pluginDir, configDir, target]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows cwd lock after the PTY kill; the OS cleans tmp.
    }
  }
});

const runEntry = async (options: Record<string, unknown>): Promise<{ exitCode: number; stdout: string }> => {
  const proc = Bun.spawn([process.execPath, "scripts/keeper.ts"], {
    cwd: repoRoot,
    env: { ...process.env, PI_FREEBUFF_KEEPER_JSON: JSON.stringify(options) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  return { exitCode, stdout };
};

// Process death is kernel-side, so no fake clock can drive it: poll the real
// OS until the pid stops responding, like tests/lock-reclaim-real-process.test.ts.
const isDead = async (pid: number): Promise<boolean> => {
  for (let waited = 0; waited < 5_000; waited += 50) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 50);
    await promise;
  }
  return false;
};

test(
  "entry spawns one keeper task, exits 0, writes keeper.log, kills the stub",
  async () => {
    const inputLog = join(pluginDir, "stub-input.jsonl");
    const { exitCode, stdout } = await runEntry({
      pluginDir,
      freebuffConfigDir: configDir,
      workspace: join(pluginDir, "ws"),
      target,
      command: { application: process.execPath, args: [stubPath] },
      env: { FREEBUFF_STUB_MODE: "happy", FREEBUFF_STUB_INPUT_LOG: inputLog },
      timings: TIMINGS,
    });

    expect(exitCode).toBe(0);
    const logText = readFileSync(keeperLog, "utf8");
    expect(logText).toContain("running one read-only task");
    expect(logText).toContain("spawned");
    expect(stdout).toContain("spawned");
    const spawns = eventsOf(readInputLog(inputLog), "spawn");
    expect(spawns).toHaveLength(1);
    expect(await isDead(spawns[0].pid!)).toBe(true);
  },
  { timeout: 120_000 },
);

test("entry with archive activity exits 0 and spawns nothing", async () => {
  const now = Date.now();
  writeTaskArchive({
    pluginDir,
    now,
    prompt: "seed activity",
    target: null,
    model: null,
    instancePid: null,
    verdict: "no_answer",
    phaseLog: [`done@${new Date(now).toISOString()}`],
    startedAt: now - 1_000,
    answer: "",
  });
  const inputLog = join(pluginDir, "stub-input.jsonl");
  const { exitCode } = await runEntry({
    pluginDir,
    freebuffConfigDir: configDir,
    workspace: join(pluginDir, "ws"),
    target,
    command: { application: "freebuff-never-spawned" },
    env: { FREEBUFF_STUB_INPUT_LOG: inputLog },
  });

  expect(exitCode).toBe(0);
  expect(readFileSync(keeperLog, "utf8")).toContain("recent-activity");
  expect(existsSync(inputLog)).toBe(false);
});
