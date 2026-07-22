import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findClassification } from './thread-logic.js';

test('thread-logic: findClassification returns null for empty', () => {
  assert.equal(findClassification([]), null);
});
