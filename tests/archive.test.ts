// Ticket #19 slice 1: the Task archive module. One archive per settle at
// <pluginDir>/tasks/<taskId>/, success included; a write never touches an
// existing archive (ADR-0003).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { archiveSummary, nextTaskId, writeTaskArchive, type TaskArchiveInput } from "../src/archive";

// 2023-11-14T22:13:20.000Z, fixed so stamps are deterministic.
const NOW = 1_700_000_000_000;

let pluginDir: string;

beforeEach(() => {
  pluginDir = mkdtempSync(join(tmpdir(), "archive-test-"));
});

afterEach(() => {
  rmSync(pluginDir, { recursive: true, force: true });
});

const baseInput = (overrides: Partial<Omit<TaskArchiveInput, "pluginDir">> = {}): TaskArchiveInput => ({
  pluginDir,
  now: NOW,
  prompt: "list three colors",
  target: "C:\\work\\demo-app",
  model: "zcode0/glm-5.3-flash",
  instancePid: 4242,
  verdict: "no_answer",
  phaseLog: [
    "submitting@2023-11-14T22:13:15.100Z",
    "working@2023-11-14T22:13:16.000Z",
    "settling@2023-11-14T22:13:19.500Z",
  ],
  startedAt: NOW - 5000,
  answer: "# Answer\n\nred, green, grün ✅\n",
  chatMessages: '{"messages":[{"role":"user","text":"list three colors"}]}',
  screen: "frame\r\nred, green, blue\r\n",
  stderr: "boom\n",
  ...overrides,
});

// Independent size computation: the sum check must not reuse the module's walk.
const sizeOnDisk = (dir: string): number =>
  readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
    const path = join(dir, entry.name);
    return total + (entry.isDirectory() ? sizeOnDisk(path) : statSync(path).size);
  }, 0);

describe("nextTaskId", () => {
  test("stamps the UTC time with a four-hex suffix", () => {
    const id = nextTaskId(NOW);
    expect(id).toMatch(/^\d{8}T\d{9}-[0-9a-f]{4}$/);
    expect(id.startsWith("20231114T221320000-")).toBe(true);
  });

  test("sorts lexicographically in generation order without collisions", () => {
    const ids = Array.from({ length: 200 }, (_, i) => nextTaskId(NOW + i));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("writeTaskArchive", () => {
  test("writes the full archive set with pinned meta fields", () => {
    const { taskId, archivePath } = writeTaskArchive(baseInput());
    expect(archivePath).toBe(join(pluginDir, "tasks", taskId));
    expect(archivePath.startsWith(pluginDir)).toBe(true);

    const meta = JSON.parse(readFileSync(join(archivePath, "meta.json"), "utf8"));
    expect([...Object.keys(meta)].sort()).toEqual(
      [
        "id",
        "prompt",
        "target",
        "model",
        "instancePid",
        "verdict",
        "phaseLog",
        "timings",
      ].sort(),
    );
    expect(meta).toEqual({
      id: taskId,
      prompt: "list three colors",
      target: "C:\\work\\demo-app",
      model: "zcode0/glm-5.3-flash",
      instancePid: 4242,
      verdict: "no_answer",
      phaseLog: [
        "submitting@2023-11-14T22:13:15.100Z",
        "working@2023-11-14T22:13:16.000Z",
        "settling@2023-11-14T22:13:19.500Z",
      ],
      timings: { startedAt: NOW - 5000, settledAt: NOW, elapsedMs: 5000 },
    });
    expect(readFileSync(join(archivePath, "answer.md"), "utf8")).toBe("# Answer\n\nred, green, grün ✅\n");
    expect(readFileSync(join(archivePath, "chat-messages.json"), "utf8")).toBe(
      '{"messages":[{"role":"user","text":"list three colors"}]}',
    );
    expect(readFileSync(join(archivePath, "screen.txt"), "utf8")).toBe("frame\r\nred, green, blue\r\n");
  });

  test("keeps stderr.log with exact content only when stderr is non-empty", () => {
    const withStderr = writeTaskArchive(baseInput());
    expect(readFileSync(join(withStderr.archivePath, "stderr.log"), "utf8")).toBe("boom\n");

    const silent = writeTaskArchive(baseInput({ stderr: "" }));
    expect(existsSync(join(silent.archivePath, "stderr.log"))).toBe(false);
    expect(readdirSync(silent.archivePath).sort()).toEqual([
      "answer.md",
      "chat-messages.json",
      "meta.json",
      "screen.txt",
    ]);
  });

  test("a taskId input pins the directory name instead of a generated stamp", () => {
    const { taskId, archivePath } = writeTaskArchive(baseInput({ taskId: "task-20" }));
    expect(taskId).toBe("task-20");
    expect(archivePath).toBe(join(pluginDir, "tasks", "task-20"));
    const meta = JSON.parse(readFileSync(join(archivePath, "meta.json"), "utf8")) as { id: string };
    expect(meta.id).toBe("task-20");
  });

  test("records a null verdict on success and a verdict string on failure", () => {
    const success = writeTaskArchive(baseInput({ verdict: null }));
    expect(JSON.parse(readFileSync(join(success.archivePath, "meta.json"), "utf8")).verdict).toBeNull();

    const failed = writeTaskArchive(baseInput({ verdict: "frozen" }));
    expect(JSON.parse(readFileSync(join(failed.archivePath, "meta.json"), "utf8")).verdict).toBe("frozen");
  });

  test("leaves an older archive byte-identical when a newer one lands", () => {
    const old = writeTaskArchive(baseInput());
    const oldFiles = ["meta.json", "answer.md", "chat-messages.json", "screen.txt", "stderr.log"];
    const oldBytes = oldFiles.map((name) => readFileSync(join(old.archivePath, name)));

    writeTaskArchive(baseInput({ now: NOW + 1000 }));

    expect(existsSync(old.archivePath)).toBe(true);
    oldFiles.forEach((name, i) => expect(readFileSync(join(old.archivePath, name))).toEqual(oldBytes[i]));
  });
});

describe("archiveSummary", () => {
  test("is zeroed when the tasks directory is missing or empty", () => {
    expect(archiveSummary(pluginDir)).toEqual({ count: 0, totalBytes: 0 });
    expect("newestId" in archiveSummary(pluginDir)).toBe(false);

    mkdirSync(join(pluginDir, "tasks"));
    expect(archiveSummary(pluginDir)).toEqual({ count: 0, totalBytes: 0 });
  });

  test("counts archives, sums file bytes and names the newest", () => {
    const first = writeTaskArchive(baseInput());
    const second = writeTaskArchive(baseInput({ now: NOW + 1000 }));

    const summary = archiveSummary(pluginDir);
    expect(summary.count).toBe(2);
    expect(summary.totalBytes).toBe(sizeOnDisk(join(pluginDir, "tasks")));
    expect(summary.newestId).toBe(second.taskId);
    expect(summary.newestId).not.toBe(first.taskId);
  });

  test("ignores stray non-directory entries", () => {
    mkdirSync(join(pluginDir, "tasks"));
    writeFileSync(join(pluginDir, "tasks", "stray.txt"), "junk");
    writeTaskArchive(baseInput());

    const summary = archiveSummary(pluginDir);
    expect(summary.count).toBe(1);
    expect(summary.totalBytes).toBe(sizeOnDisk(join(pluginDir, "tasks", summary.newestId!)));
  });
});
