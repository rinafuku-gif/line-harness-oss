# SATOYAMA LINE登録直後オンボーディング 実装記録

確認日: 2026年7月27日
状態: D1 migration 047、無限待機hotfix、Worker再配置、feature有効化、独自ドメインproxy、LINE Developersのendpoint切替まで完了。PC Chrome実認証テストで誤って残したRyoさん本人の検証データは限定クリーンアップ済み。iPhone LINE内ブラウザでイントロから始まることの本人再確認だけ未完了

## 1. 結論

SATOYAMA AI BASE専用のLIFFオンボーディングを、既存の汎用フォームとは分けて実装した。
質問への回答は任意で、回答・スキップのどちらを選んでも既存のAI相談、リッチメニュー、
予約、診断、ワークショップ機能を止めない。

主分岐は課題5系統、言い方とCTAは立場4種類、具体例は領域5種類で変える。立場・課題・
領域の14タグは独立して保持し、再回答時はこの14タグだけを置き換える。

本番ではSATOYAMAの対象account IDを固定し、オンボーディング本体を有効化した。
48時間後の再案内は停止したままで、一斉送信・自動push・既存友だちへの送信は行っていない。
現行リッチメニューv13も変更していないため、一般利用者が意図せず画面へ誘導される状態ではない。

### 2026年7月27日の本番再監査で分かったこと

事実と推論を分けるため、過去の記録だけでなくGit、Cloudflare、D1、LINE API、公開URLを
再確認した。

確認できた事実:

- 現行Workerは`https://satoyama.r-inafuku.workers.dev`で、D1は`satoyama`
  (`a45e126e-4f05-49db-ada2-fb9767fb892d`)である。
- 反映前のWorker versionは`a7fd8991-cdec-4002-b92a-fe74ac549ffd`、feature有効化後の
  Worker versionは`3626ec6f-ebac-40fe-bc16-a3ac79716003`である。
- 本番D1へmigration 047だけを適用し、2 tableと4 indexを作成した。適用後の
  `satoyama_onboarding_states`と`satoyama_onboarding_answer_events`はいずれも0件である。
- 047適用直前のD1 Time Travel bookmarkとして
  `000009e3-0000011e-000050b4-38feaf45dfd0865661baf8f7391bf256`、
  適用後のbookmarkとして
  `000009e3-00000128-000050b4-28bddb44242ab70c30f83c3121bee23c`を記録した。
- 本番D1には`_migrations`管理表がない。今回は過去の001〜046を再実行しないため、
  047のSQLだけを明示適用した。将来GitHub Actionsのmigration自動適用を有効にする前に、
  現行DBとmigration管理表の整合を別作業で解決する必要がある。
- LINE公式アカウントは`SATOYAMA AI BASE`、Basic IDは`@969evmpq`、
  Harness account IDは`c8e69a14-b590-4ce0-8910-fb2b3ae516b5`である。
- LIFF IDは`2010452980-ng2A6Rna`である。初回公開時のendpointは現行Worker rootだったが、
  hotfix後は同じroot構造を保ったまま`https://line.satoyama-ai-base.com`へ変更した。
- 公開LIFF URLが生成したLINE Login認可URLでは、実効scopeが`openid profile`であり、
  `chat_message.write`が含まれないことを確認した。オンボーディング実装は`profile`を
  読み取らない。
- LINE APIで確認したdefault rich menuは、記録どおりv13
  (`richmenu-2a48f46d9d89eb5a68bee02c530d55e2`)である。
- 公開中のプライバシーポリシーには、3回答・タグ・操作時刻、利用目的、90日、unfollow後
  30日の保持方針がすでに反映されている。
- オンボーディング用の別Pages projectは存在せず、`apps/liff`だけをbuildしても現行LIFF
  endpointへは配信されない。

推論:

- 現行Workerのdeploy時刻はcommit `9c145f8`の作成直後であり、現在の本番コードは
  `b423e6a`と`9c145f8`を含む可能性が高い。Workerのversion metadataだけではGit SHAを
  直接証明できないため、この2 commitを新branchへ明示的にmergeして退行を防いだ。

未確認:

