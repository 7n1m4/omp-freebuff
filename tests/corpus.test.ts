// The per-version screen fixture corpus, replayed through the emulator and the one
// screen read (classifyScreen). Every fixture in a version folder is a real capture
// of a known screen and classifies at level pass; `negative/` holds frames no
// signature may ever recognize; `synthetic/` holds hand-made emulator vectors. The
// table below is the recorded classification each file must reproduce exactly
// (tests/fixtures/screen/AGENTS.md).
import { readdirSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { corpusVersions } from "../src/protocol/corpus";
import { classifyScreen } from "../src/protocol/screen";
import type { KnownScreen, RecognitionLevel } from "../src/protocol/signatures";
import { replayFixture } from "./helpers/replay";

const corpusDir = new URL("./fixtures/screen/", import.meta.url);

// `<version>/<file>` (no extension) → the screen its name names and the level it must
// recognize at. Version-folder rows are all pass; the six 0.2.29 frames are the
// ticket's binding expectations.
const RECORDED: Record<string, { screen: KnownScreen | null; level: RecognitionLevel }> = {
  "0.1.0/error": { screen: "ready", level: "pass" },
  "0.1.0/ready": { screen: "ready", level: "pass" },
  "0.1.0/welcome": { screen: "Welcome screen", level: "pass" },
  "0.1.2/error": { screen: "ready", level: "pass" },
  "0.1.2/ready": { screen: "ready", level: "pass" },
  "0.1.2/welcome": { screen: "Welcome screen", level: "pass" },
  "0.1.2/welcome-expired": { screen: "Welcome screen", level: "pass" },
  "0.2.12/cost-modal": { screen: "cost modal", level: "pass" },
  "0.2.16/30e30184aaf6e88f4352377d9408782a40d54c0afa556c4836fa7ee7146aa966": { screen: "ready", level: "pass" },
  "0.2.16/52474cdc43e204f58da24453d12ab141e9dbe4e85d37a33e8433b71ce0f19a3c": { screen: "ready", level: "pass" },
  "0.2.16/99d68ac7c47572e8009da897a6c321710d5aaba1686491615bf4b46d607b7cf4": { screen: "displaced", level: "pass" },
  "0.2.19/f8a79ea6d2cde2cd26ba7a5d5ba10140276bc9ca63b98dc87555896b683dd5ea": { screen: "displaced", level: "pass" },
  "0.2.26/1ad46966ba2d9a98a266f78c3e7ae6cdf66d3be1790f7269b88d283f96c83edf": { screen: "ready", level: "pass" },
  "0.2.26/1bd4889e34b9d25c3aa2b3da85a947688804f1a116ace11ff044d52364ba31b8": { screen: "displaced", level: "pass" },
  "0.2.26/2439c5025ca490ae13c06deec65dd94e6c46d726cad577646226338ccd9ce99d": { screen: "displaced", level: "pass" },
  "0.2.26/2d709ae2249affb94ce5896845e27cb6795fd03cf4b897883cc1f6a8b19290d8": { screen: "ready", level: "pass" },
  "0.2.26/689501ccb3550b23df2324e0ef9aacf0996f4682e35ddba066304ec86d6d971e": { screen: "displaced", level: "pass" },
  "0.2.26/b59a23a5c94b746c92a9c5319c01d17bffa7d9efb42c9e491d388a53b2378e89": { screen: "displaced", level: "pass" },
  "0.2.26/b693ee790a95e9a041c7231c193b8d4f9de727e55d5e713812d364c167522d9e": { screen: "ready", level: "pass" },
  "0.2.26/e10392d35f3f5271fda98e789860f7ef22fca166bf81055362f20e146983ede6": { screen: "displaced", level: "pass" },
  "0.2.26/ed69f3ff87475cd366a5a2c7c8cd4d573351f75edc522ed637e4ad39c3bba67c": { screen: "displaced", level: "pass" },
  "0.2.26/f225fcfa2e1f9def5dfc9eb465642ff744eadbcc6fabd2c59410a047170e8c3c": { screen: "displaced", level: "pass" },
  "0.2.27/02c1c37fc9e3958479f3a4a5e4ca4de0247b5690c3a05f689ac0035e6f4eac52": { screen: "ready", level: "pass" },
  "0.2.27/0466821c4c8c3165e2c5f1bc7aaf2b0546aaee9e776113b1efb3f96884612148": { screen: "displaced", level: "pass" },
  "0.2.27/0fd09d4b3eff39433a1e11e6ebe6c2016ee5bb39883bf862844eba007bfce837": { screen: "ready", level: "pass" },
  "0.2.27/22da52956872b96effdf99eb165689ceda6c9f7f471aa61fa4b5405a95dd171f": { screen: "ready", level: "pass" },
  "0.2.27/4b1aeb62e49a9fb1af695b7891e72c5feda3ca4e771f9dacec9bf1832457bcb7": { screen: "ready", level: "pass" },
  "0.2.27/598d8faa2f377beb3b1ef600e7e28c6fb679fb61d45a62035a0168527886949c": { screen: "ready", level: "pass" },
  "0.2.27/6c1f4250f11ed0599694407ce0bd62d9450bebc29a139647212eb4b558ceabe8": { screen: "displaced", level: "pass" },
  "0.2.27/6c9afcfa3172b953f47827a282bfd66c6ef2957390bf91804fbfe290555d3487": { screen: "ready", level: "pass" },
  "0.2.27/70a4d17005cb0daff34c92bb6316da156ef37e55c50a93b6f36eb6f719bee3ca": { screen: "displaced", level: "pass" },
  "0.2.27/7aca9ae7a74938f540c47a71b26641d45eb9f0dac8b96ca6c7eeb311bccdb8eb": { screen: "ready", level: "pass" },
  "0.2.27/8db120eb2abffa3859d5fbc989875329781c028aa6dea50c62c5b35cf5ad1415": { screen: "displaced", level: "pass" },
  "0.2.27/a2f36d114e974432323fe2465b314254a815a09f07c1cfb968e21d45781e2ff6": { screen: "displaced", level: "pass" },
  "0.2.27/a375bed77ef72a9f3f0c5a52e1e3455be09840ef0a2e0c1067ab809c144f4eb2": { screen: "ready", level: "pass" },
  "0.2.27/af266a7f77fa9e00d744588f64f390be3079e5ac90d662b4056c884dad6eed20": { screen: "ready", level: "pass" },
  "0.2.27/b75e57f29ae213fe846b081875066950735e0f8d652bf1b5527de65c485714b7": { screen: "displaced", level: "pass" },
  "0.2.27/c311df2609b5bc4fa9273c008d0d402cc715cd18776a517381fb44db2a26941a": { screen: "displaced", level: "pass" },
  "0.2.27/c52ac7a76b44b59a422ae450618c4b05a8f7f13fd219cee62cbdf2f2745b03fe": { screen: "ready", level: "pass" },
  "0.2.27/c60e40608196332ace2010e6698e2c635a455003bd83d3ed25d945e385adbb3e": { screen: "ready", level: "pass" },
  "0.2.27/d73e71f201c4c4a05d22a02946dff4462027be3ae7917269143321d1e3b4ae46": { screen: "displaced", level: "pass" },
  "0.2.27/eddcb71be8be4700ddc31fe03faf145682ad6bb998797703f2dd3f6d28c0b2d2": { screen: "ready", level: "pass" },
  "0.2.27/f93a813dfe85963ec160f1658bba17ed2d321ebd9a056017d98082b5e733e375": { screen: "ready", level: "pass" },
  "0.2.29/welcome": { screen: "Welcome screen", level: "pass" },
  "0.2.29/take-over-prompt": { screen: "Session-in-use dialog", level: "pass" },
  "0.2.29/ready": { screen: "ready", level: "pass" },
  "0.2.29/working": { screen: "working", level: "pass" },
  "0.2.29/queued-composer": { screen: "draft", level: "pass" },
  "0.2.29/displaced": { screen: "displaced", level: "pass" },
  "negative/ad-panel": { screen: null, level: "fail" },
  "negative/generic-words": { screen: null, level: "fail" },
  "negative/mid-turn-esc": { screen: null, level: "fail" },
  "synthetic/connecting": { screen: "connecting", level: "pass" },
  "synthetic/connecting-to-ready": { screen: "ready", level: "pass" },
  "synthetic/continue-wording-answer": { screen: "ready", level: "pass" },
  "synthetic/login-required": { screen: "login gate", level: "pass" },
  "synthetic/partial-line": { screen: "connecting", level: "pass" },
  "synthetic/repaint": { screen: "ready", level: "pass" },
  "synthetic/split-escape": { screen: "ready", level: "pass" },
  "synthetic/working": { screen: "working", level: "pass" },
};

const FOLDERS = [...corpusVersions(), "negative", "synthetic"].sort();

const onDisk = (folder: string): string[] =>
  readdirSync(new URL(`${folder}/`, corpusDir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ansi"))
    .map((entry) => entry.name.replace(/\.ansi$/, ""))
    .sort();

describe("screen fixture corpus", () => {
  test("holds exactly the version folders on disk", () => {
    expect([...corpusVersions()].sort()).toEqual(
      readdirSync(corpusDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^\d/.test(e.name))
        .map((e) => e.name)
        .sort(),
    );
  });

  test("accounts for every fixture file: no unlisted, no phantom rows", () => {
    expect(Object.keys(RECORDED).sort()).toEqual(
      FOLDERS.flatMap((folder) => onDisk(folder).map((name) => `${folder}/${name}`)).sort(),
    );
  });

  describe.each(FOLDERS)("%s", (folder) => {
    test.each(onDisk(folder))("%s.ansi classifies exactly as recorded", async (name) => {
      const key = `${folder}/${name}`;
      const expected = RECORDED[key];
      expect(expected, `no recorded row for ${key}.ansi`).toBeDefined();
      const read = classifyScreen(await replayFixture(key));
      expect(`${read.identity}/${read.level}`, `${key}.ansi`).toBe(`${expected.screen}/${expected.level}`);
    });
  });

  test("every version-folder fixture recognizes at pass", () => {
    for (const [key, row] of Object.entries(RECORDED)) {
      if (!/^\d/.test(key)) continue;
      expect(`${key}: ${row.level}`).toBe(`${key}: pass`);
    }
  });

  test("every negative fixture matches no known screen", () => {
    for (const [key, row] of Object.entries(RECORDED)) {
      if (!key.startsWith("negative/")) continue;
      expect(`${key}: ${row.screen}/${row.level}`).toBe(`${key}: null/fail`);
    }
  });
});
