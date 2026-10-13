// Random ids, the one thing the engine asks Node's `crypto` for
Boltchat.define('crypto', function (require, module, exports) {
  const randomBytes = n => Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(n)));

  module.exports = { randomBytes };
});
