# SATOYAMA LINE same-origin proxy

`line.satoyama-ai-base.com`を、SATOYAMA LINE Harness Workerへ同一オリジンで中継する
専用Vercel projectの設定である。

## 目的

- LINE内ブラウザの上部に`r-inafuku.workers.dev`を表示しない
- LIFF SDK、静的asset、既存予約・フォーム、オンボーディングAPIを同じhostで動かす
- apex/wwwサイトのVercel projectへrewriteを追加せず、LINE経路を分離する

単純redirectではなくexternal rewriteを使う。URLはブラウザ上で
`line.satoyama-ai-base.com`のまま維持される。認証を含む応答をVercel側で保持しないよう、
rewrite cacheを無効にする。

## 本番切替

1. 専用projectをproduction deployする。
2. `line.satoyama-ai-base.com`を専用projectへ割り当てる。
3. 画面、asset、API、既存予約・フォームを確認する。
4. LINE Developersの既存LIFF endpointのhostだけを
   `line.satoyama-ai-base.com`へ変更する。root pathと`liffId` queryは維持する。

## ロールバック

LIFF endpointを直前のWorker URLへ戻し、必要ならVercel projectからcustom domainを外す。
Worker、D1、リッチメニューには変更を加えない。
