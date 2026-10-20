// The five-tool async surface over the process-scoped singleton (ADR-0004).
// OMP rebinds this factory per session, and action methods throw while the
// factory loads, so everything beyond registration happens inside a tool
// execute or a session_shutdown handler: the runner config is parsed on first
// use, the singleton is created on first use, and each session's OwnerBinding
// is captured from the first execute's ctx. The session_start/shutdown journal
// entries are the load markers later tickets build the phase log on.
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { runDoctor } from "./doctor";
import { defaultFreebuffConfigDir, freebuffStatus, type StatusResult } from "./status";
import type { FreebuffSingleton, OwnerBinding, ProgressDetails, SettlePush, SubmitOk } from "./singleton";
import { getFreebuffSingleton, peekFreebuffSingleton } from "./singleton";
import type { TurnRunnerOptions } from "./turnRunner";
import { defaultPluginDir, workspaceDir } from "./workspace";

const RUNNER_JSON_ENV = "PI_FREEBUFF_RUNNER_JSON";

// Memoized on the raw env value: production never changes it, so this parses
// once per process, while a test rig (a new JSON per test) re-reads the env.
let cachedJson: string | undefined;
let cachedConfig: TurnRunnerOptions | undefined;

const runnerOptions = (): TurnRunnerOptions => {
  const raw = process.env[RUNNER_JSON_ENV];
  if (raw === cachedJson && cachedConfig !== undefined) return cachedConfig;
  let config: TurnRunnerOptions;
  if (raw === undefined || raw === "") {
    const pluginDir = defaultPluginDir();
    config = {
      pluginDir,
      workspace: workspaceDir(pluginDir),
      freebuffConfigDir: defaultFreebuffConfigDir(),
      command: { application: "freebuff" },
    };
  } else {
    const parsed = JSON.parse(raw) as Partial<TurnRunnerOptions>;
    for (const key of ["pluginDir", "workspace", "freebuffConfigDir", "command"] as const) {
      if (parsed[key] === undefined) throw new Error(`${RUNNER_JSON_ENV} is missing "${key}"`);
    }
    config = parsed as TurnRunnerOptions;
  }
  cachedJson = raw;
  cachedConfig = config;
  return config;
};

// Per-session UI wiring lives here, never in the singleton: the singleton owns
// tasks, queue and Instance; a binding is only the paint/push pair of the
// session that submitted them.
const bindings = new Map<string, OwnerBinding>();

// The process's live sessions (#23, ADR-0004): teardown triggers when this
// drains, never on the bindings map. A subagent can hold the only binding
// while a session that never called a tool is still alive, and Set.add
// dedupes the session_start a re-emitted start fires again.
const liveSessions = new Set<string>();

const labelOf = (ctx: ExtensionContext): string => {
  if (ctx.agent.kind === "main") return "main";
  if (ctx.agent.kind === "sub") return `sub:${ctx.agent.name}`;
  return ctx.sessionManager.getSessionId().slice(0, 8);
};

// Success renders the verbatim answer; failure a short verdict line. Never
// truncated: this text is the delivery channel (the poll is the recovery).
const failedLine = (taskId: string, verdict: string | undefined, message: string | undefined): string =>
  message
    ? `freebuff task ${taskId} failed (${verdict ?? "failed"}): ${message}`
    : `freebuff task ${taskId} failed (${verdict ?? "failed"})`;

const payloadText = (payload: SettlePush): string => {
  if (payload.ok) return payload.answer ?? "";
  return failedLine(payload.taskId, payload.verdict, payload.message);
};

const bindingFor = (pi: ExtensionAPI, ctx: ExtensionContext): OwnerBinding => {
  const sessionId = ctx.sessionManager.getSessionId();
  const existing = bindings.get(sessionId);
  if (existing !== undefined) return existing;
  const binding: OwnerBinding = {
    sessionId,
    label: labelOf(ctx),
    hasUI: ctx.hasUI,
    paint: line => {
      if (!ctx.hasUI) return;
      try {
        ctx.ui.setStatus("pi-freebuff", line);
      } catch {
        // A broken status line never fails the paint timer's tick.
      }
    },
    push: payload => {
      try {
        pi.sendMessage(
          { customType: "pi-freebuff", content: payloadText(payload), display: true, details: payload },
          { deliverAs: "aside" },
        );
      } catch {
        // A push to a gone session must never fail the settle.
      }
    },
  };
  bindings.set(sessionId, binding);
  return binding;
};

// Structured refusals (plain objects thrown by the singleton) become tool
// errors: the message is the text, the object itself the details.
const errorResult = (error: unknown): AgentToolResult => {
  if (typeof error === "object" && error !== null && "code" in error) {
    const rejection = error as { code: string; message?: string };
    return {
      isError: true,
      content: [{ type: "text", text: rejection.message ?? JSON.stringify(rejection) }],
      details: error,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: message }], details: { code: "error", message } };
};

