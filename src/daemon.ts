import { appendFile } from "node:fs/promises";
import { SocketHerdrApi } from "./api.js";
import { ensureStateDir, logPath, pidPath, readPluginEnv, statePath } from "./env.js";
import { FailureTracker } from "./failure-tracker.js";
import { runCycle } from "./poller.js";
import { readRecord, removeRecord } from "./pidfile.js";
import { SocketClient } from "./socket.js";
import { StateStore } from "./state.js";

const POLL_INTERVAL_MS = 1_000;
const FAILURE_LIMIT_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const env = readPluginEnv(process.env);
  await ensureStateDir(env.stateDir);
  const file = logPath(env.stateDir);
  const log = (message: string): void => {
    void appendFile(file, `${new Date().toISOString()} ${message}\n`, {
      encoding: "utf8",
      mode: 0o600,
    }).catch(() => {});
  };

  const api = new SocketHerdrApi(new SocketClient(env.socketPath));
  const store = await StateStore.load(statePath(env.stateDir));
  const failures = new FailureTracker(FAILURE_LIMIT_MS);

  let running = true;
  const stop = (signal: string): void => {
    log(`received ${signal}, shutting down`);
    running = false;
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  log(`daemon started pid=${process.pid} socket=${env.socketPath}`);

  while (running) {
    try {
      await runCycle(api, store, log);
      failures.recordSuccess(Date.now());
    } catch (error) {
      log(`cycle failed: ${String(error)}`);
      if (failures.recordFailure(Date.now())) {
        log("herdr server unreachable for too long, exiting");
        break;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  // stop してからこのプロセスが実際に終了するまでの間に別の start が走ると、
  // pidfile には後発のデーモンの記録が上書きされている。無条件に消すと、
  // その後発デーモンが自分の記録を失って野良プロセス化してしまうため、
  // pidfile が今も自分自身を指している場合に限って消す。
  const pidFile = pidPath(env.stateDir);
  const record = await readRecord(pidFile);
  if (record !== null && record.pid === process.pid) {
    await removeRecord(pidFile);
  }
  log("daemon stopped");
}

main().catch((error: unknown) => {
  process.stderr.write(`auto-tab-name daemon failed to start: ${String(error)}\n`);
  process.exit(1);
});