- RyoさんのiPhone LINE内ブラウザで、hotfix後の初回表示と再訪を再確認する必要がある。
- PC ChromeのLINE認証ユーザーでは3問回答と再回答を確認した。スキップ、ブロック・
  友だち解除は実ユーザーでは未確認であり、自動テストで境界を確認している。

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
- 本番退行を避けるため、現行本番に含まれると判断した`b423e6a`と`9c145f8`を専用branchへ
  mergeした。元checkoutのbranchや未コミット差分は変更していない。

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

## 8. 本番へ反映した設定

次の値をWorker secretとして反映した。値はrepositoryへコミットしていない。

### Worker

```text
SATOYAMA_ONBOARDING_ENABLED=true
SATOYAMA_ONBOARDING_ACCOUNT_ID=c8e69a14-b590-4ce0-8910-fb2b3ae516b5
SATOYAMA_ONBOARDING_REMINDER_ENABLED=false
SATOYAMA_ONBOARDING_RETENTION_ENABLED=true
```

LIFF画面とAPIは同じWorker originで配信するため、`SATOYAMA_ONBOARDING_ORIGIN`は設定して
いない。リマインダーは`false`のままである。Retentionはmigration、Time Travel復元点、
削除対象0件を確認した後に`true`へ設定した。

### LIFF配信 / LINE Developers

- LIFF endpointはroot pathを保ったまま、次へ変更した。
  `https://line.satoyama-ai-base.com?liffId=2010452980-ng2A6Rna`
- LINEがchild pathを`liff.state`に入れてrootを開いた場合と、直接
  `/onboarding/satoyama`を開いた場合だけ、専用React画面を遅延読込する。
- 既存の友だち追加、予約、フォームの分岐は従来のentry pointを通り、専用画面を読まない。
- 独自domainはVercelの同一origin rewriteで既存Workerへ接続する。root、直接path、
  予約、フォーム、APIをredirectせず同じhostで扱う。
- IDトークン検証には`openid`が必要。
- このオンボーディング実装はprofile情報を取得しないため、`profile`は不要。
- 初回公開では`chat_message.write`を追加しない。既存scopeで明示送信が成立しない場合は
  相談文をコピーする。
- 友だち追加直後メッセージ、または明示した導線から次の形式で開く。
  `https://liff.line.me/{LIFF_ID}/onboarding/satoyama?liffId={LIFF_ID}`

LINE APIでv13とLIFF IDを確認し、LINE Developers管理画面でもendpoint、実効scope
`openid profile`、`chat_message.write`がないことを確認した。公開LIFFの認可URLでも
`redirect_uri`が独自domainへ変わったことを確認した。v13の6ボタンは別用途へ上書きして
いない。一般向けの明示ボタンはまだ追加していない。

## 9. 検証記録

### 自動検証

- Worker全テスト: 60 files / 732 tests
- DB全テスト: 3 files / 16 tests
- LIFF全テスト: 3 files / 10 tests
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
Worker統合では、直接pathと`liff.state`の両方を検出し、別originの`liff.state`を無視する
こと、直接pathでLIFF shellをredirectなしに返すこと、未ログイン時はログイン開始後に画面を
描画しないこと、ID tokenがない場合はfail-closedになることを追加確認した。

Worker buildには既存のdynamic/static import警告が出るが、build自体は成功した。オンボーディング
由来の型エラー、テスト失敗、build失敗はない。

### 画面確認

専用LIFF単体の送信しないpreviewで確認した。

- PC相当: 1440 × 1000、横overflowなし
- スマホ相当: 390 × 844、横overflowなし
- スマホの主要ボタン高: 44px以上
- 質問順: 状況 → 立場 → 領域
- 3問後に回答結果、次の一歩、明示CTA、課題別追加シートを表示
- previewのCTAではLINE送信せず、その旨を画面表示
- Vite error overlay: なし
- browser console error: 0件

Workerへ統合した画面は1280 × 720のブラウザで、直接path、質問順、回答結果、コピーCTA、
横overflowなし、console error 0件を確認した。統合後の画面を390 × 844と1440 × 1000で
再取得する操作はブラウザ検証環境の制約で完了していない。単体画面では両サイズを確認済み
だが、統合後の厳密な2サイズと実機LINE WebViewは未確認として残す。

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

