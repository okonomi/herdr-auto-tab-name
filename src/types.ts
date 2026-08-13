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
