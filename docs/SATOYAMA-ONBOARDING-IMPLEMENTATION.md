# SATOYAMA LINE登録直後オンボーディング 実装記録

確認日: 2026年7月26日
状態: 隔離branch実装・検証済み。本番未反映

## 1. 結論

SATOYAMA AI BASE専用のLIFFオンボーディングを、既存の汎用フォームとは分けて実装した。
質問への回答は任意で、回答・スキップのどちらを選んでも既存のAI相談、リッチメニュー、
予約、診断、ワークショップ機能を止めない。

主分岐は課題5系統、言い方とCTAは立場4種類、具体例は領域5種類で変える。立場・課題・
領域の14タグは独立して保持し、再回答時はこの14タグだけを置き換える。

実装は初期状態で停止している。SATOYAMAの対象account IDと有効化flagを明示しない限り、
APIは404で閉じ、リマインダーも動かない。

## 2. 作業場所と基準

### 確認できた事実

- 元checkout: `/Users/Inaryo/line-harness-oss`
- 元checkoutのブランチ: `feat/quick-replies`
- 元checkoutのHEAD: `9c145f89b408661ee658393d498132032430aa8a`
- 元checkoutには作業開始前から次の差分があった。
  - `apps/worker/wrangler.toml` の変更
  - `.line-harness-config.json` の未追跡ファイル
- 上記差分の所有者は未確認のため、元checkoutでは編集していない。
- `git ls-remote`で確認した`origin/main`のHEAD:
  `9c5ee04c1d5f784e4d335c66708e52265cf51d46`
- 専用ブランチ: `feat/satoyama-line-onboarding`
- 専用worktree:
  `/Users/Inaryo/Documents/SATOYAMA AI BASE｜Content & Research Lab/worktrees/line-harness-satoyama-onboarding`
- 専用worktreeは`origin/main`から分離し、元checkoutの既存差分には触れていない。

## 3. 実装した体験

### 質問順

1. 近い状況
2. 立場
3. 最初に改善したい領域

質問はすべて選択式で、自由記述を保存しない。所要時間の表示は「目安25〜40秒・入力作業
なし」とした。回答せず閉じる、または「今回は回答しない」を選べる。

1問目より前に、選択内容とLINE上の識別子を保存すること、利用目的、回答が任意であることを
表示し、SATOYAMA AI BASEのプライバシーポリシーへリンクした。

### 特典

登録時の共通特典は、差し替え可能なversion付きデータとして実装した。

- メール・問い合わせ返信
- 会議メモを要点と次の行動に整理
- 社内向け案内文・手順書のたたき台

3問完了後は、選んだ課題に対応する1枚シートを表示する。特典には効果保証、導入実績、
顧客成果などの未確認表現を含めていない。個人情報、顧客機密、認証情報を入力しない注意を
共通特典内に明記した。

### 回答後の案内

20通りの「課題5 × 立場4」をデータとして実装した。それぞれに次を持たせている。

- 最初の返信
- 次の一歩
- 今後の配信テーマ3件
- 立場に合わせたCTA文言とLINEトークへ送る相談文

領域は20通りの主文岐を増やさず、具体業務の例示だけを変える。CTAを押した時だけ
`liff.sendMessages()`を試す。`chat_message.write`がない場合や送信に失敗した場合は、同じ
相談文をクリップボードへコピーして本人が送れるようにする。無料相談の予約は自動表示・
自動開始しない。

## 4. 認証とaccount境界

### 確認できた事実

- クライアントは`lineUserId`、`friendId`、`lineAccountId`を送らない。
- WorkerはBearerのLINE IDトークンを受け取り、公開LIFF IDと環境変数で指定した
  SATOYAMA account IDの両方に一致する1アカウントだけをDBから選ぶ。
- LINE Loginのverify APIへは、そのアカウントの`login_channel_id`だけを
  `client_id`として渡す。他アカウントへのfallbackはしない。
- verify結果の`sub`からfriendを検索し、同じ`line_account_id`に属し、かつ
  `is_following=1`の時だけ読み書きする。
- 管理画面cookieは使わない。状態変更はBearerトークンで認証するため、管理画面の
  double-submit CSRFとは別境界になる。
