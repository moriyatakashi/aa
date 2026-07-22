import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NESRom } from './nes-rom.js';

test('nes-rom: constructor throws on invalid buffer', () => {
  // pass a short buffer to trigger the magic bytes check
  const buf = new Uint8Array([0,1,2,3]);
  assert.throws(() => new NESRom(buf), Error);
});
