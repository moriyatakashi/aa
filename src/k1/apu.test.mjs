import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APU } from './apu.js';

test('apu: constructor exists', () => {
  assert.equal(typeof APU, 'function');
});
