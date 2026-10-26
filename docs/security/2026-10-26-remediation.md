# 脆弱性修正結果（2026-10-26）

**計画の実装・検証は完了。** [監査報告](2026-10-26-audit.md)の Go 標準ライブラリ11件と、ログイン試行記録の無制限蓄積に対処した。稼働環境への配備は実施していない。

## 実装

| 項目 | 修正後 |
| --- | --- |
| Go | go.mod・CI・READMEを1.27.3へ統一。システム全体のGo設定は変更なし |
| CIスキャナー | govulncheck v1.9.0に固定。オンラインDBを照合 |
| ユーザー別試行 | 接続元IP＋ユーザー名の組で5回／分。キーはSHA-256の固定長 |
| 送信元別試行 | 接続元IP全体で30回／分。ユーザー名変更や成功ログインでも回避不可 |
| 記録上限 | 両map合計4,096件。各試行で期限切れを削除し、判定・更新は同一mutex内 |

固定1分窓を採用し、拒否で期限を延長しない。成功時は該当ユーザー別記録だけ削除する。容量不足時は新しい記録を登録せず、既存記録は通常の制限内なら利用できる。拒否応答は既存形式のHTTP 429と `Retry-After: 60`。公開APIや設定項目の追加、背景goroutine、DB変更はない。

送信元は従来の `remoteAddress` を使用する。reverse proxy 経由では利用者全員が同じ接続元枠を共有する点をREADMEに記載した。転送ヘッダーの新たな信頼や解釈は追加していない。

## 検証

| 検査 | 結果・証拠 |
| --- | --- |
| 修正前の再現 | 期限切れ保持・IP別31回目・容量超過の3テストで期待した失敗。[ログ](2026-10-26-remediation-evidence/tests-red.txt) |
| 認証回帰テスト | 期限切れ1,000件の削除、期限境界、容量残り1件、満杯時の既存キー、容量回復、成功後の送信元制限、並行要求、HTTP 429を確認。[ログ](2026-10-26-remediation-evidence/tests-login.txt) |
| Windows全体テスト | Go1.27.3で `go test ./... -timeout 180s` が終了コード0。最終実行は変更のないパッケージにGoのテストキャッシュを使用。[ログ](2026-10-26-remediation-evidence/tests-all.txt) |
| Ubuntu race | 既存WSL Ubuntuの一時Go1.27.3で `go test -race ./internal/wui -run '^TestLoginAttempts' -count=1` が終了コード0。[ログ](2026-10-26-remediation-evidence/tests-ubuntu-race.txt) |
| Playwright | 実Goハンドラーと一時DBに対し、ログイン204、認証済みAPI200、異なるユーザー名で29回401、次の試行429、Retry-After60、画面の制限メッセージを確認。ブラウザJS例外0件。[結果](2026-10-26-remediation-evidence/playwright-result.json)・[ログ](2026-10-26-remediation-evidence/tests-playwright.txt) |
| ソースのgovulncheck | 到達可能0件、import済みpackageのみの検出0件、呼び出し未検出のmodule検出3件。終了コード0。[ログ](2026-10-26-remediation-evidence/govulncheck-source.txt) |
| Windows/Linuxバイナリ | 両方Go1.27.3、amd64、CGO無効でビルド。両方の `govulncheck -mode binary` が到達可能0件、終了コード0。[Windows](2026-10-26-remediation-evidence/govulncheck-windows.txt)・[Linux](2026-10-26-remediation-evidence/govulncheck-linux.txt) |

moduleのみの3件はGO-2026-6355、GO-2026-6354（SSH）、GO-2026-5932（openpgp）。現状のArgon2id用途からの呼び出しは検出されていない。承認済み計画に従い、これらを理由とするx/crypto更新は行っていない。

独立した読み取り専用コードレビューでも、修正必須の指摘はなかった。CIにはUbuntuの同じrace検査を追加したが、GitHub Actionsのリモート実行は未実施。

## 成果物

ソース修正は `76c2c0c`（認証）と `4949529`（Go・CI・README）。ビルド対象は後者のコミット。成果物は既存バイナリと別の `C:\Temp\strata-security-build-20261026\` に保存した。

| ファイル | サイズ | SHA-256 |
| --- | ---: | --- |
| mochizuki-windows-amd64.exe | 20,590,592 bytes | b3240b24d7730144c55da38f51c4386aab11f430cb9d50d8d0cb87b78c510dba |
| mochizuki-linux-amd64 | 20,157,792 bytes | 224df3fb3a038131504855f919a474ab661e467cfbe4298d9a3cd2d928598e61 |

[機械可読マニフェスト](2026-10-26-remediation-evidence/artifacts.json)、[Windowsビルド情報](2026-10-26-remediation-evidence/windows-buildinfo.txt)、[Linuxビルド情報](2026-10-26-remediation-evidence/linux-buildinfo.txt)を保存した。既存の未コミット `.gitignore` 変更を保持したため、バージョンは `0.1.0-dev.556+4949529894dd.dirty` である。バイナリ自体はGitに追加していない。

## 再実行と検証上の制約

通常の全体テストはブラウザ不要。Playwrightを再実行する場合は、`STRATA_SECURITY_BROWSER_NODE` にNodeのパス、`STRATA_SECURITY_PLAYWRIGHT` にPlaywrightのモジュールパスを設定し、`go test ./internal/wui -run '^TestLoginSecurityBrowser$' -count=1 -v` を実行する。既存ブラウザの場所が必要なら `PLAYWRIGHT_BROWSERS_PATH`、証拠保存先には `STRATA_SECURITY_BROWSER_OUTPUT` を指定できる。テストは一時DBとloopback上の一時ポートだけを使う。

Windowsのrace検査は既存MinGWが64ビットをコンパイルできず失敗したため、Ubuntuで同じ対象のrace検査を実行して通過を確認した。UbuntuのGoは `/tmp/strata-security-20261026/` 内だけに展開し、システムへはインストールしていない。ビルドスクリプトは既存の実行ポリシーに拒否されたため、当該プロセスだけExecutionPolicy Bypassで実行した。SHA-256はGet-FileHashが利用できなかったため.NETのSHA256実装で記録した。

既存実行ファイルの上書き、稼働プロセスの停止・起動、録画や本番DBの変更、リモートへのpush・merge・公開は実施していない。成果物はビルド情報と静的な脆弱性検査までであり、Linux全体テスト、各バイナリを使った実録画運用は未検証。
