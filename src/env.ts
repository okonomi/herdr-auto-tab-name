import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export type PluginEnv = {
  socketPath: string;
  stateDir: string;
  /**
   * 接続先 socket ごとに state ディレクトリ内のファイルを分けるためのキー。
   *
   * herdr の名前付きセッションはセッションごとに独自の socket を持つ一方、
   * HERDR_PLUGIN_STATE_DIR はセッションを跨いで共有される。ファイル名を
   * 分けないと、2 つめのセッションの start が 1 つめのデーモンの pid レコードを
   * 見て「もう動いている」と誤判断し、そのセッションではタブ名が一切
   * 更新されない。state も分ける必要がある。タブ ID はセッションを跨いで
   * 重複するため、共有すると別セッションの同じ ID のタブの状態を上書きする。
   */
  sessionKey: string;
};

/** socket パスから、ファイル名に使える短い識別子を作る。 */
function sessionKeyOf(socketPath: string): string {
  return createHash("sha256").update(socketPath).digest("hex").slice(0, 8);
}

/** herdr がプラグインのコマンドに注入する環境変数を読む。欠けていたら起動を止める。 */
export function readPluginEnv(env: NodeJS.ProcessEnv): PluginEnv {
  const socketPath = env.HERDR_SOCKET_PATH;
  const stateDir = env.HERDR_PLUGIN_STATE_DIR;
  if (!socketPath) throw new Error("HERDR_SOCKET_PATH is not set");
  if (!stateDir) throw new Error("HERDR_PLUGIN_STATE_DIR is not set");
  return { socketPath, stateDir, sessionKey: sessionKeyOf(socketPath) };
}

export const statePath = (env: PluginEnv): string =>
  join(env.stateDir, `state-${env.sessionKey}.json`);
export const pidPath = (env: PluginEnv): string =>
  join(env.stateDir, `daemon-${env.sessionKey}.json`);
export const logPath = (env: PluginEnv): string =>
  join(env.stateDir, `daemon-${env.sessionKey}.log`);
export const startLockPath = (env: PluginEnv): string =>
  join(env.stateDir, `start-${env.sessionKey}.lock`);

/** state ディレクトリを本人だけが読める権限で用意する。 */
export async function ensureStateDir(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
}
