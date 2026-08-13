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
リネームする。このとき、手動固定の間に溜まった直前のコマンド名も同時に忘れるため、
リネーム直後は番号のままで、次にそのタブで何かコマンドを実行するまで名前は変わらない。

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

## デーモンの制御

`[[startup]]` から自動で起動するが、手で操作することもできる。

```bash
herdr plugin action invoke okonomi.auto-tab-name.status
herdr plugin action invoke okonomi.auto-tab-name.start
herdr plugin action invoke okonomi.auto-tab-name.stop
```

## 仕組み

`[[startup]]` から呼ばれる `cli.js start` が、常駐デーモン(`daemon.js`)を detached で
立ち上げる。デーモンは herdr の Unix socket に 1 秒ごとに `session.snapshot` と
`pane.process_info` を投げ、タブ名が変わるときだけ `tab.rename` を発行する。herdr サーバー
に 30 秒間連続で到達できないとデーモンは諦めて終了する。

代表プロセスはプロセスグループのリーダーを採る。claude が `caffeinate` を起動したような
入れ子でも、リーダーである claude 側が選ばれる。

herdr にはフォアグラウンドプロセスの変化を通知するイベントが無いため、ポーリングしている。

## state ディレクトリ

デーモンの状態は `${HERDR_PLUGIN_STATE_DIR}` 以下に置く。

| ファイル | 内容 |
| --- | --- |
| `state.json` | タブごとの自動/手動モードと直前のコマンド名 |
| `daemon.json` | 起動中デーモンの pid レコード |
| `daemon.log` | デーモンのログ |
| `start.lock` | `start` の多重実行を防ぐための排他ロック |

## トラブルシューティング

デーモンのログはプラグインの state ディレクトリにある。

```bash
cat "$(herdr plugin config-dir okonomi.auto-tab-name)/../state/daemon.log"
```

`herdr plugin log list --plugin okonomi.auto-tab-name` で見えるのは `cli.js` の実行ログで、
デーモン本体の診断には上のファイルを見る。

## 開発

```bash
npm test        # vitest
npm run build   # tsc
```