const runText = (ok: SubmitOk): string => {
  const where = ok.phase === "queued" ? `queued at position ${ok.position}` : "working";
  return (
    `freebuff task ${ok.taskId} ${where}; ` +
    `the answer arrives as an asynchronous push to this conversation and stays pollable via ` +
    `freebuff_progress(taskId: "${ok.taskId}"). One Task runs at a time, queue depth 4; ` +
    `only the owning session's calls are answered.`
  );
};

const progressText = (details: ProgressDetails): string => {
  const at =
    details.phase === "queued" && details.position !== undefined
      ? `queued at position ${details.position}`
      : details.phase;
  const feed =
    details.steps !== undefined
      ? `, step ${details.steps}${details.lastToolCall === undefined ? "" : ` after ${details.lastToolCall}`}`
      : "";
  return `freebuff task ${details.taskId} ${at} (${details.phaseSource}, ${Math.floor(details.elapsedMs / 1000)}s${feed})`;
};

const statusText = (status: StatusResult & { queue: { depth: number }; activeTask: { taskId: string; phase: string } | null }): string => {
  const parts = [
    `lock ${status.lock.state}`,
    `instance ${status.instancePid ?? "none"}`,
    ...(status.hourMinutesLeft !== undefined ? [`hour ${status.hourMinutesLeft}m left`] : []),
    `queue ${status.queue.depth}`,
    status.activeTask === null ? "no active task" : `active ${status.activeTask.taskId} (${status.activeTask.phase})`,
    `archive ${status.archive.count} ${status.archive.count === 1 ? "task" : "tasks"}`,
    ...(status.abandoned.length > 0 ? [`abandoned ${status.abandoned.length}`] : []),
    ...(status.screenDrift ? ["screen drift"] : []),
  ];
  return parts.join("; ");
};

interface ScreenDetails {
  taskId?: string;
}

// Every call joins the one process singleton (ADR-0004); the deps factory only
// matters on first creation.
const singletonOf = (): FreebuffSingleton => getFreebuffSingleton(() => ({ runner: runnerOptions() }));