- LIFFが別originの場合は、`SATOYAMA_ONBOARDING_ORIGIN`で指定したHTTPS originを、
  SATOYAMAオンボーディングAPIだけに許可する。`ADMIN_ORIGIN`とは分けた。
- 新規ログはユーザーID、friend ID、アクセストークン、IDトークン、LINE providerの
  例外本文を出さない。

### 残る制約

- LINE verify API自体は外部依存である。到達できない時は503で閉じ、別accountの
  channel IDへ切り替えない。
- 既存のLINE Harness全体には、オンボーディング以外のログでfriend IDなどを出す箇所が
  残っている。今回は新規フローとfollow時に追加で触れたログだけをPII非表示にした。

## 5. データモデル

Migration `047_satoyama_onboarding.sql`は追加型で、次を作る。

- `friends(id, line_account_id)`の複合unique index
- 最新状態を持つ`satoyama_onboarding_states`
- 再回答履歴を持つ`satoyama_onboarding_answer_events`

状態には、3回答、共通特典閲覧、質問開始、課題別特典閲覧、CTAクリック、48時間後案内、
完了・スキップ時刻を保持する。回答イベントは自由記述ではなく3つのcodeと
idempotency keyだけを保存する。

複合外部キー`(friend_id, line_account_id)`で、別accountのfriendへ書けないようにした。
回答履歴、最新状態、friend metadata、14タグの入れ替えは1回のD1 batchで処理する。
同じidempotency keyと同じ回答は再実行でき、同じkeyで異なる回答は409にする。

LIFF側では、送信中のidempotency keyを3回答の組み合わせと一緒に保持する。通信失敗後に
同じ回答をそのまま再送した場合だけ同じkeyを使い、1項目でも回答を変えた時点で古いkeyを
破棄する。これにより、失敗後の回答変更で古いkeyとの409競合が起きないようにした。

タグ名は全て`[SB]`名前空間に入れた。再回答ではこの14タグだけを削除・再付与し、
運営者が付けた他のタグは変更しない。

### 回答履歴の増加を抑える境界

回答イベントは監査と再回答の計測に使うため、今回もappend-onlyのままにした。一方で、
有効な利用者が新しいidempotency keyを繰り返し発行して履歴を増やす経路を抑えるため、
`line_account_id + friend_id + program_version`ごとに、直近24時間で受理する新規回答を
20回までに制限した。

20回は通常の初回回答と再回答には十分な余裕を残しつつ、1利用者・1プログラムの永続行増加を
最大20件/24時間に抑える初期値である。同じkey・同じ回答の単純な再試行は新しい履歴を
作らないため、上限到達後も冪等な再実行として扱う。別account、別friend、別programは
別の枠になる。

DBでは事前件数確認だけに頼らず、回答イベントを追加する`INSERT`文にも同じ件数条件を入れた。
同時に2件が20件目を取り合う場合も、先に保存された行を後続の`INSERT`が再確認し、21件目の
イベントと、それに続く最新状態・metadata・タグの更新を行わない。上限時のAPIは429を返し、
画面には「少し時間をおいて再度お試しください」と技術用語を使わず表示する。

### 保存期間と自動削除

データ最小化の初期運用値を次で確定した。

- 回答イベント履歴: 90日
- 特典、質問開始、CTA、再案内の操作時刻: 90日
- 最新の3回答、`[SB]`タグ、オンボーディング用metadata: 友だち期間中は保持し、
  ブロック・友だち解除から30日後に削除
- 明示的な相談・予約記録: オンボーディングとは別管理とし、この削除処理の対象外

6時間cronで動く削除処理を追加したが、
`SATOYAMA_ONBOARDING_RETENTION_ENABLED=true`までfail-closedである。対象は環境変数で
指定したSATOYAMA accountだけで、他account、通常のfriend行、`[SB]`以外のタグ、
オンボーディングと無関係なmetadataは変更しない。ブロック後30日の判定には、
unfollow webhookで記録するオンボーディング専用の`unfollowed_at`を使い、
汎用の`friends.updated_at`によって期限が延びないようにした。再follow時はこの時刻を解除する。

