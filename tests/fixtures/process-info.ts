import type { PaneProcessInfo } from "../../src/types.js";

/** fish のプロンプト待ち。ログインシェルなので argv が "-fish" になっている。 */
export const idleFish: PaneProcessInfo = {
  pane_id: "w6:p1",
  shell_pid: 5357,
  foreground_process_group_id: 5357,
  foreground_processes: [
    {
      pid: 5357,
      name: "fish",
      argv0: "fish",
      argv: ["-fish"],
      cmdline: "-fish",
      cwd: "/Users/okonomi/src/github.com/okonomi/git-stack",
    },
  ],
};

/** claude 単体。name がバージョン文字列になっている点に注意。 */
export const runningClaude: PaneProcessInfo = {
  pane_id: "w9:p1",
  shell_pid: 5362,
  foreground_process_group_id: 22531,
  foreground_processes: [
    {
      pid: 22531,
      name: "2.1.228",
      argv0: "claude",
      argv: ["claude"],
      cmdline: "claude",
      cwd: "/Users/okonomi/src/tries/2026-08-07-spinel-boy",
    },
  ],
};

/** claude が caffeinate を起動した入れ子。プロセスグループのリーダーは claude 側。 */
export const runningClaudeWithCaffeinate: PaneProcessInfo = {
  pane_id: "wA:p1",
  shell_pid: 49691,
  foreground_process_group_id: 50005,
  foreground_processes: [
    {
      pid: 52075,
      name: "caffeinate",
      argv0: "caffeinate",
      argv: ["caffeinate", "-i", "-t", "300"],
      cmdline: "caffeinate -i -t 300",
      cwd: "/Users/okonomi/src/github.com/okonomi/herdr-auto-tab-name",
    },
    {
      pid: 50005,
      name: "2.1.231",
      argv0: "claude",
      argv: ["claude"],
      cmdline: "claude",
      cwd: "/Users/okonomi/src/github.com/okonomi/herdr-auto-tab-name",
    },
  ],
};
