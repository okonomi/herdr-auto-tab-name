import type { Foreground, HerdrProcess, PaneProcessInfo } from "./types.js";

/** argv0 を表示用のコマンド名に正規化する。ログインシェルの "-fish" や絶対パスを均す。 */
function commandNameOf(process: HerdrProcess): string {
  const withoutDir = process.argv0.split("/").pop() ?? process.argv0;
  return withoutDir.replace(/^-/, "");
}

/**
 * ペインのフォアグラウンド状態を決める。
 *
 * 代表プロセスはプロセスグループのリーダー。claude が caffeinate を起動したような
 * 入れ子でも、リーダーである claude 側が選ばれる。代表プロセスがシェル自身なら
 * プロンプト待ち = アイドル。
 */
export function resolveForeground(info: PaneProcessInfo): Foreground {
  const processes = info.foreground_processes;
  // シェル起動前後や死にかけのペインなど、herdr が foreground_processes を
  // 欠かして(undefined/null)返すことがある。配列でなければ空扱いにして
  // アイドルとみなす。ここで例外を投げると呼び出し元のタブ処理全体が失敗する。
  if (!Array.isArray(processes) || processes.length === 0) return { kind: "idle" };

  const leader =
    processes.find((p) => p.pid === info.foreground_process_group_id) ??
    processes[processes.length - 1]!;

  if (leader.pid === info.shell_pid) return { kind: "idle" };

  return { kind: "running", command: commandNameOf(leader) };
}

/**
 * pane_id を並び順として比較する。"wA:p10" の末尾の数値で比べるため、
 * 単純な文字列比較で p10 が p2 より前に来る問題を避ける。
 */
export function comparePaneId(a: string, b: string): number {
  const numberOf = (id: string): number | null => {
    const match = /(\d+)$/.exec(id);
    return match ? Number(match[1]) : null;
  };
  const na = numberOf(a);
  const nb = numberOf(b);
  if (na !== null && nb !== null) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * タブのフォアグラウンド状態を決める。実行中のペインを優先し、
 * 複数あれば pane_id の若い方を代表とする。
 */
export function resolveTabForeground(infos: PaneProcessInfo[]): Foreground {
  const running = infos
    .map((info) => ({ info, foreground: resolveForeground(info) }))
    .filter(
      (entry): entry is { info: PaneProcessInfo; foreground: { kind: "running"; command: string } } =>
        entry.foreground.kind === "running",
    )
    .sort((x, y) => comparePaneId(x.info.pane_id, y.info.pane_id));

  const first = running[0];
  return first ? first.foreground : { kind: "idle" };
}
