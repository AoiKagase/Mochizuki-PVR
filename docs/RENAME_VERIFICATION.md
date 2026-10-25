# Mochizuki PVR 名称変更の検証（2026-10-25）

- 正式名称・日本語表記: Mochizuki PVR。CLI / Go module: `mochizuki`。
- 調査対象: WUI・CLI・Go import・設定形式・Mirakurun User-Agent・HTTP識別子・ビルドスクリプト・CI artifact・systemd / SysV・現行ドキュメント。
- 互換方針と更新手順: [UPGRADING_MOCHIZUKI.md](UPGRADING_MOCHIZUKI.md)。実ユーザーの設定・録画は操作せず、一時環境で検証した。

## 実行結果

| 検証 | 結果 |
| --- | --- |
| `go test ./...` | 全パッケージ成功。旧DBの録画読出し・既存の録画完了復旧テストを含む。 |
| 設定・認証の追加テスト | 新旧スキーマ読込み、バージョン・設定検証、GET時ファイル不変、保存時の新形式化、パスワード・トークンハッシュ保持、旧接頭辞Bearer認証を確認。 |
| `go vet ./...` | 成功。 |
| `scripts/build.ps1` | Windows `mochizuki.exe` の生成とバージョン埋込みに成功。 |
| Linux amd64 クロスビルド | 新moduleの `-ldflags` 指定と `./cmd/mochizuki` で成功。 |
| Playwright (`node --test web/hardening.browser.test.cjs`) | 31件成功。新名称・設定画面・5つの旧localStorageキー移行・新キー優先・storage利用不可・既存のPC/タッチ/テーマ/ログイン/再生関連チェックを含む。 |
| 実バイナリ + Playwright | 隔離した一時環境で `help` / `init`、旧 `strata/config` に戻した設定でのWUI起動、HTTP Server/status識別、設定画面表示・保存による `mochizuki/config` 化、DBパス維持を確認。 |
| 差分確認 | `git diff --check` 成功。互換用の旧名は更新手順に明記。 |

Windowsの一時ファイル改名・ネイティブHTTP待受け確認はサンドボックスの制限で失敗したため、許可された制限外実行で再検証した。

Linux実機のsystemd起動・実チューナー録画・本番更新は実行していない。GitHub側のリポジトリ名とローカルチェックアウトのフォルダー名は変更していない。過去の監査・実装記録は証跡として旧表記を保持する。
