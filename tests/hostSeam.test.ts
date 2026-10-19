import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

describe("host seam guard", () => {
  test("only src/host/pty.ts imports host internals", () => {
    const srcDir = join(import.meta.dir, "..", "src");
    // readdirSync(withFileTypes) misreports Dirents under bun test; Bun.Glob
    // scanSync paths come backslash-separated on Windows, so normalize.
    const files = [...new Bun.Glob("**/*.ts").scanSync({ cwd: srcDir })].map(
      (file) => file.replaceAll("\\", "/"),
    );
    const offenders = files.filter(
      (file) =>
        file !== "host/pty.ts" &&
        /@oh-my-pi\/(pi-natives|pi-utils)/.test(
          readFileSync(join(srcDir, file), "utf8"),
        ),
    );
    expect(offenders).toEqual([]);
  });
});