本番で質問導線を有効にする時は、プライバシーポリシーを先に公開し、この削除flagも同時に
有効化する。削除処理は破壊的なので、D1バックアップと少人数データでの確認を先に行う。

## 6. 48時間後の再案内

- follow時に、機能flag・対象account・リマインダーflagが全て一致した時だけ48時間後を予約する。
- cronでは対象accountだけを取得し、DBで`reminder_attempts=1`へclaimできた1件だけを処理する。
- 送信直前に状態を再読込し、完了、スキップ、unfollow、送信済みなら送らない。
- 成功・失敗を問わず再試行しない。最大1回である。
- 完了、スキップ、unfollowで未送信の案内を取消す。
- 案内文は回答が任意であり、未回答でもAI相談・メニューを使えることを明記する。

外部LINE APIを呼ぶ最後の瞬間と、同時に起きる回答完了の間には、ごく短い競合窓が残る。
DBの事前claimと送信直前の再読込で縮小しているが、外部送信を完全なDB transactionには
できない。このため内容を任意の再案内に限定し、1回を超えて再送しない。

## 7. 計測できる指標

個人を特定する自由記述を追加せず、DB集計で次を確認できる。

- follow後の対象数
- 質問開始率
- 3問完了率、スキップ率
- 課題・立場・領域の各構成比
- 共通特典閲覧率
- 課題別特典閲覧率
- CTAクリック率
- 48時間後案内の試行数、成功数、失敗数
- 再回答数

初期判断は母数が小さい可能性があるため、個別ユーザーの行動評価ではなく、質問負荷、
特典の利用、次の一歩の分かりやすさを改善する仮説検証として使う。

## 8. 本番前に必要な設定

次はコード上の設定項目であり、今回は値の設定や外部画面の変更を行っていない。

### Worker

```text
SATOYAMA_ONBOARDING_ENABLED=true
SATOYAMA_ONBOARDING_ACCOUNT_ID=<SATOYAMAのline_accounts.id>
SATOYAMA_ONBOARDING_REMINDER_ENABLED=false
SATOYAMA_ONBOARDING_RETENTION_ENABLED=false
SATOYAMA_ONBOARDING_ORIGIN=https://<LIFFを配信するorigin>
```

同一originでLIFFを配信する場合、`SATOYAMA_ONBOARDING_ORIGIN`は不要。最初の本番確認では
リマインダーを`false`のままにする。RetentionはmigrationとD1バックアップ確認後に
`true`へ切り替え、削除対象件数を確認してから質問導線を有効化する。

### LIFF build / LINE Developers

- 別origin構成では`VITE_API_BASE`にWorker originを設定する。
- 必要なら`VITE_DEFAULT_LIFF_ID`を設定する。通常はLIFF URLの`liffId`を使う。
- LIFF endpoint URLに`/onboarding/satoyama`を到達可能な形で登録する。
- IDトークン検証には`openid`が必要。
- このオンボーディング実装はprofile情報を取得しないため、`profile`は不要。
- CTAからLINEトークへ文面を入れるには`chat_message.write`が必要。
- 友だち追加直後メッセージ、または明示した導線から次の形式で開く。
  `https://liff.line.me/{LIFF_ID}/onboarding/satoyama?liffId={LIFF_ID}`

LINE Developers、LINE公式アカウント、リッチメニューの実機状態は今回変更・確認していない。
記録上のリッチメニューv13と実機の一致も未確認である。

## 9. 検証記録

### 自動検証

- Worker全テスト: 59 files / 720 tests
- DB全テスト: 3 files / 16 tests
- LIFF送信・再送テスト: 2 files / 6 tests
- DB bootstrap生成差分チェック
- DB TypeScript typecheck
- Worker TypeScript typecheck
- LIFF TypeScript project build
- LIFF production build
- Worker production build

追加テストでは、通常保存、20回上限、24時間経過後、同じkeyの冪等再実行、別account、
別friend、90日経過後の履歴・操作時刻、unfollow後30日の削除境界を確認した。
削除時に他account、通常metadata、`[SB]`以外のタグが残ることも確認した。
さらに、事前件数確認の直後に別リクエストが20件目を保存する競合を
再現し、候補側が回答イベント、最新状態、friend metadata、タグを変更しないことを確認した。
LIFFでは、同じ回答の再試行は同じkeyを使い、回答を変えた時は新しいkeyになること、429で
技術用語を使わない案内を表示すること、`chat_message.write`がない場合に相談文をコピーへ
退避することを確認した。

