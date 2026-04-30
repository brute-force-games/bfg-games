// Base64url encoding helpers (no padding). Shared by identity, signing, and
// any binary↔string roundtrips on the wire.

export function bytesToB64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function b64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(padded);
  // Allocate an explicit ArrayBuffer (not SharedArrayBuffer) so the result
  // satisfies WebCrypto's `BufferSource` parameter type under TS 6.
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
