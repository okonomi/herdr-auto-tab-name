import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TabState } from "./types.js";

/**
 * タブごとの状態を保持し、JSON ファイルに永続化する。
 *
 * tab_id は閉じたあと再利用されないため、生きているタブの一覧で prune すれば
 * 古いエントリが溜まり続けることはない。
 */
export class StateStore {
  private constructor(
    private readonly filePath: string,
    private readonly states: Map<string, TabState>,
  ) {}

  static async load(filePath: string): Promise<StateStore> {
    const states = new Map<string, TabState>();
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [tabId, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (isTabState(value)) states.set(tabId, value);
        }
      }
    } catch {
      // ファイルが無い、あるいは壊れている場合は空の状態から始める。
      // 状態は次の周回で観測し直せるので、失敗させる価値がない。
    }
    return new StateStore(filePath, states);
  }

  get(tabId: string): TabState | undefined {
    return this.states.get(tabId);
  }

  set(tabId: string, state: TabState): void {
    this.states.set(tabId, state);
  }

  prune(liveTabIds: Iterable<string>): void {
    const live = new Set(liveTabIds);
    for (const tabId of this.states.keys()) {
      if (!live.has(tabId)) this.states.delete(tabId);
    }
  }

  /**
   * 一時ファイルに書いてから rename で置き換える。デーモンが書き込み途中で
   * 落ちても、読み手が中途半端な JSON を掴むことがない。
   */
  async save(): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const record = Object.fromEntries(this.states);
    const tempPath = join(directory, `.state.${process.pid}.tmp`);
    await writeFile(tempPath, JSON.stringify(record, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, this.filePath);
  }
}

function isTabState(value: unknown): value is TabState {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    (v.mode === "auto" || v.mode === "manual") &&
    (typeof v.lastCommand === "string" || v.lastCommand === null) &&
    (typeof v.lastSetLabel === "string" || v.lastSetLabel === null)
  );
}
