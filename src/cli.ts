import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ensureStateDir, logPath, pidPath, readPluginEnv } from "./env.js";
import {
  isRunningDaemon,
  readRecord,
  removeRecord,
  writeRecord,
  type DaemonRecord,
} from "./pidfile.js";

const daemonScript = (): string =>
  join(dirname(fileURLToPath(import.meta.url)), "daemon.js");

/**
 * デーモンを detached で切り離して起動する。
 *
 * herdr の startup hook が子プロセスを待ち合わせるのか、セッション終了時に kill
 * するのかは herdr のバージョンに依存する。切り離して即座に終わることで、
 * どちらの挙動でも成立させる。
 */
async function start(stateDir: string): Promise<string> {
  const pidFile = pidPath(stateDir);
  const existing = await readRecord(pidFile);
  if (isRunningDaemon(existing)) {
    return `already running (pid ${existing!.pid})`;
  }

  await ensureStateDir(stateDir);
  const logFile = await open(logPath(stateDir), "a", 0o600);
  const script = daemonScript();
  const child = spawn(process.execPath, [script], {
    detached: true,
    stdio: ["ignore", logFile.fd, logFile.fd],
    env: process.env,
  });
  child.unref();
  await logFile.close();

  if (child.pid === undefined) throw new Error("failed to spawn the daemon");
  const record: DaemonRecord = {
    pid: child.pid,
    script,
    startedAt: new Date().toISOString(),
  };
  await writeRecord(pidFile, record);
  return `started (pid ${child.pid})`;
}

async function stop(stateDir: string): Promise<string> {
  const pidFile = pidPath(stateDir);
  const existing = await readRecord(pidFile);
  if (!isRunningDaemon(existing)) {
    await removeRecord(pidFile);
    return "not running";
  }
  process.kill(existing!.pid, "SIGTERM");
  await removeRecord(pidFile);
  return `stopped (pid ${existing!.pid})`;
}

async function status(stateDir: string): Promise<string> {
  const existing = await readRecord(pidPath(stateDir));
  if (!isRunningDaemon(existing)) return "not running";
  return `running (pid ${existing!.pid}, started ${existing!.startedAt})`;
}

async function main(): Promise<void> {
  const env = readPluginEnv(process.env);
  const command = process.argv[2] ?? "start";

  const message =
    command === "start"
      ? await start(env.stateDir)
      : command === "stop"
        ? await stop(env.stateDir)
        : command === "status"
          ? await status(env.stateDir)
          : null;

  if (message === null) {
    throw new Error(`unknown command: ${command} (expected start, stop, or status)`);
  }
  process.stdout.write(`auto-tab-name: ${message}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`auto-tab-name cli failed: ${String(error)}\n`);
  process.exit(1);
});
