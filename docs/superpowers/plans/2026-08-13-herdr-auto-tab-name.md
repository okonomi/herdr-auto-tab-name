# herdr-auto-tab-name Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** herdr のタブ名を、そのタブで実行中のフォアグラウンドコマンド名に自動追従させる herdr プラグインを作る。

**Architecture:** `[[startup]]` から起動される薄いランチャーが常駐デーモンを detached spawn する。デーモンは herdr の Unix socket に 1 秒ごとに `session.snapshot` と `pane.process_info` を投げ、純粋関数で決めたタブ名を `tab.rename` で反映する。ユーザーが手動で付けた名前は、snapshot の `label` と「自分が最後に付けた名前」の突き合わせで検知して保護する。

**Tech Stack:** TypeScript (ESM) / Node.js 20+ / vitest。ランタイム依存パッケージはゼロ(Node 標準の `node:net` `node:fs` `node:child_process` のみ使う)。

**Spec:** `docs/superpowers/specs/2026-08-13-herdr-auto-tab-name-design.md`

## Global Constraints

- プラグイン ID は `okonomi.auto-tab-name`。マニフェストの `min_herdr_version` は `"0.8.0"`
- socket のパスは環境変数 `HERDR_SOCKET_PATH` から取る。ハードコードしない
- socket プロトコルは改行区切り JSON。**1 リクエストにつき 1 接続**(サーバはレスポンス送出後に接続を閉じる)
- API メソッド名は `session.snapshot` / `pane.process_info` / `tab.rename` の 3 つだけを使う
- 成功レスポンスは `{"id":...,"result":{...}}`、失敗は `{"id":...,"error":{"code":"...","message":"..."}}`
- ポーリング間隔は 1000ms。snapshot の連続失敗が 30000ms 続いたらデーモンは終了する
- 状態の永続化先は `${HERDR_PLUGIN_STATE_DIR}/state.json`、pidfile は `${HERDR_PLUGIN_STATE_DIR}/daemon.pid`、ログは `${HERDR_PLUGIN_STATE_DIR}/daemon.log`
- ランタイム依存パッケージを追加しない。devDependencies は `typescript` / `vitest` / `@types/node` のみ
- 実行中コマンド名は `argv0` から導く。`name` フィールドは使わない(claude はプロセス名がバージョン文字列になるため)

---

### Task 1: `[[startup]]` の実挙動をスパイクで確認する

herdr のドキュメントは `[[startup]]` を「一回きりの初期化コマンド」と説明しており、常駐プロセスを直接置けるかは未検証。ランチャー方式はどちらの挙動でも壊れない設計だが、ログの出方と起動タイミングを実機で確かめておく。このタスクの成果物は動くコードではなく **記録された観測結果**。

**Files:**
- Create: `herdr-plugin.toml`
- Create: `spike/probe.sh`
- Create: `docs/superpowers/notes/2026-08-13-startup-hook-spike.md`

**Interfaces:**
- Consumes: なし
- Produces: 後続タスクが前提にする観測事実 — startup hook が子プロセスを待ち合わせるか、セッション終了時に kill するか、いつ発火するか

- [ ] **Step 1: 最小構成のマニフェストを作る**

`herdr-plugin.toml`:

```toml
id = "okonomi.auto-tab-name"
name = "Auto Tab Name"
version = "0.0.1"
min_herdr_version = "0.8.0"
description = "Rename herdr tabs to the foreground command running in them"
platforms = ["macos", "linux"]

[[startup]]
command = ["sh", "spike/probe.sh"]
```

- [ ] **Step 2: 常駐するプローブスクリプトを書く**

`spike/probe.sh`:

```sh
#!/bin/sh
# startup hook の挙動を観測する。10 分間、5 秒ごとに生存を記録する。
LOG="${HERDR_PLUGIN_STATE_DIR}/probe.log"
echo "$(date +%T) started pid=$$ event=${HERDR_PLUGIN_EVENT} socket=${HERDR_SOCKET_PATH}" >>"$LOG"
i=0
while [ "$i" -lt 120 ]; do
  sleep 5
  i=$((i + 1))
  echo "$(date +%T) alive pid=$$ tick=$i" >>"$LOG"
done
echo "$(date +%T) finished pid=$$" >>"$LOG"
```

- [ ] **Step 3: プラグインを link する**

```bash
herdr plugin link /Users/okonomi/src/github.com/okonomi/herdr-auto-tab-name
herdr plugin list
```

Expected: `okonomi.auto-tab-name` が enabled として一覧に出る。

- [ ] **Step 4: startup hook を発火させてログを観測する**

startup hook は「セッション復元後」に走るため、link しただけでは発火しない可能性がある。サーバを再起動して確かめる。

```bash
herdr server stop
# herdr を起動し直したうえで、別ペインから:
cat "$(herdr plugin config-dir okonomi.auto-tab-name)/../state/probe.log" 2>/dev/null \
  || find ~/.config/herdr ~/.local/share/herdr -name probe.log 2>/dev/null
```

Expected: `started pid=... event=startup` の行があり、そのあと `alive` の行が 5 秒ごとに増えていく。

- [ ] **Step 5: 3 つの問いに答えて記録する**

`docs/superpowers/notes/2026-08-13-startup-hook-spike.md` に、以下を観測結果として書く。

1. **startup hook はいつ発火したか** — link 直後か、サーバ再起動後か
2. **子プロセスは待ち合わされるか** — `alive` の行が増え続けたなら待ち合わされていない(=常駐できる)。`started` の直後に herdr の起動が固まったなら待ち合わされている
3. **セッション終了時に kill されるか** — `herdr server stop` の後も `alive` が増え続けるかを確認する
4. **`HERDR_PLUGIN_STATE_DIR` の実パス** — 後続タスクで state.json / pidfile / ログを置く場所

いずれの結果でもランチャー方式(Task 10)は成立する。結果は設計変更ではなく、README に書く注意書きと、デーモンの寿命に対する期待値の根拠になる。

- [ ] **Step 6: プローブを片付けて commit する**

```bash
herdr plugin unlink okonomi.auto-tab-name
git add herdr-plugin.toml spike/probe.sh docs/superpowers/notes/2026-08-13-startup-hook-spike.md
git commit -m "spike: startup hook の実挙動を観測して記録する"
```

