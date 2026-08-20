import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { open, rm, stat, type FileHandle } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ensureStateDir,
  logPath,
  pidPath,
  readPluginEnv,
  startLockPath,
  type PluginEnv,
} from "./env.js";
import {
  isAlive,
  isRunningDaemon,
  isStaleBuild,
  readRecord,
  removeOwnedRecord,
  writeRecord,
  type DaemonRecord,
} from "./pidfile.js";
import { buildStampOf } from "./build-stamp.js";

const distDir = (): string => dirname(fileURLToPath(import.meta.url));
const daemonScript = (): string => join(distDir(), "daemon.js");

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
  env: PluginEnv,
  body: () => Promise<T>,
): Promise<T | "start already in progress"> {
  await ensureStateDir(env.stateDir);
  const lockFile = startLockPath(env);

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

export type StartPlan = "spawn" | "keep" | "replace";

/**
 * `start` が既存のデーモンに対して何をすべきかを決める。
 *
 * 走っているデーモンがあっても、それが古いビルドのコードなら入れ替える。
 * Node は起動時にモジュールを読み込むので、プラグインを更新しても走っている
 * プロセスは古いコードのまま動き続ける。`[[startup]]` は毎セッション `start`
 * を呼ぶので、ここで気づけば更新後の最初のセッションで自動的に入れ替わる。
 */
export function planStart(
  existing: DaemonRecord | null,
  running: boolean,
  currentStamp: string,
): StartPlan {
  if (existing === null || !running) return "spawn";
  return isStaleBuild(existing, currentStamp) ? "replace" : "keep";
}

/**
 * デーモンを detached で切り離して起動する。
 *
 * herdr の startup hook が子プロセスを待ち合わせるのか、セッション終了時に kill
 * するのかは herdr のバージョンに依存する。切り離して即座に終わることで、
 * どちらの挙動でも成立させる。
 *
 * 呼び出し元が `withStartLock` を取っている前提。`forceReplace` はビルドの
 * 新旧に関わらず入れ替える(`restart` 用)。
 */
async function startLocked(env: PluginEnv, forceReplace: boolean): Promise<string> {
  const pidFile = pidPath(env);
  const existing = await readRecord(pidFile);
  const running = isRunningDaemon(existing);
  const buildStamp = await buildStampOf(distDir());
  const plan = forceReplace && running ? "replace" : planStart(existing, running, buildStamp);

  if (plan === "keep") return `already running (pid ${existing!.pid})`;

  let replaced = "";
  if (plan === "replace") {
    const oldPid = existing!.pid;
    const stopped = await stop(env);
    // 落としきれていないなら二重起動になるので、ここで諦める。
    if (isRunningDaemon(await readRecord(pidFile))) return stopped;
    replaced = `replaced pid ${oldPid}; `;
  }

  await ensureStateDir(env.stateDir);
  const logFile = await open(logPath(env), "a", 0o600);
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
    buildStamp,
  };
  await writeRecord(pidFile, record);
  return `${replaced}started (pid ${child.pid})`;
}

async function start(env: PluginEnv): Promise<string> {
  return withStartLock(env, () => startLocked(env, false));
}

/** ビルドが変わっていなくても必ず入れ替える。更新を今すぐ反映したいとき用。 */
async function restart(env: PluginEnv): Promise<string> {
  return withStartLock(env, () => startLocked(env, true));
}

const STOP_POLL_INTERVAL_MS = 100;
const STOP_WAIT_TIMEOUT_MS = 10_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * デーモンは SIGTERM を受けても即座には終わらない(最大 5 秒のソケット
 * リクエスト + 1 秒の sleep で最大 6 秒近くかかりうる)。それを待たずに
 * pidfile を消すと、生きている旧デーモンが自分の終了時処理で「新しい"
 * start" が書いた」pidfile を無条件に消してしまい、後発デーモンが野良化
 * する(README/設計の既知の落とし穴)。実際に死ぬまで待ってから消す。
 */
async function stop(env: PluginEnv): Promise<string> {
  const pidFile = pidPath(env);
  const existing = await readRecord(pidFile);
  if (!isRunningDaemon(existing)) {
    // 死んだデーモンの record だけを片付ける。読めない record や、この直後に
    // 別経路の start が書いた record は他人のものなので触らない。
    if (existing !== null) await removeOwnedRecord(pidFile, existing.pid);
    return "not running";
  }
  const pid = existing!.pid;
  process.kill(pid, "SIGTERM");

  const deadline = Date.now() + STOP_WAIT_TIMEOUT_MS;
  while (isAlive(pid) && Date.now() < deadline) {
    await sleep(STOP_POLL_INTERVAL_MS);
  }

  if (isAlive(pid)) {
    return `sent SIGTERM (pid ${pid}) but it did not exit within ${STOP_WAIT_TIMEOUT_MS / 1000}s; try again`;
  }

  await removeOwnedRecord(pidFile, pid);
  return `stopped (pid ${pid})`;
}

async function status(env: PluginEnv): Promise<string> {
  const existing = await readRecord(pidPath(env));
  if (!isRunningDaemon(existing)) return "not running";
  return `running (pid ${existing!.pid}, started ${existing!.startedAt})`;
}

async function main(): Promise<void> {
  const env = readPluginEnv(process.env);
  const command = process.argv[2] ?? "start";

  const message =
    command === "start"
      ? await start(env)
      : command === "restart"
        ? await restart(env)
        : command === "stop"
          ? await stop(env)
          : command === "status"
            ? await status(env)
            : null;

  if (message === null) {
    throw new Error(
      `unknown command: ${command} (expected start, restart, stop, or status)`,
    );
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
