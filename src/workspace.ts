// One shared Workspace per machine: the Instance's stable cwd, with the session's
// git root mounted at <workspace>/repo. See ADR-0001 for why the Workspace is
// durable and machine-wide rather than per-session.
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readlinkSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, parse, relative, resolve } from "node:path";

export const JUNCTION_NAME = "repo";

// Path-only seam: no fs access here, so tests can inject directories instead.
export function defaultPluginDir(): string {
  return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "freebuff-plugin");
}

// Durable, constant, never session-derived; its basename is freebuff's chat-store key.
export function workspaceDir(pluginDir: string): string {
  return join(pluginDir, "freebuff-ws");
}

// The Junction's current destination — the repo link inside the Workspace —
// undefined when there is no link; what a status report reads back instead of
// remembering a target of its own.
export function readJunctionTarget(workspace: string): string | undefined {
  try {
    // readlink on a junction yields \\?\C:\...; strip the prefix and normalize.
    return resolve(readlinkSync(join(workspace, JUNCTION_NAME)).replace(/^\\\\\?\\/, ""));
  } catch {
    return undefined;
  }
}

// The session's cwd resolved to its git root, so freebuff's "started in a
// subdirectory" rebind never fires and the Instance never leaves repo/. Raw cwd
// when there is no work tree. Git prints forward slashes; resolve normalizes.
export function resolveTarget(cwd: string): string {
  try {
    return resolve(
      execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        encoding: "utf8",
        // Every git failure means "no work tree", so its stderr is noise; Bun's
        // execFileSync leaks piped stderr to the parent without the ignore.
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {
    return resolve(cwd);
  }
}

// readlink on a junction yields \\?\C:\... and git may return any casing or slash
// style; compare every path through one normalized, case-insensitive key.
const pathKey = (p: string): string => resolve(p.replace(/^\\\\\?\\/, "")).toLowerCase();

// A Target must never mount a whole drive, the Workspace itself, or an ancestor of
// the Workspace: repo would then contain its own parent and loop directory walks.
export function assertSafeTarget(target: string, workspace: string): void {
  const resolved = resolve(target);
  if (parse(resolved).root === resolved) throw new Error(`unsafe target: ${resolved} is a filesystem root`);
  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    throw new Error(`unsafe target: ${resolved} does not exist`);
  }
  if (!stat.isDirectory()) throw new Error(`unsafe target: ${resolved} is not a directory`);
  // A different drive can never contain the workspace; on it relative() returns an
  // absolute fallback, so the ancestor check below only applies to the same root.
  if (parse(resolved).root.toLowerCase() !== parse(workspace).root.toLowerCase()) return;
  const rel = relative(resolved, workspace);
  if (rel === "" || !rel.startsWith("..")) throw new Error(`unsafe target: ${resolved} contains the Workspace`);
}

// Points <workspace>/repo at target, creating the workspace when needed. Windows
// junctions need no admin rights, and removing one deletes only the link, never the
// target. Idempotent: an existing junction already on target is left alone, so every
// claim can call this as a self-heal.
export function ensureJunction(workspace: string, target: string): void {
  mkdirSync(workspace, { recursive: true });
  const junction = join(workspace, JUNCTION_NAME);
  const wanted = resolve(target);
  try {
    if (pathKey(readlinkSync(junction)) === pathKey(wanted)) return;
  } catch {
    // No junction yet: create it below.
  }
  // A real directory named `repo` must fail loudly here; recursive removal over
  // this path would delete its contents instead of just the link.
  const existing = lstatSync(junction, { throwIfNoEntry: false });
  if (existing !== undefined && !existing.isSymbolicLink()) {
    throw new Error(`refusing to replace ${junction}: it exists and is not a junction`);
  }
  // unlinkSync, not rmSync: Bun's rmSync faults (EFAULT) on junctions.
  if (existing !== undefined) unlinkSync(junction);
  symlinkSync(wanted, junction, "junction");
}
