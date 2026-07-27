# SATOYAMA LINEオンボーディング 本番E2E安全手順

確認日: 2026年7月27日

## 結論

本番の実利用者で、3問回答・再回答・スキップ・CTAを検証しない。これらはD1へ状態、回答履歴、
タグ、オンボーディング用metadataを書き込むためである。

本番の通常確認は、書き込みを行わないcanaryと画面表示までに限定する。3問の最後まで進める
確認は、次のどちらかで行う。

1. ローカルの`preview=1`で行う
2. 専用LINEテストユーザーで行い、事前に復元点と対象を記録し、直後に限定クリーンアップする

運営者本人や実際の見込み客を、本番書き込みE2Eのテストユーザーとして使わない。

## 本番で安全に行える確認

次のコマンドは、公開画面へのGETと、認証なしAPIが401で閉じることだけを確認する。
Bearer token、LINE user ID、friend ID、POST bodyを受け付けず、D1へ書き込まない。

```bash
pnpm canary:satoyama-onboarding:production
```

実機LINEでは、イントロが表示されるところまで確認して閉じる。「3問を始める」を押すと
`questions_started_at`が保存されるため、実利用者を汚さない確認では押さない。

## 3問の書き込みE2E

### 第一選択: ローカルpreview

`apps/liff`を開発モードで起動し、次を開く。

```text
/onboarding/satoyama?preview=1
```

previewでは質問開始、回答保存、スキップ、特典閲覧、CTA計測、LINEトーク送信を行わない。

### 本番が不可欠な場合: 専用テストユーザー

開始前に次を記録する。

- 専用テストユーザーである根拠
- Harness account IDとprogram version
- 対象friendの既存state、event、`[SB]`タグ、`sb_*` metadataの件数
- D1 Time Travel bookmark
- 検証する操作と期待件数

検証後は同じ作業内で、対象account + friend + programだけを限定クリーンアップする。
削除後にstate 0件、event 0件、`[SB]`タグ割当0件、`sb_*` metadataなしを確認する。
タグ定義、friend行、`[SB]`以外のタグ、通常metadata、予約、フォーム、会話は削除しない。

専用テストユーザーを用意できない場合、本番書き込みE2Eは実施しない。ローカルpreviewと
読み取り専用canaryで止め、未確認として記録する。

## 禁止事項

- 運営者本人や実利用者の回答を、検証データとして残す
- 復元点、対象、事前件数を確認せずに本番D1を削除する
- stateだけを削除して、回答履歴、`[SB]`タグ、`sb_*` metadataを残す
- 既存回答の自動復元仕様を、検証データの問題と混同して変更する
- 認証tokenやLINE user IDをコマンド出力、ログ、文書へ記録する

## 今回の教訓

PC ChromeでLINE実認証を行ったユーザーは、Ryoさん本人のLINE user IDだった。初回回答と
再回答が本番D1へ保存され、iPhoneの再訪時に正しく復元された。自動復元は仕様どおりであり、
問題は実利用者を本番書き込みE2Eに使い、検証後にクリーンアップしなかった運用である。