元checkout `/Users/Inaryo/satoyama-ai-base`は今回編集していない。公開中の
`https://www.satoyama-ai-base.com/legal/privacy`を2026年7月27日に再確認し、
オンボーディングに必要な記載が反映済みであることを確認した。

同案には次を反映した。

- LINEユーザー識別子、3回答、付与タグ、特典・CTA・再案内の操作時刻を収集すること
- 利用目的が、案内の個別化、相談受付、サービス改善、最大1回の再案内であること
- LINEヤフー、Cloudflareなど、処理に使う外部サービスと役割
- 回答履歴・操作時刻は90日、最新回答と`[SB]`タグは友だち解除後30日で削除すること
- 開示、訂正、削除、配信停止の連絡方法
- 回答が任意で、未回答でも基本機能を使えること

具体的な保存日数とunfollow後の自動削除はコードと公開文で一致している。本番D1の
Time Travel復元点、047適用結果、Retention flag、有効化直前の削除対象0件を確認した。

## 12. 初回公開で確定した判断

1. 共通特典、課題別シート、CTA文20通りを検証版として開始する。
2. `chat_message.write`は追加せず、送信できない場合はコピーへ退避する。
3. 友だち追加直後に強制表示せず、本人が押す明示ボタンから開始する。
4. 48時間後案内と一斉・自動pushは停止する。
5. 生の自由会話をこの機能では収集しない。
6. v13の既存6ボタンを意味の違う導線へ上書きしない。
7. migration → code feature OFF → canary → retention確認 → feature ONの順で進める。

## 13. 本番反映結果

2026年7月27日に次の順で反映した。

1. D1 Time Travelの適用直前bookmarkを取得した。
2. migration 047だけを本番D1へ適用した。
3. commit `5edfcba7e0e3f01f184cbce58a6cf7e484529d3a`を基準にWorkerを配置し、
   featureを停止した状態でAPIが404になることを確認した。
4. 対象account、リマインダー停止、Retention有効を設定した。
5. featureを有効にし、正しいLIFF IDの認証なしアクセスと不正Bearerが401、
   別LIFF IDが404になることを確認した。
6. 既存の`/api/liff/config`、同一origin CORS、default rich menu v13が維持され、
   回答・再案内データが0件であることを再確認した。

初回反映時の本番Worker versionは`3626ec6f-ebac-40fe-bc16-a3ac79716003`である。
feature停止中の確認versionは`9e8b389d-1587-41a6-b75f-02881ee26f83`、
最初のコード配置versionは`86233f52-37c2-4339-b1b9-faf77a67782d`である。
hotfix後の現在versionは`446b12ee-6cc4-45ab-bb87-4b8351033206`である。

公開LIFF URLは次である。

`https://liff.line.me/2010452980-ng2A6Rna/onboarding/satoyama?liffId=2010452980-ng2A6Rna`

このURLからPC ChromeのLINE認証を完了し、独自domain上で3問回答、回答変更、再訪時の
最新回答復元まで確認した。一般向け入口は接続していないため、URLを知るテスト利用者だけが
明示操作で開始できる。

GitHub branchは上記commitまでpush済みである。当初GitHub integrationでは403だったが、
ローカルで最新`main`との競合がないことを確認した後、CLIの既存認証でPR #4をReady化し、
2026年7月27日にmergeした。merge commitは
`3862d1e36b667bccff9eb9232ccd81cfc6b8845a`である。

## 14. 本番作業でも行わなかったこと

- 一斉配信、自動push、既存友だちへのメッセージ送信
- `chat_message.write`の追加
- 48時間後リマインダーの有効化
- LINE Developers scopeの拡張
- v13の既存ボタンを説明と異なる機能へ付け替えること
- 元checkout `/Users/Inaryo/satoyama-ai-base`の編集
- オンボーディング専用Pages projectの新設

## 15. 2026年7月27日「読み込み中…」無限待機hotfix

### 発生事象と原因

RyoさんのiPhone LINE内ブラウザで公開LIFFを開いたところ、Reactの
「読み込み中…」カードが消えない事象が発生した。専用path判定、遅延読込、React mount開始
までは到達していたが、次の3箇所に時間上限がなかった。

- LIFF SDKの`liff.init`
- LIFF画面からオンボーディングAPIへの`fetch`
- WorkerからLINE ID token verify APIへの`fetch`