Worker buildには既存のdynamic/static import警告が出るが、build自体は成功した。オンボーディング
由来の型エラー、テスト失敗、build失敗はない。

### 画面確認

ローカルの送信しないpreviewで確認した。

- PC相当: 1440 × 1000、横overflowなし
- スマホ相当: 390 × 844、横overflowなし
- スマホの主要ボタン高: 44px以上
- 質問順: 状況 → 立場 → 領域
- 3問後に回答結果、次の一歩、明示CTA、課題別追加シートを表示
- previewのCTAではLINE送信せず、その旨を画面表示
- Vite error overlay: なし
- browser console error: 0件

実機LINE WebViewとLINE Developersのscopeは未確認である。

## 10. ロールバック

最短の停止方法は、コードを戻す前に次のflagを`false`へ戻すことである。

```text
SATOYAMA_ONBOARDING_ENABLED=false
SATOYAMA_ONBOARDING_REMINDER_ENABLED=false
SATOYAMA_ONBOARDING_RETENTION_ENABLED=false
```

これで専用APIは404になり、新規予約・cron送信・自動削除は止まる。Migrationは追加型なので、
緊急停止時にtableを削除しない。既存データを消すrollbackは復旧を難しくするため、
保持期間と削除方針を決め、バックアップ後の別作業にする。

LINE側の友だち追加メッセージやリッチメニューに導線を追加した場合は、その外部設定も
直前の記録へ戻す必要がある。今回は外部設定を変更していない。

## 11. サイト・プライバシーポリシー側の別作業

元checkout `/Users/Inaryo/satoyama-ai-base`は編集せず、別worktree
`worktrees/satoyama-site-source-of-truth`のbranch `feat/satoyama-site-source-of-truth`で、
プライバシーポリシーの追記案を実装・検証した。公開サイト、本番、元checkoutには未反映である。

同案には次を反映した。

- LINEユーザー識別子、3回答、付与タグ、特典・CTA・再案内の操作時刻を収集すること
- 利用目的が、案内の個別化、相談受付、サービス改善、最大1回の再案内であること
- LINEヤフー、Cloudflareなど、処理に使う外部サービスと役割
- 回答履歴・操作時刻は90日、最新回答と`[SB]`タグは友だち解除後30日で削除すること
- 開示、訂正、削除、配信停止の連絡方法
- 回答が任意で、未回答でも基本機能を使えること

具体的な保存日数とunfollow後の自動削除は実装済みで、サイト側の公開文にも反映した。
ただし、公開前に本番D1バックアップとRetention flagの有効化確認が必要である。
サイト側は49 files / 732 tests、型検査、production build、PC・スマホ表示を確認済み。

## 12. Ryoの判断が必要な項目

1. 共通特典、課題別シート、CTA文20通りを初期公開文として最終承認するか。
2. 初回は`chat_message.write`を付けず、送信失敗時もコピーへ退避する方針でよいか。
3. 友だち追加直後に強制表示せず、メッセージ内の明示ボタンから開く方針でよいか。
4. 48時間後案内は停止したまま少人数公開し、結果を見て別判断する方針でよいか。
5. プライバシーポリシーをLINE導線より先に公開する日。
6. 記録上v13のリッチメニューと実機の差を確認し、どのボタンからこの画面へ接続するか。
7. 本番反映順を、migration → code（flag off）→ LIFF → Retention確認 → 少人数確認 → feature on →
   reminder onとするか。

## 13. 今回行っていないこと

- merge
- LINE公式アカウント、LINE Developers、LINE Harness本番への変更
- LINE Harness用Cloudflare、D1本番、LIFF Pagesへの変更・送信・deploy
- 実ユーザーへのメッセージ送信
- 元checkout `/Users/Inaryo/satoyama-ai-base`の編集
- サイト用隔離branchの公開・deploy
- 現行リッチメニューとLINE実機の確認
- 本番migration適用
