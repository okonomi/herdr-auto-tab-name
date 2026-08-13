import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { open, rm, stat, type FileHandle } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ensureStateDir, logPath, pidPath, readPluginEnv, startLockPath } from "./env.js";
import {
  isRunningDaemon,
  readRecord,
  removeRecord,
  writeRecord,
  type DaemonRecord,
} from "./pidfile.js";

const daemonScript = (): string =>
  join(dirname(fileURLToPath(import.meta.url)), "daemon.js");

const START_LOCK_STALE_MS = 30_000;

/** `start.lock` を排他生成で獲得する。既に存在すれば null を返す。EEXIST 以外は投げる。 */
async function tryAcquireStartLock(lockFile: string): Promise<FileHandle | null> {
  try {
    const handle = await open(lockFile, "wx", 0o600);
    await handle.writeFile(String(process.pid));
    return handle;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return null;
  }
}

/**
 * `start` を多重実行から守る排他ロック。
 *
 * pidfile は read-then-write で確認するため、2 つの `start` がほぼ同時に走ると
 * どちらも「デーモンは動いていない」と判断してしまい、二重に spawn しうる。
 * 負けた側は pidfile に記録されないので `stop` / `status` から見えない野良
 * プロセスになる。`open(path, "wx")` によるファイル生成はファイルシステム上
 * atomic なので、これで排他する。
 *
 * ロック保持者が獲得後に死ぬと、ロックファイルが残り続けて誰も `start` でき
 * なくなる。それを避けるため、mtime が 30 秒より古いロックは放棄されたものと
 * みなして奪い、1 回だけ再試行する。それでも取れなければ諦める。
 */
export async function withStartLock<T>(
  stateDir: string,
  body: () => Promise<T>,
): Promise<T | "start already in progress"> {
  await ensureStateDir(stateDir);
  const lockFile = startLockPath(stateDir);

  let handle = await tryAcquireStartLock(lockFile);
  if (handle === null) {
    let stale: boolean;
    try {
      const stats = await stat(lockFile);
      stale = Date.now() - stats.mtimeMs > START_LOCK_STALE_MS;
    } catch {
      // ロックファイルが消えていた(相手が解放し終えた)。取り直しを試す。
      stale = true;
    }
    if (stale) {
      await rm(lockFile, { force: true });
      handle = await tryAcquireStartLock(lockFile);
    }
  }

  if (handle === null) return "start already in progress";

  try {
    return await body();
  } finally {
    await handle.close();
    await rm(lockFile, { force: true });
  }
}

/**
 * デーモンを detached で切り離して起動する。
 *
 * herdr の startup hook が子プロセスを待ち合わせるのか、セッション終了時に kill
 * するのかは herdr のバージョンに依存する。切り離して即座に終わることで、
 * どちらの挙動でも成立させる。
 */
async function start(stateDir: string): Promise<string> {
  return withStartLock(stateDir, async () => {
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
  });
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

/**
 * このファイルが直接実行されたかを判定する。
 * symlink 経由で起動された場合、import.meta.url は実体パスに解決される一方
 * process.argv[1] は symlink のパスのまま渡るため、両者を realpath に揃えて比較する。
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    process.stderr.write(`auto-tab-name cli failed: ${String(error)}\n`);
    process.exit(1);
  });
}
