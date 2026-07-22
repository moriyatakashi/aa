import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PPU } from './ppu.js';

test('ppu: constructor exists', () => {
  assert.equal(typeof PPU, 'function');
});