このため、いずれか1つが応答を返さないと`loading=true`から抜けず、成功、明確なエラー、
再試行のどこにも収束しない構造だった。元のiPhone事象で3箇所のうち実際にどの通信が
止まったかは、発生時の段階ログがなく事後には断定できない。確認できた根本原因は、
外部通信の保留を有限時間で扱わない設計である。

### 修正

- LIFF SDK初期化を10秒で打ち切り、ログイン移動中または再試行可能なエラーを表示する。
- オンボーディングAPI要求全体を10秒で打ち切る。`AbortController`だけに依存せず、
  `fetch`自体が保留したままでもtimeout Promiseで必ず終了する。
- LINE verify APIを5秒で打ち切り、Workerは503を返す。
- 初期の静的「読み込み中…」をReact読込開始直後に
  「LINEとの接続を確認しています」へ置き換え、失敗時は「もう一度試す」を表示する。
- LIFFログインの`redirectUri`に現在のpath、query、`liff.state`を保持する。
- token verify timeout時のログは固定文だけとし、LINE user ID、token、回答内容を出さない。

実装commitは`3848967`、LIFF root proxy修正commitは`2f70d4c`で、
branch `feat/satoyama-line-onboarding`へpushした。検証記録commit `91bb30e`までを
PR #4でmergeし、merge commitは`3862d1e36b667bccff9eb9232ccd81cfc6b8845a`である。

### 独自ドメイン

`satoyama-ai-base.com`の権威DNSはVercelの
`ns1.vercel-dns.com` / `ns2.vercel-dns.com`であり、Cloudflare zoneではない。
影響の大きいNS移管は行わず、Vercelの専用project `satoyama-line-proxy`から既存Workerへ
同一originのexternal rewriteを設定した。

- 公開host: `https://line.satoyama-ai-base.com`
- Vercel project: `satoyama-line-proxy`
- 本番deployment: `dpl_BmqBm9MzozHj4Yq4ZMzC29yipQVm`
- upstream: 既存Worker。redirectではなくrewriteのため、ブラウザのURLは独自hostのまま
- `/`専用rewriteと`/:path*`の両方を持ち、既存LIFF root、予約、フォーム、
  オンボーディングを同一hostで通す
- `X-Robots-Tag: noindex, nofollow`、Vercel rewrite cache無効化headerを設定

root 200、`/book`から独自hostの`/?page=book`への302、予約画面200、
フォーム画面200、オンボーディング画面200を確認した。独自domainを付ける前の404状態も
確認してから割り当てており、既存Vercel site projectや意図せず作られた空projectには
触れていない。

### Worker反映と安全確認

hotfix前のWorker version
`3626ec6f-ebac-40fe-bc16-a3ac79716003`と、D1 Time Travel bookmark
`000009e5-00000056-000050b5-f68ce17b6b7250c34deaec54ff077abd`を復旧点として保持した。
D1 migrationやデータ変更は行っていない。

1. `SATOYAMA_ONBOARDING_ENABLED=false`で正しいAPIが404になることを確認した。
2. hotfix codeをversion `96a2c772-2563-4a5f-94f9-2a0bf9976070`として配置した。
3. Worker直・独自domainの画面、API、予約、フォームをfeature OFFで確認した。
4. featureを再度有効にし、最終version
   `446b12ee-6cc4-45ab-bb87-4b8351033206`を100%配信した。
5. 一意queryで、正しいLIFF IDへの認証なし要求がWorker直・独自domainとも401、
   feature ON、account境界有効を確認した。
6. Cloudflare tailを自分のIP、GET、最終versionだけに絞り、独自domainへ送った一意な
   canaryがWorkerのオンボーディングAPIへ到達し、正常に処理完了したことを実ログで確認した。

最終設定は従来どおり、feature ON、48時間リマインダー OFF、Retention ONである。
D1、予約/フォームデータ、v13、一斉配信、既存友だちへのpushは変更していない。
endpoint変更前の読み取り集計ではオンボーディングstate 0件、回答event 0件だった。
PC Chromeの実認証テスト後はstate 1件、回答event 2件となった。2件は初回回答と
回答変更の検証データであり、確認用の集計SQL自体は書込み0件だった。

### 再検証

