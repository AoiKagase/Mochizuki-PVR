# systemd units for Mochizuki PVR

既存の Strata PVR から切り替える場合は、先に [更新手順](../../docs/UPGRADING_MOCHIZUKI.md) を確認してください。旧サービスの停止・無効化と既存作業ディレクトリの維持が必要です。

These units assume Mochizuki PVR is installed in `/opt/mochizuki` and the binary
is `/opt/mochizuki/mochizuki`.

`mochizuki run <component>` uses the current working directory for
`data/config.json`, `data/strata.db`, `data/`, and `log/`, so keep
`WorkingDirectory` pointed at the Mochizuki installation directory.

## Install

```sh
sudo install -d -m 0755 /opt/mochizuki
sudo install -m 0755 mochizuki /opt/mochizuki/mochizuki
sudo sh -c 'cd /opt/mochizuki && ./mochizuki init'

sudo install -m 0644 contrib/systemd/mochizuki-operator.service /etc/systemd/system/
sudo install -m 0644 contrib/systemd/mochizuki-wui.service /etc/systemd/system/
sudo install -m 0644 contrib/systemd/mochizuki-scheduler.service /etc/systemd/system/
sudo install -m 0644 contrib/systemd/mochizuki-scheduler.timer /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl enable --now mochizuki-operator.service
sudo systemctl enable --now mochizuki-wui.service
sudo systemctl enable --now mochizuki-scheduler.timer
```

Run the scheduler once immediately if needed:

```sh
sudo systemctl start mochizuki-scheduler.service
```

## Adjust paths or user

If you install somewhere other than `/opt/mochizuki`, edit `WorkingDirectory`
and `ExecStart` in each unit.

The services run without a systemd `User=` by default. This preserves the
runtime behavior where Mochizuki PVR reads `data/config.json` and then applies `uid` and
`gid` from the config where supported. If you want systemd to manage the user
instead, add `User=` and `Group=` to the service files and make sure the working
directory, `data/`, `log/`, and recorded directory are writable by that user.

## Logs

Use journalctl for service output:

```sh
journalctl -u mochizuki-wui.service -f
journalctl -u mochizuki-operator.service -f
journalctl -u mochizuki-scheduler.service
```

Mochizuki PVR also writes legacy-compatible logs under `/opt/mochizuki/log/`.

---

# Mochizuki PVR systemd インストールガイド

このディレクトリには、Linux の systemd で Mochizuki PVR を起動するための
ユニットファイル例があります。

標準では次の配置を想定しています。

- 作業ディレクトリ: `/opt/mochizuki`
- 実行ファイル: `/opt/mochizuki/mochizuki`
- 設定ファイル: `/opt/mochizuki/data/config.json`
- SQLiteデータベース: `/opt/mochizuki/data/strata.db`
- 状態ファイル: `/opt/mochizuki/data/`
- ログファイル: `/opt/mochizuki/log/`
- Web UI 静的ファイル: `/opt/mochizuki/web/`

`mochizuki run <component>` はカレントディレクトリの `data/` と `log/` を
扱います。そのため各 unit の `WorkingDirectory` は、Mochizuki PVR の
インストールディレクトリに合わせてください。

## 1. バイナリをビルドする

リポジトリのルートで Linux 用バイナリをビルドします。

```sh
go build -o mochizuki ./cmd/mochizuki
```

別マシンでクロスビルドする場合は、実行先の Linux に合う `GOOS` / `GOARCH`
を指定してください。

例:

```sh
GOOS=linux GOARCH=amd64 go build -o mochizuki ./cmd/mochizuki
```

## 2. ファイルを配置する

`/opt/mochizuki` にバイナリを配置し、`init` で設定とSQLiteデータベースを
初期化します。

```sh
sudo install -d -m 0755 /opt/mochizuki
sudo install -m 0755 mochizuki /opt/mochizuki/mochizuki
sudo sh -c 'cd /opt/mochizuki && ./mochizuki init'
```

既存のChinachu環境から移行する場合は、リポジトリのREADMEに従って
`migrate/` を用意し、`mochizuki migrate` を実行してください。

## 3. systemd unit をインストールする

```sh
sudo install -m 0644 contrib/systemd/mochizuki-operator.service /etc/systemd/system/
sudo install -m 0644 contrib/systemd/mochizuki-wui.service /etc/systemd/system/
sudo install -m 0644 contrib/systemd/mochizuki-scheduler.service /etc/systemd/system/
sudo install -m 0644 contrib/systemd/mochizuki-scheduler.timer /etc/systemd/system/
sudo systemctl daemon-reload
```

各 unit は `/opt/mochizuki` を前提にしています。別の場所にインストールする
場合は、インストール後に次の項目を編集してください。

- `WorkingDirectory`
- `ExecStart`

例:

```sh
sudo systemctl edit --full mochizuki-wui.service
```

## 4. 起動する

`operator` と `wui` は常駐 service として起動します。

```sh
sudo systemctl enable --now mochizuki-operator.service
sudo systemctl enable --now mochizuki-wui.service
```

`scheduler` は短時間で終了する処理なので、timer で定期実行します。

```sh
sudo systemctl enable --now mochizuki-scheduler.timer
```

すぐに一度だけ scheduler を実行したい場合:

```sh
sudo systemctl start mochizuki-scheduler.service
```

## 5. 状態を確認する

```sh
systemctl status mochizuki-operator.service
systemctl status mochizuki-wui.service
systemctl status mochizuki-scheduler.timer
```

timer の実行予定は次のコマンドで確認できます。

```sh
systemctl list-timers 'mochizuki-*'
```

## 6. ログを確認する

systemd journal:

```sh
journalctl -u mochizuki-operator.service -f
journalctl -u mochizuki-wui.service -f
journalctl -u mochizuki-scheduler.service
```

Mochizuki PVR の互換ログ:

```sh
sudo tail -f /opt/mochizuki/log/operator
sudo tail -f /opt/mochizuki/log/wui
sudo tail -f /opt/mochizuki/log/scheduler
```

## 7. 実行ユーザーを変更する場合

同梱の unit は systemd の `User=` / `Group=` を指定していません。これは
Mochizuki PVR が `data/config.json` の `uid` / `gid` を読み込んで、対応する処理で
権限を落とす挙動を保つためです。

systemd 側で実行ユーザーを固定したい場合は、各 service に `User=` と
`Group=` を追加してください。

例:

```ini
User=mochizuki
Group=mochizuki
```

その場合は、次の場所をそのユーザーが読み書きできるようにしてください。

- `/opt/mochizuki`
- `/opt/mochizuki/data`
- `/opt/mochizuki/log`
- `data/config.json` の録画保存先ディレクトリ

## 8. 停止・再起動

```sh
sudo systemctl restart mochizuki-operator.service
sudo systemctl restart mochizuki-wui.service
sudo systemctl stop mochizuki-scheduler.timer
```

完全に自動起動を無効化する場合:

```sh
sudo systemctl disable --now mochizuki-operator.service
sudo systemctl disable --now mochizuki-wui.service
sudo systemctl disable --now mochizuki-scheduler.timer
```