---

### Task 2: プロジェクト初期化と代表プロセスの決定

ペイン 1 つ分のプロセス情報から「アイドルか、実行中か。実行中なら何のコマンドか」を決める純粋関数を作る。ここがプラグイン全体の中核ロジック。

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/types.ts`
- Create: `src/namer.ts`
- Test: `tests/fixtures/process-info.ts`
- Test: `tests/namer.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `type HerdrProcess = { pid: number; name: string; argv0: string; argv: string[]; cmdline: string; cwd: string }`
  - `type PaneProcessInfo = { pane_id: string; shell_pid: number; foreground_process_group_id: number; foreground_processes: HerdrProcess[] }`
  - `type Foreground = { kind: "idle" } | { kind: "running"; command: string }`
  - `resolveForeground(info: PaneProcessInfo): Foreground`

- [ ] **Step 1: プロジェクトの土台を作る**

`package.json`:

```json
{
  "name": "herdr-auto-tab-name",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "outDir": "dist",
    "rootDir": "src",
    "sourceMap": true
  },
  "include": ["src"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
```

`.gitignore`:

```
node_modules/
dist/
```

インストールする:

```bash
npm install
```

- [ ] **Step 2: 型定義を書く**

`src/types.ts`:

```ts
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
```

- [ ] **Step 3: 実セッションから採ったフィクスチャを用意する**

`tests/fixtures/process-info.ts`(実際の herdr セッションから採取した生データ):

```ts
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
```

- [ ] **Step 4: 失敗するテストを書く**

`tests/namer.test.ts`:

```ts
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
```

- [ ] **Step 5: テストが落ちることを確認する**

Run: `npx vitest run tests/namer.test.ts`
Expected: FAIL — `Failed to resolve import "../src/namer.js"`

- [ ] **Step 6: 最小の実装を書く**

`src/namer.ts`:

```ts
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
```

- [ ] **Step 7: テストが通ることを確認する**

Run: `npx vitest run tests/namer.test.ts`
Expected: PASS(7 tests)

- [ ] **Step 8: commit する**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/types.ts src/namer.ts tests/
git commit -m "feat: ペインのフォアグラウンド状態を決める resolveForeground を追加"
```

---

### Task 3: 代表ペインの決定

1 タブに複数ペインがあるときに、どのペインをタブ名の根拠にするかを決める。実行中のペインを優先し、複数あれば `pane_id` の数値順で最初のもの。

**Files:**
- Modify: `src/namer.ts`
- Test: `tests/namer.test.ts`

**Interfaces:**
- Consumes: `resolveForeground(info: PaneProcessInfo): Foreground`(Task 2)
- Produces:
  - `comparePaneId(a: string, b: string): number`
  - `resolveTabForeground(infos: PaneProcessInfo[]): Foreground`

- [ ] **Step 1: 失敗するテストを書く**

`tests/namer.test.ts` の末尾に追記する:

```ts
import { comparePaneId, resolveTabForeground } from "../src/namer.js";

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
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `npx vitest run tests/namer.test.ts`
Expected: FAIL — `comparePaneId is not a function`

- [ ] **Step 3: 実装を書く**

`src/namer.ts` の末尾に追記する:

```ts
/**
 * pane_id を並び順として比較する。"wA:p10" の末尾の数値で比べるため、
 * 単純な文字列比較で p10 が p2 より前に来る問題を避ける。
 */
export function comparePaneId(a: string, b: string): number {
  const numberOf = (id: string): number | null => {
    const match = /(\d+)$/.exec(id);
    return match ? Number(match[1]) : null;
  };
  const na = numberOf(a);
  const nb = numberOf(b);
  if (na !== null && nb !== null) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * タブのフォアグラウンド状態を決める。実行中のペインを優先し、
 * 複数あれば pane_id の若い方を代表とする。
 */
export function resolveTabForeground(infos: PaneProcessInfo[]): Foreground {
  const running = infos
    .map((info) => ({ info, foreground: resolveForeground(info) }))
    .filter(
      (entry): entry is { info: PaneProcessInfo; foreground: { kind: "running"; command: string } } =>
        entry.foreground.kind === "running",
    )
    .sort((x, y) => comparePaneId(x.info.pane_id, y.info.pane_id));

  const first = running[0];
  return first ? first.foreground : { kind: "idle" };
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npx vitest run tests/namer.test.ts`
Expected: PASS(13 tests)

- [ ] **Step 5: commit する**

```bash
git add src/namer.ts tests/namer.test.ts
git commit -m "feat: タブの代表ペインを決める resolveTabForeground を追加"
```

---

### Task 4: タブ名とモードの決定

タブの状態(自動 / 手動固定)と、次に付けるべきタブ名を決める純粋関数。仕様の中で一番判断が多い部分。

**Files:**
- Modify: `src/types.ts`
- Create: `src/decide.ts`
- Test: `tests/decide.test.ts`

**Interfaces:**
- Consumes: `Foreground`(Task 2)
- Produces:
  - `type TabMode = "auto" | "manual"`
  - `type TabState = { mode: TabMode; lastCommand: string | null; lastSetLabel: string | null }`
  - `nextMode(label: string, stored: TabState | undefined): TabMode`
  - `nextLabel(foreground: Foreground, stored: TabState | undefined): string | null`

- [ ] **Step 1: 型を追加する**

`src/types.ts` の末尾に追記する:

```ts
export type TabMode = "auto" | "manual";

export type TabState = {
  mode: TabMode;
  /** 直近に観測した実行中コマンド名。アイドルになっても保持する。 */
  lastCommand: string | null;
  /** このプラグインが最後に設定したタブ名。手動リネームの検知に使う。 */
  lastSetLabel: string | null;
};
```

- [ ] **Step 2: 失敗するテストを書く**

`tests/decide.test.ts`:

```ts
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
```

- [ ] **Step 3: テストが落ちることを確認する**

Run: `npx vitest run tests/decide.test.ts`
Expected: FAIL — `Failed to resolve import "../src/decide.js"`

- [ ] **Step 4: 実装を書く**

`src/decide.ts`:

