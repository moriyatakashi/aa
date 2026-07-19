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

## 実行
```
node --test
```
Node.js組み込みのテストランナーがリポジトリ全体から`*.test.js`を探すため、パス指定は不要。CIでは`.github/workflows/test.yml`の`test`ジョブで実行される。
