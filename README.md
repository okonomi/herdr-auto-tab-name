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
herdr plugin install okonomi/herdr-auto-tab-name
```

インストール先のマシンに **Node.js 20 以上と npm** が必要。`herdr plugin install` は
マニフェストの `[[build]]` を実行して `dist/` を生成するため、Node が無いと
プラグインは入っても起動しない。対応環境は macOS と Linux(Unix socket と `ps` に
依存するため Windows は対象外)。

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

## 複数マシンで使う

プラグインのコマンドは **herdr サーバーが動いているマシンで実行される**。デーモンも
そこに常駐し、そのマシンの socket に繋ぐ。したがって:

- **マシンごとに個別にインストールする。** 設定や状態はマシン間で共有されない
- **`herdr --remote <ssh-target>` で繋ぐ場合は、接続先(サーバー側)にインストールする。**
  手元のマシンには何も要らない。タブ名はサーバー側で書き換わるので、同じセッションに
  繋いでいる全クライアントに反映される

## デーモンの制御

`[[startup]]` から自動で起動するが、手で操作することもできる。

```bash
herdr plugin action invoke okonomi.auto-tab-name.status
herdr plugin action invoke okonomi.auto-tab-name.start
herdr plugin action invoke okonomi.auto-tab-name.restart
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

## デーモンの寿命

デーモンは detached で起動するため、herdr のセッションからは独立して生きる。以下は
herdr 0.8.0 / macOS で実際に確認した挙動。

| 状況 | デーモン |
| --- | --- |
| herdr を再起動する(停止が 30 秒未満) | **生存**。socket が消えている間は周回が失敗し続けるが、復帰すると自力で再接続する |
| PC がスリープする | **生存**。凍結中は周回が 1 回も走らないため、諦めるまでのカウンタは動かない |
| herdr を 30 秒以上停止する | **自己終了**。`herdr server unreachable for too long, exiting` をログに残して終わり、ゾンビプロセスを残さない |

`[[startup]]` は **herdr のセッション開始時**に発火する(`herdr plugin link` した時点では発火しない)。
このとき前のセッションのデーモンがまだ生きていることがあるが、`start` は冪等なので
`already running (pid ...)` を返して何もしない。二重起動にはならない。

逆に、デーモンが終了したあと herdr が動き続けている間は、何も自動では復帰させない。
タブ名が更新されなくなったら `status` で確認し、`start` で起動する。

## プラグインを更新したとき

Node は起動時にモジュールを読み込むので、`dist/` を上書きしても走っているデーモンの
コードは差し替わらない。そのため `start` は、走っているデーモンが今ディスクにある
ビルドのものかを確認する。`dist/*.js` の最新 mtime を起動時に pidfile へ記録しておき、
次の `start` で取り直した値と一致しなければ、古いデーモンを落として起動し直す。

`[[startup]]` は毎セッション `start` を呼ぶので、**更新後の最初のセッションで自動的に
入れ替わる**。そのセッションでは `replaced pid <old>; started (pid <new>)` が返る。

今すぐ反映したいときは `restart` を使う。ビルドが変わっていなくても必ず入れ替える。

```bash
herdr plugin action invoke okonomi.auto-tab-name.restart
```

## state ディレクトリ

デーモンの状態は `${HERDR_PLUGIN_STATE_DIR}` 以下に置く。`<key>` は接続先 socket
パスの SHA-256 の先頭 8 文字。

| ファイル | 内容 |
| --- | --- |
| `state-<key>.json` | タブごとの自動/手動モードと直前のコマンド名 |
| `daemon-<key>.json` | 起動中デーモンの pid レコード(pid・スクリプトパス・起動時刻・起動時のビルドの版) |
| `daemon-<key>.log` | デーモンのログ |
| `start-<key>.lock` | `start` の多重実行を防ぐための排他ロック |

ファイル名を socket ごとに分けているのは、herdr の名前付きセッション
(`herdr --session <name>`)に対応するため。セッションはそれぞれ独自の socket を
持つが `HERDR_PLUGIN_STATE_DIR` はセッションを跨いで共有されるので、名前を
分けないと 2 つめのセッションの `start` が 1 つめのデーモンの pid レコードを見て
「もう動いている」と誤判断し、そのセッションではタブ名が一切更新されない。
`state` も分ける必要がある。タブ ID (`w6:t1` など) はセッションを跨いで重複するため、
共有すると別セッションの同じ ID のタブの状態を上書きしてしまう。

セッションを削除しても、そのセッションの `state-<key>.json` と `daemon-<key>.log` は
残る(pid レコードはデーモンが終了時に自分で消す)。害はないが、気になるなら手で消す。

## トラブルシューティング

デーモンのログ・状態・pid レコードは herdr がプラグインに渡す
`HERDR_PLUGIN_STATE_DIR` 以下、通常は次の場所にある。

```bash
ls  ~/.local/state/herdr/plugins/okonomi.auto-tab-name/
cat ~/.local/state/herdr/plugins/okonomi.auto-tab-name/daemon-<key>.log
```

このパスは herdr 側が決めるものでインストールによって変わりうるため、確実に知りたければ
`HERDR_PLUGIN_STATE_DIR` 環境変数を参照する。

`herdr plugin log list --plugin okonomi.auto-tab-name` で見えるのは `cli.js` の実行ログで、
デーモン本体の診断には上のファイルを見る。

**`state-<key>.json` を消して「リセット」しようとしない。** これが無いと、番号以外の
タブ名はすべて「手動で付けた名前」として読み直されるため、削除すると自動命名していた
タブが軒並み手動固定に固定されてしまう。特定のタブだけ元に戻したいときは、そのタブ名を
番号にリネームする。

**デーモンは 30 秒間連続で herdr に到達できないと終了する。** 短い再起動やスリープでは
終了しない(→ [デーモンの寿命](#デーモンの寿命))。デーモンは自分では再起動しないので、
タブ名が更新されなくなったら `status` で確認し、`start` アクションで起動し直す。

**`herdr plugin unlink` は動いているデーモンを止めない。** 先に `stop` アクションを実行する。

## 開発

```bash
npm test        # vitest
npm run build   # tsc
```
