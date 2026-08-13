import { describe, expect, it } from "vitest";
import { comparePaneId, resolveForeground, resolveTabForeground } from "../src/namer.js";
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

  it("foreground_processes が配列でない(欠けている)ならアイドルとみなす", () => {
    const info = {
      pane_id: "w1:p1",
      shell_pid: 100,
      foreground_process_group_id: 100,
      foreground_processes: undefined,
    } as unknown as PaneProcessInfo;
    expect(resolveForeground(info)).toEqual({ kind: "idle" });
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

describe("comparePaneId", () => {
  it("末尾の数値で比較する(文字列比較では p10 < p2 になってしまう)", () => {
    expect(comparePaneId("wA:p2", "wA:p10")).toBeLessThan(0);
    expect(comparePaneId("wA:p10", "wA:p2")).toBeGreaterThan(0);
    expect(comparePaneId("wA:p3", "wA:p3")).toBe(0);
  });

  it("数値が取れない場合は文字列として比較する", () => {
    expect(comparePaneId("wA:pX", "wA:pY")).toBeLessThan(0);
  });
});

describe("resolveTabForeground", () => {
  it("ペインが無ければアイドル", () => {
    expect(resolveTabForeground([])).toEqual({ kind: "idle" });
  });

  it("全ペインがアイドルならアイドル", () => {
    expect(resolveTabForeground([idleFish, { ...idleFish, pane_id: "w6:p2" }])).toEqual({
      kind: "idle",
    });
  });

  it("実行中のペインがあればそれを優先する", () => {
    expect(
      resolveTabForeground([idleFish, { ...runningClaude, pane_id: "w6:p2" }]),
    ).toEqual({ kind: "running", command: "claude" });
  });

  it("実行中が複数あれば pane_id の数値順で最初を採る", () => {
    const p10: PaneProcessInfo = { ...runningClaude, pane_id: "w6:p10" };
    const p2: PaneProcessInfo = {
      ...runningClaudeWithCaffeinate,
      pane_id: "w6:p2",
    };
    expect(resolveTabForeground([p10, p2])).toEqual({
      kind: "running",
      command: "claude",
    });

    const vim: PaneProcessInfo = {
      pane_id: "w6:p2",
      shell_pid: 100,
      foreground_process_group_id: 200,
      foreground_processes: [
        { pid: 200, name: "vim", argv0: "vim", argv: ["vim"], cmdline: "vim", cwd: "/" },
      ],
    };
    expect(resolveTabForeground([p10, vim])).toEqual({
      kind: "running",
      command: "vim",
    });
  });
});
