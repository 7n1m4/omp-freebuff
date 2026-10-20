// Ticket #17 slice 1: the Workspace, Target resolution and the repo junction.
// Proves AC #1: spawn lands in the shared Workspace with repo -> session git root;
// filesystem roots and the Workspace itself are refused as Target.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  assertSafeTarget,
  defaultPluginDir,
  ensureJunction,
  resolveTarget,
  workspaceDir,
} from "../src/workspace";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workspace-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const makeGitRepo = (): string => {
  const repo = join(root, "repo");
  execFileSync("git", ["init", repo], { stdio: "ignore" });
  return repo;
};

describe("defaultPluginDir / workspaceDir", () => {
  test("plugin dir lives under %LOCALAPPDATA%, workspace is its freebuff-ws child (AC #1)", () => {
    expect(defaultPluginDir()).toMatch(/freebuff-plugin$/);
    expect(workspaceDir(join(root, "plugin"))).toBe(join(root, "plugin", "freebuff-ws"));
  });
});

describe("resolveTarget", () => {
  test("maps a repo subdir to the git root (AC #1)", () => {
    const repo = makeGitRepo();
    const subdir = join(repo, "sub", "deeper");
    mkdirSync(subdir, { recursive: true });
    expect(realpathSync(resolveTarget(subdir))).toBe(realpathSync(repo));
  });

  test("falls back to the raw cwd outside a work tree (AC #1)", () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(realpathSync(resolveTarget(plain))).toBe(realpathSync(plain));
  });
});

describe("assertSafeTarget", () => {
  test("refuses a filesystem root (AC #1)", () => {
    const workspace = join(root, "freebuff-ws");
    expect(() => assertSafeTarget(parse(root).root, workspace)).toThrow();
  });

  test("refuses the Workspace itself and any of its ancestors (AC #1)", () => {
    const workspace = join(root, "freebuff-ws");
    expect(() => assertSafeTarget(workspace, workspace)).toThrow();
    expect(() => assertSafeTarget(root, workspace)).toThrow();
  });

  test("refuses a nonexistent target and a plain file (AC #1)", () => {
    const workspace = join(root, "freebuff-ws");
    expect(() => assertSafeTarget(join(root, "missing"), workspace)).toThrow();
    const file = join(root, "file.txt");
    writeFileSync(file, "");
    expect(() => assertSafeTarget(file, workspace)).toThrow();
  });

  test("accepts a normal repo directory (AC #1)", () => {
    const workspace = join(root, "freebuff-ws");
    const repo = makeGitRepo();
    expect(() => assertSafeTarget(repo, workspace)).not.toThrow();
  });
});

describe("ensureJunction", () => {
  test("creates the repo junction and re-points it on a new target (AC #1)", () => {
    const workspace = join(root, "freebuff-ws");
    const targetA = join(root, "target-a");
    const targetB = join(root, "target-b");
    mkdirSync(targetA);
    mkdirSync(targetB);
    ensureJunction(workspace, targetA);
    const junction = join(workspace, "repo");
    expect(realpathSync(junction)).toBe(realpathSync(targetA));
    ensureJunction(workspace, targetB);
    expect(realpathSync(junction)).toBe(realpathSync(targetB));
  });

  test("refuses a real directory named repo and removes nothing (AC #1)", () => {
    const workspace = join(root, "freebuff-ws");
    const target = join(root, "target");
    mkdirSync(target);
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(workspace, "repo"));
    const marker = join(workspace, "repo", "marker.txt");
    writeFileSync(marker, "keep me");
    expect(() => ensureJunction(workspace, target)).toThrow(/not a junction/);
    expect(realpathSync(join(workspace, "repo", "marker.txt"))).toBe(realpathSync(marker));
  });
});

describe("real child in the Workspace", () => {
  test("child spawning with cwd=workspace resolves repo to the git root (AC #1)", () => {
    const repo = makeGitRepo();
    const workspace = join(root, "freebuff-ws");
    ensureJunction(workspace, repo);
    const outFile = join(root, "child-saw.txt");
    const code = `import { realpathSync } from "node:fs";
await Bun.write(${JSON.stringify(outFile)}, realpathSync("repo"));`;
    const proc = Bun.spawnSync({ cmd: ["bun", "-e", code], cwd: workspace, stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode, proc.stderr.toString() + proc.stdout.toString()).toBe(0);
    expect(readFileSync(outFile, "utf8").trim()).toBe(realpathSync(repo));
  });
});
