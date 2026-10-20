// Headless Keeper entry for the scheduled task (ADR-0002): one runKeeper per
// invocation, no extension host. PI_FREEBUFF_KEEPER_JSON carries a full
// KeeperOptions object (the PI_FREEBUFF_RUNNER_JSON convention). Progress tees
// to the console and to ./keeper.log in the working directory (repo root).
// Exit 0 on spawned/skipped, 1 on error.
import { appendFileSync } from "node:fs";
import { runKeeper, type KeeperOptions } from "../src/keeper";

const LOG_FILE = "keeper.log";
const ENV_JSON = "PI_FREEBUFF_KEEPER_JSON";

const log = (message: string): void => {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  appendFileSync(LOG_FILE, `${line}\n`);
};

try {
  const injected = process.env[ENV_JSON];
  const options: KeeperOptions = injected === undefined ? {} : (JSON.parse(injected) as KeeperOptions);
  const report = await runKeeper({ ...options, log });
  log(`${report.action}${report.reason === undefined ? "" : ` (${report.reason})`}`);
} catch (error) {
  log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
