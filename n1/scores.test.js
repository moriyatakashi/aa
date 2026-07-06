// scores.test.js
// Node.js標準テストランナーで実行: node --test

import test from "node:test";
import assert from "node:assert/strict";
import {
  dummyScoresEmpty,
  dummyScoresOne,
  dummyScoresThree,
  formatScore,
  sortScoresByDate,
  summarize,
} from "./scores.js";

test("formatScore: 小数第1位までフォーマットする", () => {
  assert.equal(formatScore({ value: 80 }), "80.0");
  assert.equal(formatScore({ value: 65.25 }), "65.3");
});

test("sortScoresByDate: 日付の新しい順に並び替える", () => {
  const sorted = sortScoresByDate(dummyScoresThree);
  assert.deepEqual(
    sorted.map((s) => s.id),
    ["s3", "s2", "s1"]
  );
});

test("sortScoresByDate: 元の配列を変更しない", () => {
  const original = [...dummyScoresThree];
  sortScoresByDate(dummyScoresThree);
  assert.deepEqual(dummyScoresThree, original);
});

test("summarize: 0件の場合", () => {
  const result = summarize(dummyScoresEmpty);
  assert.deepEqual(result, { count: 0, avg: null });
});

test("summarize: 1件の場合", () => {
  const result = summarize(dummyScoresOne);
  assert.equal(result.count, 1);
  assert.equal(result.avg, 80);
});

test("summarize: 3件の場合", () => {
  const result = summarize(dummyScoresThree);
  assert.equal(result.count, 3);
  assert.equal(result.avg, (80 + 65 + 92) / 3);
});
