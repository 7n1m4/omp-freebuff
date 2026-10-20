import { describe, expect, test } from "bun:test";
import { PtySession, Terminal } from "../src/host/pty";

describe("host PTY seam", () => {
  test(
    "spawns a real POSIX shell on a real PTY and renders its screen through the host terminal",
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
        { application: "sh", args: ["-c", "printf POSIX-PTY-OK\\r\\n"], cols: 120, rows: 40 },
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
      for (let poll = 0; !/POSIX-PTY-OK/.test(screen) && poll < 100; poll++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        screen = renderedScreen();
      }
      expect(screen).toMatch(/POSIX-PTY-OK/);
    },
    30_000,
  );

  test(
    "write and kill after the child exits throw the native not-running error",
    async () => {
      const pty = new PtySession();
      const result = await pty.startArgv(
        { application: "sh", args: ["-c", "printf POSIX-PTY-EXIT\\r\\n"], cols: 120, rows: 40 },
        () => {},
      );
      expect(result.cancelled).toBe(false);
      // The native teardown frees the session slightly after the run promise
      // resolves; the driver maps the thrown wording to process_exited, so the
      // exact message is pinned. Bounded poll because the throw is the condition.
      const thrownMessage = async (act: () => void): Promise<string | null> => {
        for (let poll = 0; poll < 100; poll++) {
          try {
            act();
          } catch (error) {
            return (error as Error).message;
          }
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, 25);
          await promise;
        }
        return null;
      };
      expect(await thrownMessage(() => pty.write("echo written\r"))).toBe("PTY session is not running");
      expect(await thrownMessage(() => pty.kill())).toBe("PTY session is not running");
    },
    30_000,
  );
});