```ts
import type { Foreground, TabMode, TabState } from "./types.js";

/** herdr が既定で付けるタブ名(タブ番号)かどうか。 */
function isDefaultLabel(label: string): boolean {
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
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `npx vitest run tests/decide.test.ts`
Expected: PASS(11 tests)

- [ ] **Step 6: commit する**

```bash
git add src/types.ts src/decide.ts tests/decide.test.ts
git commit -m "feat: タブのモードと次のタブ名を決める純粋関数を追加"
```

---

### Task 5: StateStore

タブごとの状態を保持し、`state.json` に永続化する。永続化が必要なのは、herdr 再起動後の初回スキャンで、前回自分が付けた `claude` というタブ名を「番号ではない = 手動固定」と誤判定しないため。

**Files:**
- Create: `src/state.ts`
- Test: `tests/state.test.ts`

**Interfaces:**
- Consumes: `TabState`(Task 4)
- Produces:
  - `class StateStore`
  - `StateStore.load(filePath: string): Promise<StateStore>`
  - `get(tabId: string): TabState | undefined`
  - `set(tabId: string, state: TabState): void`
  - `prune(liveTabIds: Iterable<string>): void`
  - `save(): Promise<void>`

- [ ] **Step 1: 失敗するテストを書く**

`tests/state.test.ts`:

```ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/state.js";
import type { TabState } from "../src/types.js";

const claudeState: TabState = {
  mode: "auto",
  lastCommand: "claude",
  lastSetLabel: "claude",
};

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-auto-tab-name-"));
  return join(dir, "state.json");
}

describe("StateStore", () => {
  it("ファイルが無ければ空の状態から始まる", async () => {
    const store = await StateStore.load(await tempFile());
    expect(store.get("w1:t1")).toBeUndefined();
  });

  it("保存した状態を読み直せる", async () => {
    const path = await tempFile();
    const store = await StateStore.load(path);
    store.set("w1:t1", claudeState);
    await store.save();

    const reloaded = await StateStore.load(path);
    expect(reloaded.get("w1:t1")).toEqual(claudeState);
  });

  it("壊れた JSON は空の状態として扱う", async () => {
    const path = await tempFile();
    await writeFile(path, "{ this is not json", "utf8");
    const store = await StateStore.load(path);
    expect(store.get("w1:t1")).toBeUndefined();
  });

  it("生きていないタブの状態を捨てる", async () => {
    const store = await StateStore.load(await tempFile());
    store.set("w1:t1", claudeState);
    store.set("w1:t2", claudeState);
    store.prune(["w1:t1"]);
    expect(store.get("w1:t1")).toEqual(claudeState);
    expect(store.get("w1:t2")).toBeUndefined();
  });

  it("保存先のディレクトリが無ければ作る", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-auto-tab-name-"));
    const path = join(dir, "nested", "state.json");
    const store = await StateStore.load(path);
    store.set("w1:t1", claudeState);
    await store.save();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ "w1:t1": claudeState });
  });
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `npx vitest run tests/state.test.ts`
Expected: FAIL — `Failed to resolve import "../src/state.js"`

- [ ] **Step 3: 実装を書く**

`src/state.ts`:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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

  async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const record = Object.fromEntries(this.states);
    await writeFile(this.filePath, JSON.stringify(record, null, 2), "utf8");
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
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npx vitest run tests/state.test.ts`
Expected: PASS(5 tests)

- [ ] **Step 5: commit する**

```bash
git add src/state.ts tests/state.test.ts
git commit -m "feat: タブ状態を永続化する StateStore を追加"
```

---

### Task 6: SocketClient と HerdrApi

herdr の Unix socket と喋る層。サーバはレスポンスを返すと接続を閉じるため、リクエストごとに接続を張り直す。上位にはその都合を見せない。

**Files:**
- Modify: `src/types.ts`
- Create: `src/socket.ts`
- Create: `src/api.ts`
- Test: `tests/socket.test.ts`

**Interfaces:**
- Consumes: `PaneProcessInfo`(Task 2)
- Produces:
  - `type SnapshotTab = { tab_id: string; workspace_id: string; number: number; label: string; focused: boolean; pane_count: number; agent_status: string }`
  - `type SnapshotPane = { pane_id: string; tab_id: string; workspace_id: string }`
  - `type Snapshot = { tabs: SnapshotTab[]; panes: SnapshotPane[] }`
  - `class HerdrApiError extends Error { readonly code: string }`
  - `class SocketClient { constructor(socketPath: string); request<T>(method: string, params: Record<string, unknown>): Promise<T> }`
  - `interface HerdrApi { snapshot(): Promise<Snapshot>; processInfo(paneId: string): Promise<PaneProcessInfo>; rename(tabId: string, label: string): Promise<void> }`
  - `class SocketHerdrApi implements HerdrApi { constructor(client: SocketClient) }`

- [ ] **Step 1: snapshot 関連の型を追加する**

`src/types.ts` の末尾に追記する:

```ts
export type SnapshotTab = {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  agent_status: string;
};

export type SnapshotPane = {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
};

export type Snapshot = {
  tabs: SnapshotTab[];
  panes: SnapshotPane[];
};
```

- [ ] **Step 2: 失敗するテストを書く**

`tests/socket.test.ts`:

```ts
import { createServer, type Server } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HerdrApiError, SocketClient } from "../src/socket.js";

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

/**
 * herdr サーバを模したソケット。1 行受け取ったらレスポンスを 1 行返し、
 * 実物と同じように接続を閉じる。
 */
async function startFakeServer(
  handler: (request: { id: string; method: string; params: unknown }) => unknown,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-sock-"));
  const path = join(dir, "test.sock");
  server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline));
      socket.end(JSON.stringify(handler(request)) + "\n");
    });
  });
  await new Promise<void>((resolve) => server!.listen(path, resolve));
  return path;
}

