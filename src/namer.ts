import type { Foreground, HerdrProcess, PaneProcessInfo } from "./types.js";

/**
 * argv0 がインタプリタ本体かどうか。shebang 付きスクリプトを実行すると exec されるのは
 * インタプリタなので、argv0 の basename はスクリプト名にならない。
 *
 * 構造からは見分けられないため名前で当てるしかない。macOS の framework build は
 * 起動時に自分を Python.app として再 exec するので、大文字始まりの "Python" も拾う。
 */
const INTERPRETER = /^(python|Python)[\d.]*$|^(ruby|node|perl|bash|sh|zsh|php)$/;

function baseNameOf(path: string): string {
  return path.split("/").pop() ?? path;
}

/**
 * setproctitle 系で argv0 を書き換えたプロセスから、表示用のコマンド名を採る。
 * 書き換えられていなければ null。
 *
 * puma や gunicorn のようにインタプリタが起動するサーバでは、p_comm も実行ファイルの
 * パスもインタプリタ名(ruby / python)にしかならず、argv[1] は書き換えで潰れている。
 * 一方どの実装も "puma 6.4.2 (tcp://...)" "gunicorn: master [app]" "postgres: checkpointer"
 * のようにコマンド名を先頭に置くので、そこだけを採る。
 *
 * 空白を含む argv0 には "/Applications/Google Chrome.app/..." のようなスペース入りの
 * パスもある。実測したかぎり後者は必ず先頭のトークンにパス区切りを含むので、それで分ける。
 */
function rewrittenTitleNameOf(argv0: string): string | null {
  const title = argv0.trim();
  const head = title.split(/\s/)[0] ?? "";
  if (head === "" || head === title || head.includes("/")) return null;
  return head.replace(/:$/, "");
}

/**
 * argv0 を表示用のコマンド名に正規化する。ログインシェルの "-fish" や絶対パスを均す。
 * setproctitle で書き換えられていればその先頭のトークンを、インタプリタなら
 * argv[1] のスクリプト名に読み替える。
 */
function commandNameOf(process: HerdrProcess): string {
  const rewritten = rewrittenTitleNameOf(process.argv0);
  if (rewritten !== null) return rewritten;

  const name = baseNameOf(process.argv0).replace(/^-/, "");
  if (!INTERPRETER.test(name)) return name;

  // python -m http.server や引数なしの REPL のように argv[1] がスクリプトパスでない
  // ケースは読み替えず、インタプリタ名のままにする。
  const script = process.argv[1];
  if (script === undefined || script === "" || script.startsWith("-")) return name;

  return baseNameOf(script);
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
