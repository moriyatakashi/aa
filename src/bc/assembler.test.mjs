import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPCODES } from './assembler.js';

test('assembler: exports OPCODES', () => {
  assert.ok(OPCODES && typeof OPCODES === 'object');
});
