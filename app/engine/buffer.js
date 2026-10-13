// The small part of Node's Buffer that the engine uses: bytes with base64, hex and UTF-8 text.
// A Buffer here is a Uint8Array with a few extra methods.
(scope => {
  const CHUNK = 0x8000;

  function toBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    return btoa(binary);
  }

  function fromBase64(text) {
    const binary = atob(String(text).replace(/[^A-Za-z0-9+/]/g, ''));
    const bytes = new Buffer(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  class Buffer extends Uint8Array {
    // Buffer.from(string[, 'utf8' | 'base64' | 'hex'])   Buffer.from(bytes)   Buffer.from(arrayBuffer[, offset, length])
    static from(value, encodingOrOffset, length) {
      if (typeof value === 'string') {
        if (encodingOrOffset === 'base64') return fromBase64(value);
        if (encodingOrOffset === 'hex') return new Buffer(value.match(/.{2}/g)?.map(pair => parseInt(pair, 16)) || []);
        return new Buffer(new TextEncoder().encode(value));
      }
      if (value instanceof ArrayBuffer) return new Buffer(value.slice(encodingOrOffset || 0, length === undefined ? undefined : (encodingOrOffset || 0) + length));
      if (ArrayBuffer.isView(value)) return new Buffer(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      return new Buffer(value || []);
    }

    static isBuffer(value) {
      return value instanceof Buffer;
    }

    toString(encoding) {
      if (encoding === 'base64') return toBase64(this);
      if (encoding === 'latin1') return String.fromCharCode(...this.subarray(0, 4096)); // only used on a file's first bytes
      if (encoding === 'hex') return [...this].map(byte => byte.toString(16).padStart(2, '0')).join('');
      return new TextDecoder().decode(this);
    }
  }

  scope.Buffer = Buffer;
  scope.Boltchat.define('buffer', (require, module) => { module.exports = { Buffer }; });
})(self);
