import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export type PluginEnv = {
  socketPath: string;
  stateDir: string;
};

/** herdr がプラグインのコマンドに注入する環境変数を読む。欠けていたら起動を止める。 */
export function readPluginEnv(env: NodeJS.ProcessEnv): PluginEnv {
  const socketPath = env.HERDR_SOCKET_PATH;
  const stateDir = env.HERDR_PLUGIN_STATE_DIR;
  if (!socketPath) throw new Error("HERDR_SOCKET_PATH is not set");
  if (!stateDir) throw new Error("HERDR_PLUGIN_STATE_DIR is not set");
  return { socketPath, stateDir };
}

export const statePath = (stateDir: string): string => join(stateDir, "state.json");
export const pidPath = (stateDir: string): string => join(stateDir, "daemon.json");
export const logPath = (stateDir: string): string => join(stateDir, "daemon.log");
export const startLockPath = (stateDir: string): string => join(stateDir, "start.lock");

/** state ディレクトリを本人だけが読める権限で用意する。 */
export async function ensureStateDir(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
}
