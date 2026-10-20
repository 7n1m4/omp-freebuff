// The recorded classification the corpus test and the doctor's drift check both
// compare against: `<folder>/<file>` (no extension) → the screen its name names and
// the level it must recognize at. Version-folder rows are all pass; the six 0.2.29
// frames are the ticket's binding expectations.
import type { KnownScreen, RecognitionLevel } from "./signatures";

// The freebuff CLI version the live wordings were measured against: the six 0.2.29
// rows below and the marker table in markers.ts. The live tier refuses to run
// against any other version, because the wordings it matches on are version-bound.
export const MEASURED_FREEBUFF_VERSION = "0.2.29";

// The version gate for the live tier: ok only when the installed CLI is exactly the
// measured one. null (unreadable metadata) and any mismatch refuse, and the refusal
// names the capture re-measure path — capture drift dumps, promote them into the
// corpus folder, add the RECORDED rows.
export function measuredVersionReport(installed: string | null): { ok: boolean; message: string } {
  if (installed === null) {
    return {
      ok: false,
      message:
        "Cannot read the installed freebuff version from the config-dir metadata; refusing to guess. " +
        "Repair or reinstall the freebuff CLI so the metadata file reports its version.",
    };
  }
  if (installed !== MEASURED_FREEBUFF_VERSION) {
    return {
      ok: false,
      message:
        `Installed freebuff ${installed}, but the screen wordings were measured against ${MEASURED_FREEBUFF_VERSION}. ` +
        `Re-measure in capture mode: PI_FREEBUFF_CAPTURE=1 bun test tests/liveCapture.test.ts, ` +
        `then promote the dumps into tests/fixtures/screen/${installed}/, add the RECORDED rows, ` +
        `and set MEASURED_FREEBUFF_VERSION to ${installed} (tests/corpus.test.ts enforces the corpus contract).`,
    };
  }
  return { ok: true, message: `freebuff ${installed} matches the measured screen wordings.` };
}

export const RECORDED: Record<string, { screen: KnownScreen | null; level: RecognitionLevel }> = {
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
  "0.2.29/ready-post-completion": { screen: "ready", level: "pass" },
  "negative/ad-panel": { screen: null, level: "fail" },
  "negative/generic-words": { screen: null, level: "fail" },
  "negative/mid-turn-esc": { screen: null, level: "fail" },
  "synthetic/connecting": { screen: "connecting", level: "pass" },
  "synthetic/connecting-to-ready": { screen: "ready", level: "pass" },
  "synthetic/continue": { screen: "Continue", level: "pass" },
  "synthetic/continue-wording-answer": { screen: "ready", level: "pass" },
  "synthetic/login-required": { screen: "login gate", level: "pass" },
  "synthetic/partial-line": { screen: "connecting", level: "pass" },
  "synthetic/repaint": { screen: "ready", level: "pass" },
  "synthetic/split-escape": { screen: "ready", level: "pass" },
  "synthetic/working": { screen: "working", level: "pass" },
};
