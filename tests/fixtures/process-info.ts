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

/**
 * shebang 付きスクリプト (podman-compose)。exec されるのはインタプリタ本体なので
 * argv0 はインタプリタのパスになり、スクリプト名は argv[1] 側にある。
 * macOS の framework build は自分を Python.app として再 exec するため basename が "Python" になる。
 */
export const runningPodmanCompose: PaneProcessInfo = {
  pane_id: "w1:p2",
  shell_pid: 5357,
  foreground_process_group_id: 67420,
  foreground_processes: [
    {
      pid: 67420,
      name: "Python",
      argv0:
        "/opt/homebrew/Cellar/python@3.14/3.14.6/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python",
      argv: [
        "/opt/homebrew/Cellar/python@3.14/3.14.6/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python",
        "/opt/homebrew/bin/podman-compose",
        "up",
      ],
      cmdline:
        "/opt/homebrew/Cellar/python@3.14/3.14.6/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python /opt/homebrew/bin/podman-compose up",
      cwd: "/Users/okonomi/src/github.com/okonomi/herdr-auto-tab-name",
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
