import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CPU } from './cpu.js';

test('cpu: constructor exists', () => {
  assert.equal(typeof CPU, 'function');
});
