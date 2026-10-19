import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import freebuff from "../src/index.ts";
import { createHarnessSession } from "./helpers/sdkHarness.ts";

const TOOL_ROUND_TRIP: MockResponse[] = [
  { content: [{ type: "toolCall", name: "harness_ping", arguments: { msg: "round-trip" } }] },
  { content: ["turn complete"] },
];

describe("sdkHarness", () => {
  test(
    "loads the Extension factory in-process and round-trips a tool call",
    async () => {
      const testFactory = async (pi: ExtensionAPI): Promise<void> => {
        const params = pi.zod.object({ msg: pi.zod.string() });
        pi.registerTool<typeof params>({
          name: "harness_ping",
          label: "Harness ping",
          description: "Echoes its msg parameter back.",
          parameters: params,
          loadMode: "essential",
          execute: async (_toolCallId, toolParams) => ({
            content: [{ type: "text", text: `pong:${toolParams.msg}` }],
          }),
        });
      };

      const harness = await createHarnessSession({
        extensions: [freebuff, testFactory],
        responses: TOOL_ROUND_TRIP,
      });
      try {
        const accepted = await harness.session.prompt("call the tool");
        expect(accepted).toBe(true);
        expect(harness.extensionsResult.errors).toEqual([]);
        expect(harness.session.getActiveToolNames()).toContain("harness_ping");

        const toolResults = harness.session.sessionManager
          .getBranch()
          .flatMap(entry =>
            entry.type === "message" && entry.message.role === "toolResult"
              ? [entry.message.content]
              : [],
          );
        const flat = JSON.stringify(toolResults);
        expect(flat).toContain("pong:round-trip");
      } finally {
        await harness.dispose();
      }
    },
    60_000,
  );

  test(
    "session_shutdown fires on dispose",
    async () => {
      const shutdowns: unknown[] = [];
      const shutdownFactory = async (pi: ExtensionAPI): Promise<void> => {
        pi.on("session_shutdown", payload => {
          shutdowns.push(payload);
        });
      };

      const harness = await createHarnessSession({ extensions: [shutdownFactory] });
      await harness.dispose();
      expect(shutdowns).toHaveLength(1);
    },
    60_000,
  );
});
