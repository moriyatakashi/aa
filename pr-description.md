title: chore: add test scripts and coverage workflow

package.json に test/test:ci スクリプトと c8 を追加し、
Node と Python のテストを実行してカバレッジを生成する GitHub Actions ワークフローを追加しました。
また、src 以下の主要モジュールに対するテストスタブをいくつか追加しています。

CI 実行後、coverage レポートを Actions のアーティファクトから確認できます。
