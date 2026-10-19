// Ticket #18 slice 3, acceptance criterion 1: a Task submitted from a real OMP
// session. The harness builds a real agent session; a test extension registers
// one essential tool that runs a TurnRunner against the stub child and returns
// the TurnOutcome as tool content.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { TurnRunner, type TurnOutcome } from "../src/turnRunner";
import { createHarnessSession } from "./helpers/sdkHarness";

const stubPath = join(import.meta.dir, "helpers", "stub-freebuff.mjs");
const TIMINGS = { settleMs: 4_000, ackMs: 1_500, pollMs: 25, pasteSettleMs: 60, pressThrottleMs: 120 };
const PROMPT = "probe the freebuff task path";
const ANSWER = `stub(DeepSeek V4.1 Flash): ${PROMPT}`;

const PROBE_ROUND_TRIP: MockResponse[] = [
  { content: [{ type: "toolCall", name: "freebuff_run_probe", arguments: { prompt: PROMPT } }] },
  { content: ["turn complete"] },
];

describe("Task submitted from a real OMP session", () => {
  test(
    "essential tool runs a TurnRunner and the tool result carries the stub answer",
    async () => {
      const pluginDir = mkdtempSync(join(tmpdir(), "harness-plugin-"));
      const configDir = mkdtempSync(join(tmpdir(), "harness-config-"));
      const workspace = mkdtempSync(join(tmpdir(), "harness-ws-"));
      // The runner lives outside execute's scope so the test's finally can
      // dispose it even when the tool call never completes. Object wrapper:
      // flow analysis cannot see the closure assignment, a plain let narrows
      // to null at the finally.
      const state: { probeRunner: TurnRunner | null } = { probeRunner: null };

      const probeFactory = async (pi: ExtensionAPI): Promise<void> => {
        const params = pi.zod.object({ prompt: pi.zod.string() });
        pi.registerTool<typeof params>({
          name: "freebuff_run_probe",
          label: "Freebuff run probe",
          description: "Runs one blocking freebuff Task and returns the TurnOutcome.",
          parameters: params,
          loadMode: "essential",
          execute: async (_toolCallId, { prompt }) => {
            const runner = new TurnRunner({
              pluginDir,
              workspace,
              freebuffConfigDir: configDir,
              command: { application: process.execPath, args: [stubPath] },
              env: { FREEBUFF_STUB_MODE: "happy" },
              timings: TIMINGS,
            });
            state.probeRunner = runner;
            const outcome = await runner.run(prompt);
            return { content: [{ type: "text", text: JSON.stringify(outcome) }] };
          },
        });
      };

      const harness = await createHarnessSession({
        extensions: [probeFactory],
        responses: PROBE_ROUND_TRIP,
      });
      try {
        expect(await harness.session.prompt(`use the probe tool with prompt ${PROMPT}`)).toBe(true);
        expect(harness.extensionsResult.errors).toEqual([]);
        expect(harness.session.getActiveToolNames()).toContain("freebuff_run_probe");

        const toolResults = harness.session.sessionManager
          .getBranch()
          .flatMap(entry =>
            entry.type === "message" && entry.message.role === "toolResult"
              ? [entry.message.content]
              : [],
          );
        const outcomeTexts = toolResults.flatMap(content =>
          content.flatMap(part => (part.type === "text" ? [part.text] : [])),
        );
        expect(outcomeTexts).toHaveLength(1);
        const outcome = JSON.parse(outcomeTexts[0]) as TurnOutcome;
        expect(outcome).toEqual({ ok: true, answer: ANSWER });
      } finally {
        await state.probeRunner?.dispose();
        await harness.dispose();
        for (const dir of [pluginDir, configDir, workspace]) {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            // Windows cwd lock after the PTY kill; the OS cleans tmp.
          }
        }
      }
    },
    60_000,
  );
});
