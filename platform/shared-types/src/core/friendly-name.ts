import { bytesToB64Url } from './encoding';

// Simple, readable, non-offensive-ish handle generator.
// Format: Adj-Noun-#### (4 digits)

const ADJECTIVES = [
  'Bright',
  'Calm',
  'Clever',
  'Curious',
  'Daring',
  'Eager',
  'Gentle',
  'Happy',
  'Jolly',
  'Kind',
  'Lively',
  'Mellow',
  'Nimble',
  'Quiet',
  'Quick',
  'Sharp',
  'Silly',
  'Solid',
  'Sunny',
  'Witty'
] as const;

const NOUNS = [
  'Badger',
  'Bear',
  'Bison',
  'Cedar',
  'Comet',
  'Dolphin',
  'Eagle',
  'Fox',
  'Heron',
  'Jade',
  'Koala',
  'Lynx',
  'Maple',
  'Otter',
  'Panda',
  'Quartz',
  'Raven',
  'Spruce',
  'Tiger',
  'Willow'
] as const;

function pick<T>(arr: readonly T[], n: number): T {
  return arr[Math.floor(n % arr.length)]!;
}

export function generateFriendlyName(seedBytes?: Uint8Array): string {
  const bytes = seedBytes ?? (() => {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return b;
  })();

  // Deterministic-ish integer seed derived from bytes.
  let x = 0;
  for (const b of bytes) x = (x * 131 + b) >>> 0;

  const adj = pick(ADJECTIVES, x);
  const noun = pick(NOUNS, x >>> 8);
  const digits = String((x >>> 16) % 10_000).padStart(4, '0');
  return `${adj}-${noun}-${digits}`;
}

export function deriveColorHex(seedBytes?: Uint8Array): string {
  const bytes = seedBytes ?? (() => {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return b;
  })();
  // Use first 3 bytes, but clamp to nicer range (avoid too dark).
  const r = 80 + (bytes[0]! % 150);
  const g = 80 + (bytes[1]! % 150);
  const b = 80 + (bytes[2]! % 150);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b
    .toString(16)
    .padStart(2, '0')}`;
}

export function seedFromPlayerId(playerId: string): Uint8Array {
  // Cheap stable bytes: base64url→bytes when possible, otherwise hash-ish fallback.
  const m = playerId.match(/^plyr_([A-Za-z0-9_-]+)$/);
  if (m?.[1]) {
    // Reuse existing base64url decoder behavior by roundtripping through bytesToB64Url length,
    // but we don't have b64UrlToBytes here to keep deps small; do a small pseudo-hash instead.
    const s = m[1];
    const out = new Uint8Array(16);
    for (let i = 0; i < s.length; i++) out[i % out.length] = (out[i % out.length]! + s.charCodeAt(i)) & 0xff;
    return out;
  }
  const out = new Uint8Array(16);
  const s = bytesToB64Url(new TextEncoder().encode(playerId));
  for (let i = 0; i < s.length; i++) out[i % out.length] = (out[i % out.length]! + s.charCodeAt(i)) & 0xff;
  return out;
}

