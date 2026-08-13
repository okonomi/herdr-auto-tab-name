# herdr-auto-tab-name 設計

herdr のタブ名を、そのタブで実行中のコマンド名に自動追従させる herdr プラグイン。

## 背景と目的

herdr のタブ名は既定で `1` `2` という番号のままで、タブ行を見てもそのタブで何が動いているか分からない。また `prompt_new_tab_name` が有効だとタブ作成のたびに名前の入力を求められて煩わしい。

このプラグインは、各タブのフォアグラウンドプロセスを監視し、実行中のコマンド名をタブ名として自動的に設定する。tmux の `automatic-rename` に相当する振る舞いを herdr にもたらす。

### スコープ外

- cwd / git ブランチ / エージェント種別を材料にした命名
- コマンドの引数を含む命名(`npm run dev` のような粒度)
- 複数ペインの内容を並べて集約する表示
- タブ名の装飾(アイコン・状態表示・桁揃え)

## 前提となる herdr の機能

herdr 0.8.0 で確認済みの事実。

### プラグイン機構

`herdr-plugin.toml` マニフェストを持つディレクトリを `herdr plugin link` / `herdr plugin install` で登録する。マニフェストは `[[startup]]` `[[actions]]` `[[events]]` `[[panes]]` `[[link_handlers]]` を宣言できる。

プラグインのコマンドには以下の環境変数が注入される。

- `HERDR_SOCKET_PATH` / `HERDR_BIN_PATH` / `HERDR_ENV=1`
- `HERDR_PLUGIN_ID` / `HERDR_PLUGIN_ROOT` / `HERDR_PLUGIN_CONFIG_DIR` / `HERDR_PLUGIN_STATE_DIR`
- `HERDR_PLUGIN_EVENT`(startup フックでは `startup`)/ `HERDR_PLUGIN_EVENT_JSON`

コマンドの作業ディレクトリはプラグインディレクトリ。stdin では何も渡らない。

### socket API

`~/.config/herdr/herdr.sock` に改行区切り JSON で喋る。リクエストは1接続1往復(サーバはレスポンス後に接続を閉じる)。

```json
{"id":"t1","method":"pane.process_info","params":{"pane_id":"w6:p1"}}
```

購読可能なイベントは 26 種あるが、**フォアグラウンドプロセスの変化を通知するイベントは存在しない**。したがってプロセス情報はいずれにせよポーリングで取得する必要がある。本プラグインはポーリングだけで完結させ、イベント購読は使わない(後述)。

### セッション snapshot

タブ構成(タブ一覧・現在の label・タブに属するペイン)はセッション snapshot を 1 リクエストで取得できる。`herdr api snapshot` 相当のメソッドで、`tabs` / `panes` / `workspaces` を含む。`panes[].tab_id` からタブとペインの対応が取れる。

### `pane.process_info`

命名の材料はこの 1 メソッドで足りる。

```json
{
  "pane_id": "wA:p1",
  "shell_pid": 49691,
  "foreground_process_group_id": 50005,
  "foreground_processes": [
    {"pid": 52075, "name": "caffeinate", "argv0": "caffeinate",
     "argv": ["caffeinate","-i","-t","300"], "cmdline": "caffeinate -i -t 300", "cwd": "..."},
    {"pid": 50005, "name": "2.1.231", "argv0": "claude",
     "argv": ["claude"], "cmdline": "claude", "cwd": "..."}
  ]
}
```

`name` は当てにならない(claude はプロセス名がバージョン文字列になる)。`argv0` を使う。

### `tab.rename`

`herdr tab rename <TAB_ID> <LABEL>` 相当のメソッドでタブ名を変更する。

## アーキテクチャ

成果物は herdr プラグイン 1 個。マニフェストと常駐デーモンからなる。

```
herdr-plugin.toml          [[startup]] でランチャーを起動
  └─ launcher              pidfile を見てデーモンを detached spawn し即 exit 0
       └─ daemon           常駐
            ├─ SocketClient  herdr socket との JSON 通信(リクエスト/レスポンスのみ)
            ├─ Poller        1 秒ごとに snapshot + process_info を取得し rename を発行
            ├─ Namer         プロセス情報 + タブ状態 → 次のタブ名(純粋関数)
            └─ StateStore    タブごとの状態、state.json へ永続化
```

実装言語は TypeScript / Node。

### 各ユニットの責務

**SocketClient** — `HERDR_SOCKET_PATH` への接続を担う。リクエストは接続・送信・1行受信・切断の 1 往復。上位には「リクエストを投げると結果が返る」というインターフェースだけを見せ、1接続1往復という herdr 側の都合を隠蔽する。

**Poller** — 1 秒間隔で 1 周回を実行する。まず snapshot を 1 回取得してタブ構成と現在の label を得る。次に自動モードのタブに属するペインについてのみ `pane.process_info` を取得する。取得したデータを Namer に渡し、結果が現在のタブ名と異なるときだけ `tab.rename` を発行する。

**Namer** — 純粋関数。プロセス情報と現在のタブ状態を受け取り、次のタブ名を返す。I/O を一切持たないため、テストの主戦場になる。

**StateStore** — タブごとに `{ mode, lastCommand, lastSetLabel }` を保持し、`HERDR_PLUGIN_STATE_DIR/state.json` に永続化する。

## 命名ルール

### 代表プロセスの決定(ペイン単位)

1. `foreground_processes` から `pid === foreground_process_group_id` のものを選ぶ。見つからなければ配列の末尾を使う
2. 選ばれたプロセスの `pid === shell_pid` なら、そのペインは**アイドル**(シェルのプロンプト待ち)
3. そうでなければ**実行中**。コマンド名は `argv0` の先頭の `-` を除去し basename 化したもの