describe("SocketClient", () => {
  it("リクエストを送って result を受け取る", async () => {
    const path = await startFakeServer((req) => ({
      id: req.id,
      result: { type: "pane_process_info", echo: req.params },
    }));
    const client = new SocketClient(path);
    await expect(
      client.request("pane.process_info", { pane_id: "w1:p1" }),
    ).resolves.toEqual({ type: "pane_process_info", echo: { pane_id: "w1:p1" } });
  });

  it("接続ごとに独立してリクエストできる(サーバが接続を閉じても次が通る)", async () => {
    const path = await startFakeServer((req) => ({ id: req.id, result: { method: req.method } }));
    const client = new SocketClient(path);
    await expect(client.request("session.snapshot", {})).resolves.toEqual({
      method: "session.snapshot",
    });
    await expect(client.request("tab.rename", {})).resolves.toEqual({
      method: "tab.rename",
    });
  });

  it("error レスポンスは HerdrApiError にする", async () => {
    const path = await startFakeServer((req) => ({
      id: req.id,
      error: { code: "tab_not_found", message: "tab zz:t9 not found" },
    }));
    const client = new SocketClient(path);
    await expect(client.request("tab.rename", {})).rejects.toThrow(HerdrApiError);
    await expect(client.request("tab.rename", {})).rejects.toMatchObject({
      code: "tab_not_found",
    });
  });

  it("サーバが居なければ reject する", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-sock-"));
    const client = new SocketClient(join(dir, "missing.sock"));
    await expect(client.request("session.snapshot", {})).rejects.toThrow();
  });
});
```

- [ ] **Step 3: テストが落ちることを確認する**

Run: `npx vitest run tests/socket.test.ts`
Expected: FAIL — `Failed to resolve import "../src/socket.js"`

- [ ] **Step 4: SocketClient を実装する**

`src/socket.ts`:

```ts
import { createConnection } from "node:net";

export class HerdrApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "HerdrApiError";
  }
}

type Response = {
  id?: string;
  result?: unknown;
  error?: { code: string; message: string };
};

/**
 * herdr の Unix socket クライアント。
 *
 * herdr のサーバはレスポンスを 1 行返すと接続を閉じるので、リクエストごとに
 * 接続を張り直す。常時接続を持たないぶん、サーバの再起動をまたいでも
 * 再接続処理は要らない。
 */
export class SocketClient {
  private counter = 0;

  constructor(private readonly socketPath: string) {}

  request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = `auto-tab-name:${++this.counter}`;
    return new Promise<T>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let buffer = "";
      let settled = false;

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error);
      };

      socket.on("error", fail);
      socket.on("close", () => fail(new Error(`${method}: connection closed without a response`)));

      socket.on("connect", () => {
        socket.write(JSON.stringify({ id, method, params }) + "\n");
      });

      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;

        let response: Response;
        try {
          response = JSON.parse(buffer.slice(0, newline)) as Response;
        } catch (cause) {
          fail(new Error(`${method}: malformed response`, { cause }));
          return;
        }

        if (settled) return;
        settled = true;
        socket.end();

        if (response.error) {
          reject(new HerdrApiError(response.error.code, response.error.message));
        } else {
          resolve(response.result as T);
        }
      });
    });
  }
}
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `npx vitest run tests/socket.test.ts`
Expected: PASS(4 tests)

- [ ] **Step 6: HerdrApi を実装する**

`src/api.ts`:

```ts
import type { PaneProcessInfo, Snapshot } from "./types.js";
import type { SocketClient } from "./socket.js";

/** Poller が必要とする herdr 操作だけを切り出したインターフェース。テストでは偽物に差し替える。 */
export interface HerdrApi {
  snapshot(): Promise<Snapshot>;
  processInfo(paneId: string): Promise<PaneProcessInfo>;
  rename(tabId: string, label: string): Promise<void>;
}

export class SocketHerdrApi implements HerdrApi {
  constructor(private readonly client: SocketClient) {}

  async snapshot(): Promise<Snapshot> {
    const result = await this.client.request<{ snapshot: Snapshot }>("session.snapshot", {});
    return result.snapshot;
  }

  async processInfo(paneId: string): Promise<PaneProcessInfo> {
    const result = await this.client.request<{ process_info: PaneProcessInfo }>(
      "pane.process_info",
      { pane_id: paneId },
    );
    return result.process_info;
  }

  async rename(tabId: string, label: string): Promise<void> {
    await this.client.request("tab.rename", { tab_id: tabId, label });
  }
}
```

- [ ] **Step 7: 型検査が通ることを確認する**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 8: commit する**

```bash
git add src/types.ts src/socket.ts src/api.ts tests/socket.test.ts
git commit -m "feat: herdr socket クライアントと API ラッパーを追加"
```

---

### Task 7: Poller の 1 周回

snapshot を取り、モードを判定し、自動モードのタブのペインだけ `pane.process_info` を取り、名前が変わるタブだけ rename する。ここまでのユニットを組み合わせる唯一の場所。

**Files:**
- Create: `src/poller.ts`
- Test: `tests/poller.test.ts`

**Interfaces:**
- Consumes: `HerdrApi`(Task 6)、`StateStore`(Task 5)、`nextMode` / `nextLabel`(Task 4)、`resolveTabForeground`(Task 3)
- Produces: `runCycle(api: HerdrApi, store: StateStore, log: (message: string) => void): Promise<void>`

- [ ] **Step 1: 失敗するテストを書く**

`tests/poller.test.ts`:

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCycle } from "../src/poller.js";
import { StateStore } from "../src/state.js";
import type { HerdrApi } from "../src/api.js";
import type { PaneProcessInfo, Snapshot, SnapshotPane, SnapshotTab } from "../src/types.js";
import { idleFish, runningClaude } from "./fixtures/process-info.js";

const tab = (over: Partial<SnapshotTab> & { tab_id: string }): SnapshotTab => ({
  workspace_id: "w1",
  number: 1,
  label: "1",
  focused: false,
  pane_count: 1,
  agent_status: "unknown",
  ...over,
});

const pane = (paneId: string, tabId: string): SnapshotPane => ({
  pane_id: paneId,
  tab_id: tabId,
  workspace_id: "w1",
});

function fakeApi(
  snapshot: Snapshot,
  processInfos: Record<string, PaneProcessInfo>,
): HerdrApi & { renames: Array<[string, string]> } {
  const renames: Array<[string, string]> = [];
  return {
    renames,
    snapshot: async () => snapshot,
    processInfo: async (paneId) => {
      const info = processInfos[paneId];
      if (!info) throw new Error(`no fixture for ${paneId}`);
      return info;
    },
    rename: async (tabId, label) => {
      renames.push([tabId, label]);
    },
  };
}

async function emptyStore(): Promise<StateStore> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-poller-"));
  return StateStore.load(join(dir, "state.json"));
}

