import { describe, expect, it } from "vitest";
import { nextLabel, nextMode } from "../src/decide.js";
import type { TabState } from "../src/types.js";

const auto = (over: Partial<TabState> = {}): TabState => ({
  mode: "auto",
  lastCommand: null,
  lastSetLabel: null,
  ...over,
});

describe("nextMode", () => {
  it("未知のタブは既定の番号なら自動モードにする", () => {
    expect(nextMode("1", undefined)).toBe("auto");
    expect(nextMode("12", undefined)).toBe("auto");
  });

  it("未知のタブが番号以外の名前を持っていれば手動固定とみなす", () => {
    expect(nextMode("deploy", undefined)).toBe("manual");
  });

  it("自分が付けた名前のままなら自動モードを続ける", () => {
    expect(nextMode("claude", auto({ lastSetLabel: "claude" }))).toBe("auto");
  });

  it("自分が付けた名前と食い違えば手動リネームとみなす", () => {
    expect(nextMode("deploy", auto({ lastSetLabel: "claude" }))).toBe("manual");
  });

  it("まだ何も付けていない自動タブが番号以外になっていたら手動固定にする", () => {
    expect(nextMode("deploy", auto())).toBe("manual");
  });

  it("手動固定タブが番号に戻されたら自動モードに復帰する", () => {
    const manual: TabState = { mode: "manual", lastCommand: null, lastSetLabel: null };
    expect(nextMode("1", manual)).toBe("auto");
  });

  it("手動固定タブは名前が変わらないかぎり手動固定のまま", () => {
    const manual: TabState = { mode: "manual", lastCommand: null, lastSetLabel: null };
    expect(nextMode("deploy", manual)).toBe("manual");
  });
});

describe("nextLabel", () => {
  it("実行中のコマンド名をそのままタブ名にする", () => {
    expect(nextLabel({ kind: "running", command: "claude" }, auto())).toBe("claude");
  });

  it("アイドルなら直前のコマンド名を維持する", () => {
    expect(nextLabel({ kind: "idle" }, auto({ lastCommand: "pytest" }))).toBe("pytest");
  });

  it("アイドルで過去にコマンドが無ければ何もしない", () => {
    expect(nextLabel({ kind: "idle" }, auto())).toBeNull();
  });

  it("未知のタブでアイドルなら何もしない", () => {
    expect(nextLabel({ kind: "idle" }, undefined)).toBeNull();
  });
});