export default async function freebuff(pi: ExtensionAPI): Promise<void> {
  pi.on("session_start", (_event, ctx) => {
    liveSessions.add(ctx.sessionManager.getSessionId());
    pi.appendEntry("pi-freebuff", { event: "session_start" });
  });
  pi.on("session_shutdown", (_event, ctx) => {
    pi.appendEntry("pi-freebuff", { event: "session_shutdown" });
    const sessionId = ctx.sessionManager.getSessionId();
    liveSessions.delete(sessionId);
    bindings.delete(sessionId);
    // The singleton keeps every task it owns; only this binding's paint/push
    // go silent. A config that never parsed has nothing to clean.
    try {
      singletonOf().bindingGone(sessionId);
    } catch {
      // No workable config: no binding was ever registered.
    }
    // The last live session of the process is gone (#23): kill the Instance
    // before deleting the Lock (ADR-0003). Fire-and-forget: the host's
    // shutdown must not wait on the PTY, and teardown contains each of its
    // own steps. peek never creates: a process whose sessions never used a
    // tool has nothing to tear down. The torn_down latch on the captured
    // singleton holds until the process scope resets, so a session rebinding
    // into this process still finds the gate; that is reachable only after
    // every session left, never while one lives.
    if (liveSessions.size === 0) {
      void peekFreebuffSingleton()?.teardown().catch(() => {});
    }
  });

  const runParams = pi.zod.object({
    prompt: pi.zod.string().describe("The prompt to submit to freebuff as one Task."),
  });
  pi.registerTool<typeof runParams>({
    name: "freebuff_run",
    label: "Freebuff run",
    description:
      "Submit one freebuff Task. Returns at the Ack, not the answer: {taskId, phase: \"working\"}, or " +
      "{taskId, phase: \"queued\", position} when another Task is in flight. The answer arrives later as an " +
      "asynchronous push (aside) into this conversation and stays pollable via freebuff_progress. " +
      "One Task runs at a time, queue depth 4; only the owning session's calls are answered.",
    parameters: runParams,
    loadMode: "essential",
    execute: async (_toolCallId, { prompt }, signal, _onUpdate, ctx) => {
      const singleton = singletonOf();
      const binding = bindingFor(pi, ctx);
      // The user stopping the parent's turn aborts this signal (#22): the
      // singleton decides detach (working) vs cancel (queued/submitting).
      const onAbort = () => {
        try {
          singleton.interrupt(binding, signal?.reason);
        } catch {
          // Contained: an interrupt must never fail the tool call itself.
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const ok = await singleton.submit({
          prompt,
          cwd: ctx.cwd,
          binding,
        });
        return { content: [{ type: "text", text: runText(ok) }], details: ok };
      } catch (error) {
        return errorResult(error);
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  });

  const progressParams = pi.zod.object({
    taskId: pi.zod.string().optional().describe("Omit for the active task (else the newest); or name a task."),
  });
  pi.registerTool<typeof progressParams>({
    name: "freebuff_progress",
    label: "Freebuff progress",
    description:
      "Poll one freebuff Task: phase (queued, submitting, working, settling, done, failed) and, once done, " +
      "the verbatim answer. Omit taskId for the active task, else the newest. Only the owning session is answered.",
    parameters: progressParams,
    loadMode: "essential",
    execute: async (_toolCallId, { taskId }, _signal, _onUpdate, ctx) => {
      try {
        const details = singletonOf().progress(taskId, bindingFor(pi, ctx));
        if (details.phase === "failed") {
          // Push and poll render the identical failure line: failedLine is the
          // lockstep formatter both delivery channels share.
          return { isError: true, content: [{ type: "text", text: failedLine(details.taskId, details.verdict, details.message) }], details };
        }
        if (details.phase === "done") {
          return { content: [{ type: "text", text: details.answer ?? "" }], details };
        }
        return { content: [{ type: "text", text: progressText(details) }], details };
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const noParams = pi.zod.object({});
  pi.registerTool<typeof noParams>({
    name: "freebuff_cancel",
    label: "Freebuff cancel",
    description:
      "Stop the active freebuff Task (Esc, a wait, Ctrl-C up to three times, then a forced kill). Targets only " +
      "the active Task and takes no taskId; the queue keeps running behind it. Owner-gated: refused while " +
      "another session's Task is in flight. Waits for the Task to settle before returning, which can take up " +
      "to about five seconds. An active Task's partial progress is archived and the result carries its " +
      "archivePath.",
    parameters: noParams,
    loadMode: "essential",
    execute: async (_toolCallId, _args, _signal, _onUpdate, ctx) => {
      try {
        const result = await singletonOf().cancel(bindingFor(pi, ctx));
        const archive = result.archivePath === undefined ? "" : `; archive: ${result.archivePath}`;
        const head =
          result.verdict === "done"
            ? `freebuff task ${result.taskId} finished before the cancel landed`
            : `freebuff task ${result.taskId} cancelled (verdict ${result.verdict})`;
        return {
          content: [{ type: "text", text: `${head}${archive}` }],
          details: result,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool<typeof noParams>({
    name: "freebuff_status",
    label: "Freebuff status",
    description:
      "freebuff diagnostics, readable from any session: Lock state, Instance pid, junction target, foreign " +
      "slot holders, Task archive summary, plus this process's queue and active Task.",
    parameters: noParams,
    loadMode: "essential",
    execute: async () => {
      try {
        const options = runnerOptions();
        const singleton = singletonOf();
        const instancePid = singleton.instancePid() ?? undefined;
        const details: StatusResult & { queue: { depth: number; taskIds: string[] }; activeTask: { taskId: string; phase: string } | null } = {
          ...freebuffStatus({
            pluginDir: options.pluginDir,
            freebuffConfigDir: options.freebuffConfigDir,
            instancePid,
            // Our own record names our pid with a live Task behind it: without
            // this the stale-by-identity arm misreads every active run.
            hasLiveTask: () => singleton.statusExtra().activeTask !== null,
          }),
          ...singleton.statusExtra(),
        };
        return { content: [{ type: "text", text: statusText(details) }], details };
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool<typeof noParams>({
    name: "freebuff_screen",
    label: "Freebuff screen",
    description:
      "Read the freebuff Instance's flattened terminal screen. Owner-gated: refused with not_owner while " +
      "another session's Task is in flight.",
    parameters: noParams,
    loadMode: "essential",
    execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
      try {
        const singleton = singletonOf();
        const text = await singleton.screenText(bindingFor(pi, ctx));
        const active = singleton.statusExtra().activeTask;
        const details: ScreenDetails = active === null ? {} : { taskId: active.taskId };
        return { content: [{ type: "text", text }], details };
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  // A slash command, not a tool: the model never calls it, the user runs it
  // after a freebuff update to re-prove the keystroke whitelist and the screen
  // recognition. The owner-gated screen read doubles as the liveness probe:
  // any refusal or throw just means no readable Instance, and the report
  // covers the corpus checks alone.
  pi.registerCommand("freebuff-doctor", {
    description:
      "Run the freebuff doctor: the keystroke-whitelist and screen-drift checks over the recorded fixtures, " +
      "plus the Instance's current screen when one is readable; the check to run after a freebuff update.",
    handler: async (_args, ctx) => {
      let liveScreen: { text: string; configDir: string } | undefined;
      try {
        const text = await singletonOf().screenText(bindingFor(pi, ctx));
        liveScreen = { text, configDir: runnerOptions().freebuffConfigDir };
      } catch {
        // No readable Instance: the corpus checks still run.
      }
      const report = await runDoctor({ ...(liveScreen === undefined ? {} : { liveScreen }) });
      try {
        pi.sendMessage(
          {
            customType: "pi-freebuff",
            content: report.text,
            display: true,
            details: { kind: "doctor", level: report.level, checks: report.checks },
          },
          { deliverAs: "aside" },
        );
      } catch {
        // A push to a gone session must never fail the command.
      }
    },
  });
}
