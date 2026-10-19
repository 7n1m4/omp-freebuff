import { describe, expect, test } from "bun:test";
import { PtySession, Terminal } from "../src/host/pty";

describe("host PTY seam", () => {
  test(
    "spawns cmd.exe on a real PTY and renders its screen through the host terminal",
    async () => {
      const pty = new PtySession();
      const terminal = new Terminal({
        cols: 120,
        rows: 40,
        scrollback: 0,
        allowProposedApi: true,
        disableStdin: true,
      });
      const result = await pty.startArgv(
        { application: "cmd.exe", args: ["/c", "ver"], cols: 120, rows: 40 },
        (error, chunk) => {
          if (error === null) terminal.write(chunk);
        },
      );
      expect(result.cancelled).toBe(false);
      // The PTY delivers trailing paint asynchronously after the run settles and
      // exposes no output-drained signal, so await the condition itself with a
      // bounded poll instead of a fixed wait.
      const renderedScreen = (): string => {
        const buffer = terminal.buffer.active;
        const rows: string[] = [];
        for (let row = 0; row < terminal.rows; row++) {
          rows.push(buffer.getLine(row)?.translateToString(true) ?? "");
        }
        return rows.join("\n");
      };
      let screen = renderedScreen();
      for (let poll = 0; !/Microsoft Windows \[Version/.test(screen) && poll < 100; poll++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        screen = renderedScreen();
      }
      expect(screen).toMatch(/Microsoft Windows \[Version/);
    },
    30_000,
  );
});
