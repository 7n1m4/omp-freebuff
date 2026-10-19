// The bundled skill at the real host seam: the omp-plugins provider scans
// <extension-root>/skills with requireDescription and the package name, so this
// test calls the host's own loader with exactly those options and asserts what
// the consumer (the system prompt, then the on-demand body) sees.
import { describe, expect, test } from "bun:test";
import { scanSkillsFromDir } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

// _ctx is unused by scanSkillsFromDir; the provider's shape is
// { dir: <root>/skills, providerId, level, requireDescription: true, pluginName: root.name }.
const scan = async () =>
  scanSkillsFromDir({} as LoadContext, {
    dir: join(repoRoot, "skills"),
    providerId: "omp-plugins",
    level: "user",
    requireDescription: true,
    pluginName: "pi-freebuff",
  });

describe("bundled freebuff skill discovery", () => {
  test("exactly one skill, named freebuff, at skills/freebuff/SKILL.md", async () => {
    const { items, warnings } = await scan();
    expect(warnings).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0]!.name).toBe("freebuff");
    expect(items[0]!.path.replaceAll("\\", "/")).toMatch(/skills\/freebuff\/SKILL\.md$/);
  });

  test("description is non-empty and names the trigger use cases", async () => {
    const { items } = await scan();
    const description = items[0]!.frontmatter?.description;
    expect(typeof description).toBe("string");
    if (typeof description !== "string") throw new Error("skill has no description");
    expect(description.length).toBeGreaterThan(0);
    // What it does, and when: a long independent Task vs doing the work in-session.
    expect(description).toContain("freebuff_run");
    expect(description).toMatch(/long/i);
    expect(description).toMatch(/in-session/i);
    expect(description).toMatch(/Task/);
  });

  test("body loads on demand: frontmatter stripped, protocol words present", async () => {
    const { items } = await scan();
    const body = items[0]!.content;
    expect(body.length).toBeGreaterThan(0);
    expect(body.startsWith("---")).toBe(false);
    for (const word of ["freebuff_run", "freebuff_progress", "freebuff_cancel", "Ack"]) {
      expect(body).toContain(word);
    }
  });
});