const noop = (): void => {};

describe("runCycle", () => {
  it("実行中のコマンド名でタブをリネームする", async () => {
    const api = fakeApi(
      { tabs: [tab({ tab_id: "w1:t1" })], panes: [pane("w1:p1", "w1:t1")] },
      { "w1:p1": runningClaude },
    );
    const store = await emptyStore();

    await runCycle(api, store, noop);

    expect(api.renames).toEqual([["w1:t1", "claude"]]);
    expect(store.get("w1:t1")).toEqual({
      mode: "auto",
      lastCommand: "claude",
      lastSetLabel: "claude",
    });
  });

  it("名前が変わらないなら rename を投げない", async () => {
    const api = fakeApi(
      { tabs: [tab({ tab_id: "w1:t1", label: "claude" })], panes: [pane("w1:p1", "w1:t1")] },
      { "w1:p1": runningClaude },
    );
    const store = await emptyStore();
    store.set("w1:t1", { mode: "auto", lastCommand: "claude", lastSetLabel: "claude" });

    await runCycle(api, store, noop);

    expect(api.renames).toEqual([]);
  });

  it("手動固定のタブは process_info すら取りに行かない", async () => {
    const api = fakeApi(
      { tabs: [tab({ tab_id: "w1:t1", label: "deploy" })], panes: [pane("w1:p1", "w1:t1")] },
      { "w1:p1": runningClaude },
    );
    const spy = vi.spyOn(api, "processInfo");
    const store = await emptyStore();

    await runCycle(api, store, noop);

    expect(spy).not.toHaveBeenCalled();
    expect(api.renames).toEqual([]);
    expect(store.get("w1:t1")?.mode).toBe("manual");
  });

  it("ユーザーが手動リネームしたら手動固定に切り替える", async () => {
    const api = fakeApi(
      { tabs: [tab({ tab_id: "w1:t1", label: "deploy" })], panes: [pane("w1:p1", "w1:t1")] },
      { "w1:p1": runningClaude },
    );
    const store = await emptyStore();
    store.set("w1:t1", { mode: "auto", lastCommand: "claude", lastSetLabel: "claude" });

    await runCycle(api, store, noop);

    expect(api.renames).toEqual([]);
    expect(store.get("w1:t1")?.mode).toBe("manual");
  });

  it("アイドルになっても直前のコマンド名を保つ", async () => {
    const api = fakeApi(
      { tabs: [tab({ tab_id: "w1:t1", label: "claude" })], panes: [pane("w1:p1", "w1:t1")] },
      { "w1:p1": idleFish },
    );
    const store = await emptyStore();
    store.set("w1:t1", { mode: "auto", lastCommand: "claude", lastSetLabel: "claude" });

    await runCycle(api, store, noop);

    expect(api.renames).toEqual([]);
    expect(store.get("w1:t1")?.lastCommand).toBe("claude");
  });

  it("ペインの process_info が失敗してもそのタブを飛ばして続ける", async () => {
    const api = fakeApi(
      {
        tabs: [tab({ tab_id: "w1:t1" }), tab({ tab_id: "w1:t2", number: 2, label: "2" })],
        panes: [pane("w1:p1", "w1:t1"), pane("w1:p2", "w1:t2")],
      },
      { "w1:p2": runningClaude },
    );
    const store = await emptyStore();

    await runCycle(api, store, noop);

    expect(api.renames).toEqual([["w1:t2", "claude"]]);
  });

  it("rename が失敗しても例外を投げない", async () => {
    const api = fakeApi(
      { tabs: [tab({ tab_id: "w1:t1" })], panes: [pane("w1:p1", "w1:t1")] },
      { "w1:p1": runningClaude },
    );
    api.rename = async () => {
      throw new Error("tab_not_found");
    };
    const store = await emptyStore();

    await expect(runCycle(api, store, noop)).resolves.toBeUndefined();
    expect(store.get("w1:t1")?.lastSetLabel).toBeNull();
  });

  it("消えたタブの状態を捨てる", async () => {
    const api = fakeApi(
      { tabs: [tab({ tab_id: "w1:t1", label: "claude" })], panes: [pane("w1:p1", "w1:t1")] },
      { "w1:p1": runningClaude },
    );
    const store = await emptyStore();
    store.set("w1:t9", { mode: "auto", lastCommand: "vim", lastSetLabel: "vim" });

    await runCycle(api, store, noop);

    expect(store.get("w1:t9")).toBeUndefined();
  });
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `npx vitest run tests/poller.test.ts`
Expected: FAIL — `Failed to resolve import "../src/poller.js"`

- [ ] **Step 3: 実装を書く**

`src/poller.ts`:

```ts
import type { HerdrApi } from "./api.js";
import { nextLabel, nextMode } from "./decide.js";
import { resolveTabForeground } from "./namer.js";
import type { StateStore } from "./state.js";
import type { PaneProcessInfo, TabState } from "./types.js";

/**
 * ポーリング 1 周回。snapshot を 1 回取り、自動モードのタブについてのみ
 * ペインのプロセス情報を集め、名前が変わるタブだけリネームする。
 *
 * 途中の失敗はタブ単位で握りつぶす。次の周回でやり直せるため、1 つのタブの
 * 失敗で周回全体を落とす価値がない。
 */
export async function runCycle(
  api: HerdrApi,
  store: StateStore,
  log: (message: string) => void,
): Promise<void> {
  const snapshot = await api.snapshot();

  const panesByTab = new Map<string, string[]>();
  for (const pane of snapshot.panes) {
    const panes = panesByTab.get(pane.tab_id);
    if (panes) panes.push(pane.pane_id);
    else panesByTab.set(pane.tab_id, [pane.pane_id]);
  }

  for (const tab of snapshot.tabs) {
    const stored = store.get(tab.tab_id);
    const mode = nextMode(tab.label, stored);

    const state: TabState = {
      mode,
      lastCommand: stored?.lastCommand ?? null,
      lastSetLabel: stored?.lastSetLabel ?? null,
    };

    if (mode === "manual") {
      store.set(tab.tab_id, state);
      continue;
    }

    const infos: PaneProcessInfo[] = [];
    for (const paneId of panesByTab.get(tab.tab_id) ?? []) {
      try {
        infos.push(await api.processInfo(paneId));
      } catch (error) {
        log(`pane.process_info failed for ${paneId}: ${String(error)}`);
      }
    }

    const foreground = resolveTabForeground(infos);
    if (foreground.kind === "running") state.lastCommand = foreground.command;

    const label = nextLabel(foreground, state);
    if (label !== null && label !== tab.label) {
      try {
        await api.rename(tab.tab_id, label);
        state.lastSetLabel = label;
      } catch (error) {
        log(`tab.rename failed for ${tab.tab_id}: ${String(error)}`);
      }
    }

    store.set(tab.tab_id, state);
  }

  store.prune(snapshot.tabs.map((tab) => tab.tab_id));
  await store.save();
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npx vitest run tests/poller.test.ts`
Expected: PASS(8 tests)

- [ ] **Step 5: 全テストと型検査を通す**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全 41 テスト PASS、型エラーなし

- [ ] **Step 6: commit する**

```bash
git add src/poller.ts tests/poller.test.ts
git commit -m "feat: ポーリング 1 周回を行う runCycle を追加"
```

---

### Task 8: デーモン本体

`runCycle` を 1 秒ごとに回す常駐プロセス。snapshot の連続失敗が 30 秒続いたら herdr server が落ちたとみなして自分も終わる。

**Files:**
- Create: `src/failure-tracker.ts`
- Create: `src/env.ts`
- Create: `src/daemon.ts`
- Test: `tests/failure-tracker.test.ts`

**Interfaces:**
- Consumes: `runCycle`(Task 7)、`StateStore`(Task 5)、`SocketClient` / `SocketHerdrApi`(Task 6)
- Produces:
  - `class FailureTracker { constructor(limitMs: number); recordSuccess(now: number): void; recordFailure(now: number): boolean }` — `recordFailure` は「もう諦めるべき」なら `true` を返す
  - `type PluginEnv = { socketPath: string; stateDir: string }`
  - `readPluginEnv(env: NodeJS.ProcessEnv): PluginEnv`
  - `statePath(stateDir: string): string` / `pidPath(stateDir: string): string` / `logPath(stateDir: string): string`

- [ ] **Step 1: 失敗するテストを書く**

`tests/failure-tracker.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FailureTracker } from "../src/failure-tracker.js";

describe("FailureTracker", () => {
  it("最初の失敗では諦めない", () => {
    const tracker = new FailureTracker(30_000);
    expect(tracker.recordFailure(1_000)).toBe(false);
  });

  it("失敗が制限時間を超えて続いたら諦める", () => {
    const tracker = new FailureTracker(30_000);
    expect(tracker.recordFailure(1_000)).toBe(false);
    expect(tracker.recordFailure(20_000)).toBe(false);
    expect(tracker.recordFailure(31_001)).toBe(true);
  });

  it("成功したら失敗の連続がリセットされる", () => {
    const tracker = new FailureTracker(30_000);
    tracker.recordFailure(1_000);
    tracker.recordSuccess(20_000);
    expect(tracker.recordFailure(40_000)).toBe(false);
    expect(tracker.recordFailure(60_000)).toBe(false);
  });

  it("ちょうど制限時間では諦めない", () => {
    const tracker = new FailureTracker(30_000);
    tracker.recordFailure(1_000);
    expect(tracker.recordFailure(31_000)).toBe(false);
  });
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `npx vitest run tests/failure-tracker.test.ts`
Expected: FAIL — `Failed to resolve import "../src/failure-tracker.js"`

- [ ] **Step 3: FailureTracker を実装する**

`src/failure-tracker.ts`:

```ts
/**
 * 連続失敗がどれだけ続いたかを追う。herdr server が落ちたときに
 * デーモンが永久に空回りするのを防ぐ。
 */
export class FailureTracker {
  private firstFailureAt: number | null = null;

  constructor(private readonly limitMs: number) {}

  recordSuccess(_now: number): void {
    this.firstFailureAt = null;
  }

  /** 諦めるべきなら true を返す。 */
  recordFailure(now: number): boolean {
    if (this.firstFailureAt === null) {
      this.firstFailureAt = now;
      return false;
    }
    return now - this.firstFailureAt > this.limitMs;
  }
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npx vitest run tests/failure-tracker.test.ts`
Expected: PASS(4 tests)

- [ ] **Step 5: 環境変数の読み取りを書く**

`src/env.ts`:

```ts
import { join } from "node:path";

export type PluginEnv = {
  socketPath: string;
  stateDir: string;
};

/** herdr がプラグインのコマンドに注入する環境変数を読む。欠けていたら起動を止める。 */
export function readPluginEnv(env: NodeJS.ProcessEnv): PluginEnv {
  const socketPath = env.HERDR_SOCKET_PATH;
  const stateDir = env.HERDR_PLUGIN_STATE_DIR;
  if (!socketPath) throw new Error("HERDR_SOCKET_PATH is not set");
  if (!stateDir) throw new Error("HERDR_PLUGIN_STATE_DIR is not set");
  return { socketPath, stateDir };
}

export const statePath = (stateDir: string): string => join(stateDir, "state.json");
export const pidPath = (stateDir: string): string => join(stateDir, "daemon.pid");
export const logPath = (stateDir: string): string => join(stateDir, "daemon.log");
```

- [ ] **Step 6: デーモン本体を書く**

`src/daemon.ts`:

```ts
import { appendFile, unlink } from "node:fs/promises";
import { SocketHerdrApi } from "./api.js";
import { logPath, pidPath, readPluginEnv, statePath } from "./env.js";
import { FailureTracker } from "./failure-tracker.js";
import { runCycle } from "./poller.js";
import { SocketClient } from "./socket.js";
import { StateStore } from "./state.js";

const POLL_INTERVAL_MS = 1_000;
const FAILURE_LIMIT_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const env = readPluginEnv(process.env);
  const file = logPath(env.stateDir);
  const log = (message: string): void => {
    void appendFile(file, `${new Date().toISOString()} ${message}\n`, "utf8").catch(() => {});
  };

  const api = new SocketHerdrApi(new SocketClient(env.socketPath));
  const store = await StateStore.load(statePath(env.stateDir));
  const failures = new FailureTracker(FAILURE_LIMIT_MS);

  let running = true;
  const stop = (signal: string): void => {
    log(`received ${signal}, shutting down`);
    running = false;
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  log(`daemon started pid=${process.pid} socket=${env.socketPath}`);

  while (running) {
    try {
      await runCycle(api, store, log);
      failures.recordSuccess(Date.now());
    } catch (error) {
      log(`cycle failed: ${String(error)}`);
      if (failures.recordFailure(Date.now())) {
        log("herdr server unreachable for too long, exiting");
        break;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  await unlink(pidPath(env.stateDir)).catch(() => {});
  log("daemon stopped");
}

main().catch((error: unknown) => {
  process.stderr.write(`auto-tab-name daemon failed to start: ${String(error)}\n`);
  process.exit(1);
});
```

- [ ] **Step 7: ビルドと全テストを通す**

Run: `npm run build && npx vitest run && npx tsc --noEmit`
Expected: `dist/daemon.js` が生成され、全 45 テスト PASS、型エラーなし

- [ ] **Step 8: commit する**

```bash
git add src/failure-tracker.ts src/env.ts src/daemon.ts tests/failure-tracker.test.ts
git commit -m "feat: ポーリングループを回すデーモン本体を追加"
```

---

### Task 9: ランチャーと pidfile

`[[startup]]` から呼ばれる薄い入口。既にデーモンが生きていれば何もせず、居なければ detached で起動して即座に終わる。startup hook が子プロセスを待ち合わせても、終了時に kill しても壊れないようにするための層。

**Files:**
- Create: `src/pidfile.ts`
- Create: `src/launcher.ts`
- Test: `tests/pidfile.test.ts`

**Interfaces:**
- Consumes: `pidPath` / `logPath` / `readPluginEnv`(Task 8)
- Produces:
  - `readPid(filePath: string): Promise<number | null>`
  - `writePid(filePath: string, pid: number): Promise<void>`
  - `isAlive(pid: number): boolean`

- [ ] **Step 1: 失敗するテストを書く**

`tests/pidfile.test.ts`:

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isAlive, readPid, writePid } from "../src/pidfile.js";

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-pid-"));
  return join(dir, "daemon.pid");
}

describe("pidfile", () => {
  it("ファイルが無ければ null", async () => {
    expect(await readPid(await tempPath())).toBeNull();
  });

  it("書いた pid を読み戻せる", async () => {
    const path = await tempPath();
    await writePid(path, 4242);
    expect(await readPid(path)).toBe(4242);
  });

  it("数値でない中身は null として扱う", async () => {
    const path = await tempPath();
    await writeFile(path, "not-a-pid", "utf8");
    expect(await readPid(path)).toBeNull();
  });

  it("自分自身のプロセスは生きている", () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  it("存在しない pid は生きていない", () => {
    expect(isAlive(2_147_483_646)).toBe(false);
  });
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `npx vitest run tests/pidfile.test.ts`
Expected: FAIL — `Failed to resolve import "../src/pidfile.js"`

- [ ] **Step 3: pidfile を実装する**

`src/pidfile.ts`:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readPid(filePath: string): Promise<number | null> {
  try {
    const raw = (await readFile(filePath, "utf8")).trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function writePid(filePath: string, pid: number): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${pid}\n`, "utf8");
}

/** シグナル 0 は実際には送られず、プロセスの存在確認だけを行う。 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npx vitest run tests/pidfile.test.ts`
Expected: PASS(5 tests)

- [ ] **Step 5: ランチャーを実装する**

`src/launcher.ts`:

```ts
import { spawn } from "node:child_process";
import { open, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { logPath, pidPath, readPluginEnv } from "./env.js";
import { isAlive, readPid, writePid } from "./pidfile.js";

/**
 * [[startup]] から呼ばれる入口。
 *
 * herdr の startup hook が子プロセスを待ち合わせるのか、セッション終了時に
 * kill するのかは herdr のバージョンに依存する。デーモンを detached で切り離し、
 * ランチャー自身は即座に終わることで、どちらの挙動でも成立させる。
 */
async function main(): Promise<void> {
  const env = readPluginEnv(process.env);
  const pidFile = pidPath(env.stateDir);

  const existing = await readPid(pidFile);
  if (existing !== null && isAlive(existing)) {
    process.stdout.write(`auto-tab-name daemon already running (pid ${existing})\n`);
    return;
  }

  await mkdir(env.stateDir, { recursive: true });
  const logFile = await open(logPath(env.stateDir), "a");

  const daemonPath = join(dirname(fileURLToPath(import.meta.url)), "daemon.js");
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: ["ignore", logFile.fd, logFile.fd],
    env: process.env,
  });
  child.unref();
  await logFile.close();

  if (child.pid === undefined) throw new Error("failed to spawn the daemon");
  await writePid(pidFile, child.pid);
  process.stdout.write(`auto-tab-name daemon started (pid ${child.pid})\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`auto-tab-name launcher failed: ${String(error)}\n`);
  process.exit(1);
});
```

- [ ] **Step 6: ビルドと全テストを通す**

Run: `npm run build && npx vitest run && npx tsc --noEmit`
Expected: `dist/launcher.js` と `dist/daemon.js` が生成され、全 50 テスト PASS、型エラーなし

- [ ] **Step 7: commit する**

```bash
git add src/pidfile.ts src/launcher.ts tests/pidfile.test.ts
git commit -m "feat: デーモンを detached 起動するランチャーを追加"
```

---

### Task 10: マニフェスト仕上げと実機での動作確認

プラグインとして成立させ、実際の herdr セッションで動くことを確認する。

**Files:**
- Modify: `herdr-plugin.toml`
- Create: `README.md`
- Delete: `spike/probe.sh`

**Interfaces:**
- Consumes: `dist/launcher.js`(Task 9)
- Produces: link して動くプラグイン

- [ ] **Step 1: マニフェストを仕上げる**

`herdr-plugin.toml` の内容を次に置き換える(Task 1 のスパイク用 `[[startup]]` を外し、ビルドを宣言する):

```toml
id = "okonomi.auto-tab-name"
name = "Auto Tab Name"
version = "0.1.0"
min_herdr_version = "0.8.0"
description = "Rename herdr tabs to the foreground command running in them"
platforms = ["macos", "linux"]

[[build]]
command = ["npm", "ci"]

[[build]]
command = ["npm", "run", "build"]

[[startup]]
command = ["node", "dist/launcher.js"]
```

スパイクの残骸を消す:

```bash
git rm spike/probe.sh
```

- [ ] **Step 2: ビルドして link する**

```bash
npm run build
herdr plugin link /Users/okonomi/src/github.com/okonomi/herdr-auto-tab-name
herdr plugin list
```

Expected: `okonomi.auto-tab-name` が enabled で出る。

- [ ] **Step 3: `prompt_new_tab_name` を無効にする**

`~/.config/herdr/config.toml` の `[ui]` セクションに追記する:

```toml
prompt_new_tab_name = false
```

反映する:

```bash
herdr server reload-config
```

- [ ] **Step 4: デーモンを起動して動作を確認する**

herdr を再起動して startup hook を発火させる。発火しない場合はランチャーを直接叩いて確かめる:

```bash
herdr plugin log list --plugin okonomi.auto-tab-name
cat "${HERDR_PLUGIN_STATE_DIR:-$(herdr plugin config-dir okonomi.auto-tab-name)}/daemon.log"
```

Expected: `daemon started pid=... socket=...` の行がある。

- [ ] **Step 5: 4 つの振る舞いを手で確認する**

1. **自動命名** — 新しいタブを開き、`sleep 60` を実行する。1〜2 秒でタブ名が `sleep` になる
2. **アイドル時の保持** — `sleep` の終了後もタブ名が `sleep` のまま残る
3. **入れ子の解決** — claude を起動したタブのタブ名が `caffeinate` ではなく `claude` になる
4. **手動リネームの保護** — `prefix+shift+t` でタブ名を `deploy` にしたあと `sleep 60` を実行しても、タブ名が `deploy` のまま変わらない。さらにタブ名を `1` に戻すと自動命名が再開する

- [ ] **Step 6: README を書く**

`README.md`:

````markdown
# herdr-auto-tab-name

herdr のタブ名を、そのタブで実行中のフォアグラウンドコマンド名に自動で追従させるプラグイン。

タブ名が `1` `2` という番号のままだとタブ行を見ても中身が分からない。このプラグインは
tmux の `automatic-rename` に相当する振る舞いを herdr にもたらす。

## 振る舞い

| タブの状態 | タブ名 |
| --- | --- |
| コマンド実行中 | そのコマンド名(例: `claude` / `vim` / `pytest`) |
| プロンプト待ち | 直前のコマンド名を保つ |
| 一度もコマンドを実行していない | herdr 既定の番号のまま |

手動で付けたタブ名は上書きしない。自動命名に戻したいときはタブ名を番号(`1` など)に
リネームする。

## インストール

```bash
herdr plugin install <このリポジトリ>
```

ローカルで開発する場合:

```bash
npm install && npm run build
herdr plugin link "$PWD"
```

## 必要な設定

`prompt_new_tab_name` が既定の `true` のままだと、タブ作成のたびに名前の入力を求められ、
入力した名前が「手動で付けた名前」と判定されて自動命名が効かない。
`~/.config/herdr/config.toml` に次を設定する。

```toml
[ui]
prompt_new_tab_name = false
```

反映するには `herdr server reload-config` を実行する。

## 仕組み

`[[startup]]` から起動される薄いランチャーが、常駐デーモンを detached で立ち上げる。
デーモンは herdr の Unix socket に 1 秒ごとに `session.snapshot` と `pane.process_info` を
投げ、タブ名が変わるときだけ `tab.rename` を発行する。

代表プロセスはプロセスグループのリーダーを採る。claude が `caffeinate` を起動したような
入れ子でも、リーダーである claude 側が選ばれる。

herdr にはフォアグラウンドプロセスの変化を通知するイベントが無いため、ポーリングしている。

## トラブルシューティング

デーモンのログはプラグインの state ディレクトリにある。

```bash
cat "$(herdr plugin config-dir okonomi.auto-tab-name)/../state/daemon.log"
```

`herdr plugin log list --plugin okonomi.auto-tab-name` で見えるのはランチャーの実行ログで、
デーモン本体の診断には上のファイルを見る。

## 開発

```bash
npm test        # vitest
npm run build   # tsc
```
````

- [ ] **Step 7: commit する**

```bash
git add herdr-plugin.toml README.md
git rm --cached spike/probe.sh 2>/dev/null || true
git commit -m "feat: プラグインマニフェストを仕上げて README を追加"
```

---

## Self-Review

**1. Spec coverage** — spec の各節を対応タスクに割り当てた。

| spec の要件 | タスク |
| --- | --- |
| 代表プロセスの決定(プロセスグループリーダー、shell_pid でアイドル判定、argv0 の正規化) | Task 2 |
| 代表ペインの決定(実行中優先、pane_id の数値順) | Task 3 |
| タブ名の決定(実行中 / アイドル保持 / 何もしない) | Task 4 |
| 自動モードと手動固定の判定、手動固定の解除 | Task 4, Task 7 |
| StateStore と state.json の永続化、閉じたタブの掃除 | Task 5, Task 7 |
| SocketClient(1接続1往復)と 3 つの API メソッド | Task 6 |
| 自動モードのタブだけポーリング、名前が変わるときだけ rename | Task 7 |
| API エラーの握りつぶし | Task 7 |
| 30 秒の連続失敗でデーモン終了 | Task 8 |
| ランチャーと pidfile による単一性 | Task 9 |
| `[[startup]]` の実挙動の確認 | Task 1 |
| ログの出力先 | Task 8, Task 10 |
| `prompt_new_tab_name` の案内 | Task 10 |

**2. Placeholder scan** — 「適切にエラー処理する」「後で実装」の類は無い。すべてのコードステップに実際のコードがある。

**3. Type consistency** — `Foreground` / `TabState` / `TabMode` / `PaneProcessInfo` / `Snapshot` / `SnapshotTab` / `SnapshotPane` / `HerdrApi` の定義箇所と使用箇所を照合済み。関数名は `resolveForeground` / `comparePaneId` / `resolveTabForeground` / `nextMode` / `nextLabel` / `runCycle` / `readPid` / `writePid` / `isAlive` / `readPluginEnv` / `statePath` / `pidPath` / `logPath` で全タスクを通して一貫している。
