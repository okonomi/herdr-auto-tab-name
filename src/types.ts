export type HerdrProcess = {
  pid: number;
  name: string;
  argv0: string;
  argv: string[];
  cmdline: string;
  cwd: string;
};

export type PaneProcessInfo = {
  pane_id: string;
  shell_pid: number;
  foreground_process_group_id: number;
  foreground_processes: HerdrProcess[];
};

export type Foreground =
  | { kind: "idle" }
  | { kind: "running"; command: string };

export type TabMode = "auto" | "manual";

export type TabState = {
  mode: TabMode;
  /** 直近に観測した実行中コマンド名。アイドルになっても保持する。 */
  lastCommand: string | null;
  /** このプラグインが最後に設定したタブ名。手動リネームの検知に使う。 */
  lastSetLabel: string | null;
};
