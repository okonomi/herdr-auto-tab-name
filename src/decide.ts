import type { Foreground, TabMode, TabState } from "./types.js";

/** herdr が既定で付けるタブ名(タブ番号)かどうか。 */
export function isDefaultLabel(label: string): boolean {
  return /^\d+$/.test(label);
}

/**
 * タブが自動命名の対象かを決める。
 *
 * 自分が最後に付けた名前がそのまま残っていれば自動モードを続ける。
 * それ以外は、番号なら自動モード(手動固定の解除もこれで効く)、
 * 番号以外ならユーザーが付けた名前とみなして手動固定にする。
 */
export function nextMode(label: string, stored: TabState | undefined): TabMode {
  if (stored?.mode === "auto" && stored.lastSetLabel !== null && label === stored.lastSetLabel) {
    return "auto";
  }
  return isDefaultLabel(label) ? "auto" : "manual";
}

/**
 * 次に付けるタブ名を決める。null は「何もしない」を意味する。
 *
 * アイドルのときに直前のコマンド名を残すのは、短時間で終わるコマンドで
 * タブ名が番号との間を往復してちらつくのを避けるため。
 */
export function nextLabel(
  foreground: Foreground,
  stored: TabState | undefined,
): string | null {
  if (foreground.kind === "running") return foreground.command;
  return stored?.lastCommand ?? null;
}
