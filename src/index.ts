import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// Skeleton Extension (ticket #15): no tools, no UI yet. The journal entries are
// the load markers later tickets build the phase log on. Action methods are
// event-gated: the runtime throws when called during factory loading.
export default async function freebuff(pi: ExtensionAPI): Promise<void> {
  pi.on("session_start", () => pi.appendEntry("pi-freebuff", { event: "session_start" }));
  pi.on("session_shutdown", () => pi.appendEntry("pi-freebuff", { event: "session_shutdown" }));
}
