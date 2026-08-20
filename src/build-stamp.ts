import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * ビルド済みディレクトリの「版」を表す値を作る。
 *
 * 走っているデーモンが今ディスクにあるコードと同じかを判定するために使う。
 * Node は起動時にモジュールを読み込むので、`dist/` を上書きしてもプロセス内の
 * コードは差し替わらない。デーモンの起動時にこの値を pidfile へ記録しておき、
 * 次の `start` で取り直した値と突き合わせれば、更新に気づける。
 *
 * daemon.js 単体ではなくディレクトリ内の全 `.js` を見るのは、実際に変わるのが
 * daemon.js から読まれる別のモジュール(namer.js など)でありうるため。
 */
export async function buildStampOf(dir: string): Promise<string> {
  const names = await readdir(dir);
  let newest = 0;
  for (const name of names) {
    if (!name.endsWith(".js")) continue;
    const stats = await stat(join(dir, name));
    newest = Math.max(newest, stats.mtimeMs);
  }
  return String(newest);
}
