# Strata PVR から Mochizuki PVR への更新

正式名称（日本語表記を含む）は **Mochizuki PVR**、コマンド名は **`mochizuki`** です。

## 設定・データへの影響

| 対象 | 更新時の動作 |
| --- | --- |
| `data/config.json` | 旧 `strata/config` version 1 をそのまま読み込めます。設定APIの応答と保存は `mochizuki/config` version 1 になります。読込みだけではファイルを書き換えません。旧スキーマによる設定APIの保存も受け付けます。 |
| `data/strata.db` | ファイル名を維持し、同じDBを開きます。番組表・予約・録画履歴・ルール・録画完了の復旧状態を引き継ぎます。DBと `-wal` / `-shm` を個別に改名しないでください。 |
| 録画・ログ・キャッシュ | 保存先と形式を維持します。設定内の録画パス・後処理コマンドも変更しません。 |
| 認証 | パスワードハッシュ・既存APIトークンは引き継ぎます。新規トークンの接頭辞は `mochizuki_`。セッションCookie名は変更するため、ブラウザで再ログインしてください。 |
| ブラウザ設定 | 同じオリジン（プロトコル・ホスト・ポート）では非表示チャンネル、一覧フィルター、録画一覧件数・表示形式、番組表ズームを `strata-pvr.*` から `mochizuki.*` へ初回コピーします。既存の新キーを優先し、旧キーは復旧用に保持します。別オリジンへの変更時はブラウザ設定を再設定してください。 |

旧名が残るDB名、完了状態の内部キー `_strataFinalizing`、設定読込み互換、過去の監査・実装記録は意図的なものです。既存環境に `init` や Chinachu 用の `migrate` を再実行する必要はありません。

## 既存環境の更新

1. 旧 scheduler timer / scheduler / operator / WUI を停止し、自動起動を解除します。実行中の録画が完了してから行ってください。SysVや独自の起動スクリプトを使用している場合も、旧プロセスが再起動しないよう停止・無効化します。

   ```sh
   sudo systemctl disable --now strata-pvr-scheduler.timer strata-pvr-operator.service strata-pvr-wui.service
   sudo systemctl stop strata-pvr-scheduler.service
   ```

2. 停止中に設定・DBを含む `data/` 全体と必要な録画をバックアップします。新バイナリを **既存の作業ディレクトリ** に配置し、旧コマンドの呼出しを `mochizuki` に更新します。フォルダー名の変更は不要です。例えば旧 `/opt/strata-pvr` を使い続ける場合：

   ```sh
   sudo install -m 0755 mochizuki /opt/strata-pvr/mochizuki
   cd /opt/strata-pvr
   ./mochizuki recorded
   ./mochizuki reserves
   ```

   実行ユーザーと所有権を維持してください。稼働中のDBに新旧プロセスを同時接続しないでください。

3. 新しい `contrib/systemd/mochizuki-*` unit を導入します。新規環境向けの既定値は `/opt/mochizuki` です。既存環境では、**3つのserviceすべて** の `WorkingDirectory` を既存ディレクトリへ、`ExecStart` をそのディレクトリの新バイナリへ変更してから起動してください。旧 `User` / `Group`、環境変数、権限制限などのカスタマイズも新unitへ転記します。既存アカウントの改名は不要です。

   ```ini
   WorkingDirectory=/opt/strata-pvr
   ExecStart=/opt/strata-pvr/mochizuki run operator
   ```

   WUI は `run wui`、scheduler は `run scheduler` にします。timer の対象は `mochizuki-scheduler.service` です。新unitの配置・編集後：

   ```sh
   sudo systemctl daemon-reload
   sudo systemctl enable --now mochizuki-operator.service mochizuki-wui.service mochizuki-scheduler.timer
   ```

4. WUIを再読み込みし、再ログインして番組表・予約・録画履歴・設定を確認します。ブックマークは同じURLなら使えます。`wuiWebDir` / `--web-dir` を指定している場合は外部Web資材も新バージョンへ更新してください。DOM ID、タブ間通知名、エラーヘッダーは新名称になっています。独自APIクライアントは `X-Mochizuki-Error-Code` を使用してください。

5. 問題があれば新サービスをすべて停止し、旧バイナリと停止中のバックアップへ戻します。新形式の設定は旧バイナリが読めないため、旧設定もバックアップから復元してください。旧localStorageは保持されています。新旧サービスを同時に有効化しないでください。

リポジトリのローカルフォルダー名やホスティング側のリポジトリ名は実行に影響しません。外部の配布ページ・サービス登録・手作業の起動スクリプトは設置者側で新名称へ更新します。