このルールにより、`caffeinate` + `claude` の入れ子ではプロセスグループのリーダーである `claude` が選ばれ、ログインシェルの `-fish` はアイドルとして扱われる。シェル名のリストを持つ必要はない。

### 代表ペインの決定(タブ単位)

タブに属するペインのうち、実行中のものを優先する。実行中が複数あれば `pane_id` の昇順で最初のもの。`pane_id` は `wA:p1` のような形式なので、末尾の数値部分を数値として比較する(単純な文字列比較では `p10` が `p2` より前に来てしまう)。すべてアイドルならそのタブはアイドル。

### タブ名の決定

| タブの状態 | タブ名 |
| --- | --- |
| 実行中コマンドあり | その `argv0`(例: `claude` / `vim` / `pytest`) |
| 全ペインアイドル、過去にコマンドあり | 直前のコマンド名を維持する |
| 全ペインアイドル、過去にコマンドなし | 何もしない(herdr 既定の番号のまま) |

短時間で終わるコマンドも終了後に名前が残るため、番号との往復によるちらつきは起きない。

## 自動モードと手動固定

ユーザーが手動で付けたタブ名は上書きしない(tmux の `automatic-rename` と同じ振る舞い)。

### モードの判定

判定はすべてポーリング周回の中で行う。イベント購読は使わない。

- **未知のタブを初めて見たとき**(デーモン起動時の初回周回、およびタブ新規作成時): 状態が `state.json` に残っていればそれに従う。残っていなければ、タブ名が `^\d+$`(herdr 既定の番号)なら自動モード、それ以外なら手動固定とする
- **既知の自動モードのタブ**: snapshot の `label` を `lastSetLabel`(自分が最後に付けた名前)と突き合わせる。一致していれば自動モードを継続する。一致しなければユーザーによる手動リネームとみなし、そのタブを手動固定に切り替えて以後触らない

この突き合わせ方式は、イベント購読 + pending set によるエコー消し込みと同じ判定を、競合状態なしに実現する。自分の rename は発行時に `lastSetLabel` を更新するため次の周回で一致し、ユーザーの rename は一致しない。1 秒未満でリネームして元に戻した場合だけ取りこぼすが、実害はない。

### 手動固定の解除

タブ名を数字(例 `1`)に手動リネームすると自動モードに戻る。専用のプラグイン action は v1 では用意しない。

## ライフサイクルとエラー処理

### デーモンの起動と単一性

`[[startup]]` は一回きりの初期化コマンドとして設計されており、常駐プロセスを直接置けるかは未検証である。そのため startup コマンドには薄いランチャーを置く。

1. ランチャーは state dir の pidfile を読み、生きているデーモンがあれば何もせず exit 0
2. いなければデーモンを detached で spawn し(stdio はログファイルへ)、即 exit 0

これにより startup hook が子プロセスを待ち合わせても、あるいは終了時に kill しても、どちらの挙動でも壊れない。実装の最初のタスクとして、実機での挙動を確認する。

### 接続断

herdr server が停止・再起動すると socket への接続が失敗する。常時接続を持たないため再接続処理は不要で、次の周回でそのまま繋ぎ直る。ただし snapshot の取得失敗が 30 秒間続いた場合は herdr server が落ちたものとみなし、デーモン自身を終了してゾンビプロセスを残さない。

### API エラー

- `tab.rename` の失敗(タブが閉じられた直後など): ログに記録して無視する。次のポーリング周回で整合する
- `pane.process_info` の失敗: そのペインをその周回だけスキップする

### 状態の永続化

状態をメモリだけに持つと、herdr 再起動後の初期スキャンで、前回自動命名した `claude` というタブ名を見て「数字ではない = 手動固定」と誤判定する。これを避けるため `HERDR_PLUGIN_STATE_DIR/state.json` に `tab_id → { mode, lastCommand, lastSetLabel }` を永続化する。

`tab_id` は閉じたあと再利用されないため、初期スキャン時に存在しないタブのエントリを削除する。

### ログ

デーモンの stdout / stderr は state dir 配下のログファイルに書く。`herdr plugin log list` で見えるのはランチャーの実行ログなので、デーモン本体の診断はこのファイルを参照する。

## テスト戦略

TDD で実装する。

**Namer / StateStore** — vitest による単体テスト。実セッションから採取した `process_info` の JSON をフィクスチャとして使い、以下をケース化する。

- `caffeinate` + `claude` の入れ子から `claude` が選ばれること
- `-fish` がアイドル判定されること
- アイドル時に直前のコマンド名が維持されること
- 過去にコマンドがないアイドルタブは何も返さないこと
- 複数ペインで実行中のペインが優先されること
- `label` が `lastSetLabel` と食い違ったら手動固定に遷移すること
- 自分が付けた名前と一致している間は手動固定に遷移しないこと
- 数字への手動リネームで自動モードに戻ること
- `pane_id` の比較が `p10` と `p2` で数値順になること

**SocketClient** — テスト用の Unix socket サーバを立てて、1接続1往復のリクエストが成立すること、サーバ不在時にエラーとして扱われること、復帰後に次のリクエストが成功することを検証する。

**実機確認** — `herdr plugin link` して実際のセッションで動かす手順を README に記載する。

## 利用者向けの注意

`prompt_new_tab_name` は既定で `true` であり、タブ作成のたびに名前の入力を求められる。この状態では新規タブが常に手動固定と判定され、自動命名が効かない。README で `config.toml` に以下を設定するよう案内する。

```toml
[ui]
prompt_new_tab_name = false
```

この設定はプラグイン側からは変更できない。
