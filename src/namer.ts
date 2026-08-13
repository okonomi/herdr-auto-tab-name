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
  if (processes.length === 0) return { kind: "idle" };

  const leader =
    processes.find((p) => p.pid === info.foreground_process_group_id) ??
    processes[processes.length - 1]!;

  if (leader.pid === info.shell_pid) return { kind: "idle" };

  return { kind: "running", command: commandNameOf(leader) };
}
