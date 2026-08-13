import { describe, expect, it } from "vitest";
import { resolveForeground } from "../src/namer.js";
import {
  idleFish,
  runningClaude,
  runningClaudeWithCaffeinate,
} from "./fixtures/process-info.js";
import type { PaneProcessInfo } from "../src/types.js";

describe("resolveForeground", () => {
  it("シェル自身がフォアグラウンドならアイドルとみなす", () => {
    expect(resolveForeground(idleFish)).toEqual({ kind: "idle" });
  });

  it("実行中のコマンドは argv0 で表す", () => {
    expect(resolveForeground(runningClaude)).toEqual({
      kind: "running",
      command: "claude",
    });
  });

  it("入れ子のときはプロセスグループのリーダーを採る", () => {
    expect(resolveForeground(runningClaudeWithCaffeinate)).toEqual({
      kind: "running",
      command: "claude",
    });
  });

  it("プロセスグループのリーダーが見つからなければ末尾を採る", () => {
    const info: PaneProcessInfo = {
      ...runningClaude,
      foreground_process_group_id: 99999,
    };
    expect(resolveForeground(info)).toEqual({
      kind: "running",
      command: "claude",
    });
  });

  it("argv0 の先頭のハイフンを落とす", () => {
    const info: PaneProcessInfo = {
      pane_id: "w1:p1",
      shell_pid: 100,
      foreground_process_group_id: 200,
      foreground_processes: [
        { pid: 200, name: "zsh", argv0: "-zsh", argv: ["-zsh"], cmdline: "-zsh", cwd: "/" },
      ],
    };
    expect(resolveForeground(info)).toEqual({ kind: "running", command: "zsh" });
  });

  it("argv0 が絶対パスならベース名にする", () => {
    const info: PaneProcessInfo = {
      pane_id: "w1:p1",
      shell_pid: 100,
      foreground_process_group_id: 200,
      foreground_processes: [
        {
          pid: 200,
          name: "pytest",
          argv0: "/usr/local/bin/pytest",
          argv: ["/usr/local/bin/pytest", "-v"],
          cmdline: "/usr/local/bin/pytest -v",
          cwd: "/",
        },
      ],
    };
    expect(resolveForeground(info)).toEqual({ kind: "running", command: "pytest" });
  });

  it("フォアグラウンドプロセスが空ならアイドルとみなす", () => {
    const info: PaneProcessInfo = {
      pane_id: "w1:p1",
      shell_pid: 100,
      foreground_process_group_id: 100,
      foreground_processes: [],
    };
    expect(resolveForeground(info)).toEqual({ kind: "idle" });
  });
});