- Worker全テスト: 60 files / 734 tests
- DB全テスト: 3 files / 16 tests
- LIFF全テスト: 4 files / 16 tests
- Worker / DB TypeScript typecheck
- LIFF / Worker production build
- DB bootstrap生成差分なし
- 直接pathと`liff.state`で専用画面をmountし、3問回答後の案内まで確認
- 保留したLIFF init、画面fetch、LINE verifyがそれぞれ有限時間で失敗へ収束するテスト
- LINE verify timeoutが503になり、再試行可能な日本語案内になることを確認
- 既存の予約・フォーム・イベント関連テストを含むWorker全テストを再実行

LINE Developersの管理画面でendpointを
`https://line.satoyama-ai-base.com?liffId=2010452980-ng2A6Rna`へ変更した。公開LIFF URLが
生成した認可URLの`redirect_uri`も独自domainへ変わり、旧Worker hostを含まない。
PC ChromeではLINEログイン後に`liff.state`から`/onboarding/satoyama`が復元され、
無限待機やconsole errorなしで画面が開いた。

実認証ユーザーで、初回回答、課題だけを変えた再回答、再訪時の最新回答復元を確認した。
390×844では`scrollWidth=390`、1440×1000では`scrollWidth=1440`で横overflowはない。
いずれもブラウザURLは`line.satoyama-ai-base.com`のままである。

### 残る本人確認

RyoさんのiPhone LINE内ブラウザで、次の公開URLを再度開き、上部表示が
`line.satoyama-ai-base.com`であることと、「読み込み中…」で停止しないことを確認する。

`https://liff.line.me/2010452980-ng2A6Rna/onboarding/satoyama?liffId=2010452980-ng2A6Rna`

既存予約・フォームが同じLIFF IDを共有するため、endpointのpathは
`/onboarding/satoyama`へ変更せずrootのまま維持した。実ユーザーでのスキップ、
ブロック・友だち解除は未確認であり、自動テストの確認結果と分けて記録する。

### hotfixのロールバック

1. 即時停止は`SATOYAMA_ONBOARDING_ENABLED=false`。リマインダーはOFFのまま維持する。
2. code rollbackはWorker version
   `3626ec6f-ebac-40fe-bc16-a3ac79716003`へtrafficを戻す。
3. endpoint変更後のdomain rollbackは、LINE Developersのendpointを旧Worker rootへ戻す。
4. proxyだけのrollbackは`line.satoyama-ai-base.com`のproject割当を外す。
5. D1は今回変更していないため、hotfix rollbackでtable削除やデータ復元を行わない。

## 16. 2026年7月27日 本番検証データの限定クリーンアップ

### 発生事象

Ryoさんは3問へ回答していないのに、iPhone LINE内ブラウザで公開LIFFを開くと、
`key_person / owner / sales`の完了画面が復元された。

### 確認できた原因

本番D1を読み取りで照合し、次を確認した。

- SATOYAMA account、program version 1のstateは1件、friendは1人
- state作成は`2026-07-27T12:32:32.063+09:00`
- 1回目の回答eventは`unsure_start / owner / sales`で
  `2026-07-27T12:32:48.932+09:00`
- 2回目の回答eventは`key_person / owner / sales`で
  `2026-07-27T12:33:20.873+09:00`
- 最終state、friend metadata、3つの`[SB]`タグは2回目の回答と一致

この時刻と回答変更は、直前に記録したPC Chrome実認証の「初回回答→課題だけ変更→再訪」の
検証内容と一致する。PCでLINE認証したユーザーがRyoさん本人と同じLINE user IDだったため、
本番D1に保存された検証回答がiPhone再訪時に仕様どおり復元された。既存の回答自動復元に
不具合があったのではなく、実利用者を本番書き込みE2Eに使い、終了後に検証データを
クリーンアップしなかった運用が原因である。

### 限定クリーンアップ

変更直前のD1 Time Travel bookmark:

`000009e6-00000020-000050b5-5959d2cdc352a1576dc592a7c03870e9`

account、program、回答値、state作成時刻、完了時刻、event件数2件が全て一致するfriendだけを
対象にし、次を削除・初期化した。

- `satoyama_onboarding_states`: 1件削除
- `satoyama_onboarding_answer_events`: 2件削除
- 対象friendの`[SB]`タグ割当: 3件削除
- 対象friendのオンボーディング専用`sb_*` metadata: 1行から7キーを除去

