# e2e
[`src/`](../src/README.md)各アプリのPlaywright E2Eテスト。ファイル名の`2-`は「グループ2」を表す通し番号(グループ1は[`api-tests/`](../api-tests/README.md)のpytestテスト)。

| ファイル | 対応する`src/` |
|---|---|
| `2-1-ba-void-title-display.test.js` | `ba` |
| `2-2-bb-current-view.test.js` | `bb` |
| `2-3-bc-casl-engine.test.js` | `bc` |
| `2-4-k1-nes-smoke.test.js` | `k1` |
| `2-5-k2-radar-chart.test.js` | `k2` |
| `2-6-n1-n2-google-one-tap.test.js` | `n1`, `n2` |
| `2-7-bd-password-decoder.test.js` | `bd` |
| `2-8-persistent-session.test.js` | `n1`(`common/auth.js`) |

## 実行
初回のみ依存パッケージをインストール。
```
npm ci
npx playwright install --with-deps chromium
```
```
node --test
```
Node.js組み込みのテストランナーがリポジトリ全体から`*.test.js`を探すため、パス指定は不要。各テストファイルが自前で静的サーバーを起動し、Google認証・API呼び出しは`page.route()`でモックするため、`api/`や`src/`を別途起動しておく必要はない。CIでは`.github/workflows/test.yml`の`test`ジョブで実行される。
