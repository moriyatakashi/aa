import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Comet2 } from './comet2.js';

test('comet2: can construct and load', () => {
  const vm = new Comet2();
  assert.equal(typeof vm.load, 'function');
});