friend行、通常metadata、`[SB]`以外のタグ、タグ定義、予約、フォーム、会話、他accountは
変更していない。変更後はstate 0件、event 0件、`[SB]`タグ割当0件、
オンボーディングmetadataを持つfriend 0件を確認した。

変更後のD1 Time Travel bookmark:

`000009e6-00000022-000050b5-a0ecb5c6d5ccc6b2ab0d54c8120cfb47`

### 再発防止

本番の通常確認は、`pnpm canary:satoyama-onboarding:production`と実機のイントロ表示までに
限定する。このcanaryは公開HTMLへのGETと、認証なしAPIが401で閉じることだけを確認し、
Bearer token、LINE user ID、friend ID、POST bodyを使わない。

3問回答、再回答、スキップ、CTAの確認はローカル`preview=1`を第一選択にする。本番が
不可欠な場合だけ専用LINEテストユーザーを使い、開始前の復元点と件数、検証後の限定
クリーンアップまでを同じ作業として扱う。詳細は
`docs/SATOYAMA-ONBOARDING-PRODUCTION-E2E-SAFETY.md`を正本とする。

限定クリーンアップ後、次を再確認した。

- 本番の読み取り専用canary: 公開画面200、認証なしAPI 401
- ローカルpreview: イントロ表示から「3問に答える」で質問1/3へ進む
- preview確認後の本番D1: state 0件、event 0件、`[SB]`タグ割当0件、
  オンボーディングmetadata 0件のまま
- scripts: 6 files / 40 tests
- DB: 3 files / 16 tests
- Worker: 60 files / 734 tests
- LIFF: 4 files / 16 tests
- DB / Worker typecheck、LIFF / Worker production build

PC ChromeはLINEログイン状態がなかったため、クリーンアップ後の本番実認証画面は
「LINEアプリから開き直してください」までの確認になった。実認証状態でイントロが表示される
最終確認はRyoさんのiPhoneで行う。これは未確認として残し、PCから再ログインしてRyoさんの
レコードを使う方法では代替しない。

今回、既存回答の自動復元仕様は変更していない。「回答をやり直す」導線は別のUX改善候補で
あり、この誤データ是正には含めない。

## 17. 2026年7月27日 回答後特典とWeb管理画面連携

### 回答後特典

特典を回答前に全文表示していた構成をやめ、回答前は内容の予告だけ、3問完了後に本体を
開ける構成へ変更した。回答前のボタンは「3問に答えて無料で受け取る」とし、回答は任意、
相談送信や予約は自動で始まらない条件を維持する。

特典名は「AI活用スタートキット」。次の4点を1画面にまとめる。

- 回答した課題に合わせた業務整理シート
- 30日で1業務を小さく試す4週間の進め方
- 社内AI利用ルールのたたき台
- メール返信、会議メモ、社内手順に使うAI指示文3つ

回答前の画面から具体的なシート、進め方、ルール、指示文は開けない。回答完了後の特典を
開いた時だけ、共通特典と課題別特典の閲覧イベントを記録する。

### Web管理画面向け読み取り連携

SATOYAMA Webの既存管理画面から回答者を確認するため、
`GET /api/internal/satoyama/customers`を追加した。LINE HarnessのD1を正本のまま利用し、
Web側DBには顧客情報を複製しない。

- 固定したSATOYAMA LINE accountだけを対象にする
- 専用Bearer `SATOYAMA_SITE_READ_TOKEN`を通常の`API_KEY`から分離する
- tokenまたはaccount設定がない時は404、token不一致は401で閉じる
- 一覧は最大100件、表示名・回答状況・課題・立場・業務で絞り込める
- LINE user IDは返さず、管理画面で必要なfriend ID、表示名、画像、回答分類、
  対応状況、更新時刻だけを返す
- 応答は`Cache-Control: private, no-store`

専用endpointは通常の管理API認証の例外にするが、例外はGETかつ完全一致pathだけに限定し、
route内の専用Bearerで再認証する。外部送信、タグ変更、配信、回答更新は行わない。

### 検証

