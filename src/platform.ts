// The one place the tree branches on the runtime OS. Linux is the supported
// runtime; Windows stays working where the branch is cheap (process termination,
// bare-name application resolution, the plugin directory). Everything else in
// src/ stays platform-neutral.
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const isWindows = process.platform === "win32";

// The grace a terminating Instance gets to unwind before SIGKILL. Task TUI
// children that ignore SIGTERM would otherwise hang the escalation forever.
const KILL_POLL_MS = 100;
const KILL_GRACE_MS = 1_000;

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but is owned by someone else: alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const waitDead = async (pid: number, budgetMs: number): Promise<void> => {
  const deadline = Date.now() + budgetMs;
  while (pidAlive(pid) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, KILL_POLL_MS));
  }
};

const signalPid = (pid: number, signal: "SIGTERM" | "SIGKILL"): void => {
  try {
    process.kill(pid, signal);
  } catch (error) {
    // ESRCH = the pid is already gone: the desired end state holds.
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
};

// Terminates the recorded Instance. POSIX: SIGTERM, a bounded grace, then
// SIGKILL — the same escalation the Cancel ladder applies. Windows: taskkill
// /T /F, which also takes the whole child tree. The grace between the two
// signals is this function's own budget: without it every Instance would take a
// hard SIGKILL microseconds after the SIGTERM was merely queued, skipping the
// unwind that keeps a PTY child's state clean. SIGKILL is sent only when the pid
// genuinely survived that budget. Nothing confirms the death here; that wait is
// reclaimLock's, because the reclaim policy must stay correct even when a test
// injects a killPid that never kills. ESRCH — a pid gone between the caller's
// liveness check and these signals — is a tolerated no-op.
export async function killPid(pid: number): Promise<void> {
  if (isWindows) {
    await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]).catch(() => {});
    return;
  }
  signalPid(pid, "SIGTERM");
  await waitDead(pid, KILL_GRACE_MS);
  if (pidAlive(pid)) signalPid(pid, "SIGKILL");
}

// POSIX resolves a bare name over PATH to the executable hit — executable, not
// merely a regular file, so a PATH entry holding an unexecutable namesake is
// skipped and the walk continues; a name carrying a path separator is already
// explicit and passes through. A total miss is left for the spawner to reject:
// the PTY host turns it into an EACCES failure that start() surfaces, so a bogus
// application never wedges a claimed Lock. Windows keeps the PATHEXT walk —
// CreateProcessW runs no extension-less sh shim, which that walk skips for the
// same reason.
// A PATH hit only counts when the file is really executable: on POSIX that is
// the same guard the Windows branch applies by skipping extension-less sh shims,
// and without it a first-entry non-executable file would be handed to the PTY
// host (EACCES) instead of letting the walk reach a real executable further down
// PATH. isFile() alone accepts any regular file.
const isExecutableHit = (candidate: string): boolean => {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export function resolveApplication(
  application: string,
  env: { PATH?: string; PATHEXT?: string } = process.env as { PATH?: string; PATHEXT?: string },
): { application: string; args: [] } {
  const explicit = /[\\/]/.test(application);
  if (explicit) return { application, args: [] };
  if (!isWindows) {
    for (const dir of (env.PATH ?? "").split(":")) {
      if (dir === "") continue;
      const candidate = join(dir, application);
      if (isExecutableHit(candidate)) return { application: candidate, args: [] };
    }
    return { application, args: [] };
  }
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";");
  for (const dir of (env.PATH ?? "").split(";")) {
    if (dir === "") continue;
    for (const ext of extensions) {
      const candidate = join(dir, application + ext.toLowerCase());
      try {
        if (statSync(candidate).isFile()) return { application: candidate, args: [] };
      } catch {
        // Not in this PATH entry: keep looking.
      }
    }
  }
  return { application, args: [] };
}

// The machine-wide plugin directory. XDG_STATE_HOME wins on Linux (the XDG base
// directory for machine state); LOCALAPPDATA is consulted only on Windows, where
// XDG does not exist. The homedir fallback mirrors each OS's own default so a
// missing environment variable still resolves to the conventional path.
export function pluginDir(): string {
  if (isWindows) return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "freebuff-plugin");
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "freebuff-plugin");
}
