import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type DaemonRecord = {
  pid: number;
  /** デーモンスクリプトの絶対パス。pid 再利用の判別に使う。 */
  script: string;
  startedAt: string;
};

export async function readRecord(filePath: string): Promise<DaemonRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const v = parsed as Record<string, unknown>;
    if (typeof v.pid !== "number" || !Number.isInteger(v.pid) || v.pid <= 0) return null;
    if (typeof v.script !== "string" || v.script.length === 0) return null;
    if (typeof v.startedAt !== "string") return null;
    return { pid: v.pid, script: v.script, startedAt: v.startedAt };
  } catch {
    return null;
  }
}

export async function writeRecord(filePath: string, record: DaemonRecord): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
}

export async function removeRecord(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}

/** シグナル 0 は実際には送られず、プロセスの存在確認だけを行う。 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 指定 pid のコマンドラインを取る。取れなければ null。macOS / Linux の ps に依存する。 */
export function commandLineOf(pid: number): string | null {
  try {
    // -ww: 出力を端末幅で切り詰めない。一部の Linux procps はデフォルトで
    // 切り詰めるため、それを付けないと長いスクリプトパスが途中で切れて
    // isRunningDaemon の一致判定が常に false になり、start のたびに
    // デーモンが重複起動しかねない。
    const out = execFileSync("ps", ["-p", String(pid), "-o", "command=", "-ww"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * 記録されたデーモンが本当に動いているか。
 *
 * pid の生存確認だけでは、pid が再利用されたときに無関係なプロセスを掴む。
 * コマンドラインにデーモンスクリプトのパスが現れることまで確かめる。
 */
export function isRunningDaemon(record: DaemonRecord | null): boolean {
  if (record === null) return false;
  if (!isAlive(record.pid)) return false;
  const commandLine = commandLineOf(record.pid);
  return commandLine !== null && commandLine.includes(record.script);
}
