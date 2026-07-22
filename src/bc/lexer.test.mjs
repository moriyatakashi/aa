import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLabelToken } from './lexer.js';

test('lexer: isLabelToken behavior', () => {
  assert.equal(isLabelToken('MAIN'), true);
  assert.equal(isLabelToken('GR1'), false);
});
