import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD_LENGTH } from '../bd/decoder.js';

test('decoder: constants present', () => {
  assert.equal(typeof PASSWORD_LENGTH, 'number');
});
