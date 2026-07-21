import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function createHarness() {
  const elements = new Map();
  const bodyChildren = [];
  const document = {
    body: {
      appendChild(node) {
        bodyChildren.push(node);
      },
    },
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(),
        style: {},
        className: '',
        textContent: '',
        href: '',
        id: '',
        addEventListener() {},
        remove() {},
        appendChild() {},
      };
    },
    getElementById(id) {
      return elements.get(id) || null;
    },
  };

  const window = {
    AA_PUBLIC_VIEW: true,
    AA_AUTH_EVENT: 'test-login-success',
    __loginState: null,
    __credential: null,
    addEventListener() {},
    dispatchEvent() { return true; },
    google: { accounts: { id: { disableAutoSelect() {} } } },
  };

  const storage = new Map();
  const localStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    },
  };

  const globals = {
    window,
    document,
    localStorage,
    CustomEvent: class CustomEvent { constructor(type) { this.type = type; } },
    TextDecoder,
    atob(value) {
      return Buffer.from(value, 'base64').toString('binary');
    },
    btoa(value) {
      return Buffer.from(value, 'binary').toString('base64');
    },
    setTimeout(fn) {
      fn();
      return 0;
    },
    clearTimeout() {},
    fetch: async () => ({ ok: true, json: async () => ({ sessionToken: null }) }),
  };

  Object.assign(globalThis, globals);
  return { document, elements, window };
}

test('auth.js tolerates missing gate/content elements in public view mode', async () => {
  createHarness();
  await assert.doesNotReject(async () => {
    const authPath = pathToFileURL(path.resolve('src/common/auth.js')).href;
    await import(`${authPath}?t=${Date.now()}`);
  });
});