- Worker: 61 files / 738 tests
- DB: 3 files / 18 tests
- LIFF: 6 files / 19 tests
- DB / Worker TypeScript typecheck
- LIFF / Worker production build
- 専用token未設定、token欠落、不一致、無効filter、過大page sizeを拒否
- API応答にLINE user IDを含めないことを自動テストで確認
- 回答前は特典の予告だけ、回答後だけ特典本体を持つことを自動テストで確認

本番反映時は専用tokenをCloudflare WorkerとSATOYAMA Webのサーバー環境へsecretとして
同じ値で設定する。token値をブラウザbundle、Git、ログへ出さない。

## 18. 2026年7月27日 旧シナリオ停止と3問回答後フォロー

### 旧シナリオの停止

本番D1を確認したところ、過去の個人・スクール向け方針で作られた
`あいさつ（友だち追加）`が有効なまま残っていた。

- 友だち追加直後、1日後、3日後、6日後の4通
- 「ひとり経営の相棒」「5問・1分」「月額の会員」等、現在の中小企業向け方針と異なる文面
- 旧Vercel hostの診断URL
- SATOYAMA accountのfriend 1人に、2026年7月28日05:07 JSTの次回配信予約

変更直前のD1 Time Travel bookmark:

`000009e6-000000e0-000050b5-d0d3a99013a730d19bdbc0caf5f07ea1`

対象scenario IDを固定して`is_active=0`にし、同scenarioで進行中だったSATOYAMA accountの
1件だけを`paused`へ変更した。`next_delivery_at`はNULLにし、完了済み1件と他scenario、
他account、メッセージ履歴は変更していない。

### 3問回答後の課題別フォロー

3問の1問目で選ばれた課題を起点に、次の5本を用意する。

- 特定の人に仕事が集中している
- 引き継ぎ・標準化を整えたい
- AIを何から始めるか迷っている
- 安全な利用ルールと進め方を整えたい
- 具体的な業務を自動化・仕組み化したい

各scenarioは回答の翌日・3日後・7日後の10:00 JSTに1通ずつ送る。回答直後はLIFF上で
結果と特典を表示し、LINE pushを重ねない。2通目は回答内容に合ったスタートキットへの
再訪、3通目はLINEトークでの相談または料金ページの確認につなぐ。

安全条件は次のとおり。

- SATOYAMA accountに紐づく固定scenario IDだけを対象にする
- `tag_added`かつ現在の課題タグがfriendへ付いている時だけ登録する
- 同じ回答の再送では二重登録しない
- 回答する課題を変えた時は、以前の進行中scenarioを停止する
- 以前に完了または停止した同じ課題のscenarioは自動で再開しない
- 各配信直前にも課題タグの存在を確認し、タグが変わっていれば送信しない
- 既存回答者を遡って自動登録しない
- scenario設定が未作成・停止中・別account・タグ不一致の場合は配信を開始しない

文面と時刻の正本は
`apps/worker/src/features/satoyama-onboarding/followup-content.ts`、
本番D1へ反映するSQL生成は`scripts/render-satoyama-followup-sql.ts`とする。

### 本番反映

scenario登録直前のD1 Time Travel bookmark:

`000009e6-000000e6-000050b5-f2c2c278499eadbba9b61ba8ec432d35`

最初に5本・15stepを`is_active=0`で登録し、account、課題タグ、3step、
1日後・3日後・7日後、10:00 JSTが一致すること、登録者0件・配信予約0件を確認した。

commit `fd9cdf7`のWorkerを本番version
`7f7f6917-2c2a-4058-b698-b541d426b6ed`へ100%配備した。既存secret binding、
D1、R2、Assets、5分・6時間cronが保持されている。公開canaryはオンボーディング画面200、
認証なしAPI 401、既存予約入口200、フォーム入口200だった。

有効化直前のD1 Time Travel bookmark:

`000009e6-000000e8-000050b5-aa14b36635ea1fbe981ece1391ce817f`

固定した5 scenarioだけを有効化し、変更件数5を確認した。有効化後も既存回答者の
遡及登録は行わず、登録者0件・配信予約0件である。旧4通は`is_active=0`、
進行中だった1件は`paused`かつ次回予約NULLのままである。

有効化後のD1 Time Travel bookmark:

`000009e6-000000ea-000050b5-67d7b4f2a4aa266d48364b687a07f937`
