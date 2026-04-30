import { z } from 'zod';

import { b64UrlToBytes, bytesToB64Url } from './encoding';
import type { LoadedPlayerIdentity } from './identity';
import { zSignature, type Signature } from './keys';
import type { Event, GameStatePublic } from './shared-state';

const EVENT_DOMAIN = 'event_v1';
const STATE_PUBLIC_DOMAIN = 'state_public_v1';

function lengthPrefixed(parts: ReadonlyArray<string | number>): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const p of parts) {
    const bytes = encoder.encode(String(p));
    const lenBuf = new ArrayBuffer(4);
    new DataView(lenBuf).setUint32(0, bytes.length, false);
    chunks.push(new Uint8Array(lenBuf), bytes);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(new ArrayBuffer(total));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export function canonicalEventBytes(e: Omit<Event, 'hostSignature'>): Uint8Array<ArrayBuffer> {
  return lengthPrefixed([
    EVENT_DOMAIN,
    e.id,
    e.seq,
    e.createdAt,
    e.gameType,
    e.kind,
    JSON.stringify(e.publicPayload),
    e.fromPlayerId ?? 'null'
  ]);
}

export async function signEvent(identity: LoadedPlayerIdentity, e: Omit<Event, 'hostSignature'>): Promise<Signature> {
  const canonical = canonicalEventBytes(e);
  const sigBuffer = await crypto.subtle.sign('Ed25519', identity.signing.privKey, canonical);
  return zSignature.parse(bytesToB64Url(new Uint8Array(sigBuffer)));
}

export function canonicalGameStatePublicBytes(
  s: Omit<GameStatePublic, 'hostSignature'>
): Uint8Array<ArrayBuffer> {
  return lengthPrefixed([STATE_PUBLIC_DOMAIN, s.id, s.seq, JSON.stringify(s.state)]);
}

export async function signGameStatePublic(
  identity: LoadedPlayerIdentity,
  s: Omit<GameStatePublic, 'hostSignature'>
): Promise<Signature> {
  const canonical = canonicalGameStatePublicBytes(s);
  const sigBuffer = await crypto.subtle.sign('Ed25519', identity.signing.privKey, canonical);
  return zSignature.parse(bytesToB64Url(new Uint8Array(sigBuffer)));
}

async function importEd25519Pub(pub: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', b64UrlToBytes(pub), { name: 'Ed25519' }, false, ['verify']);
}

export async function verifyEventSignature(hostSigningPubKey: string, e: Event): Promise<boolean> {
  const pub = await importEd25519Pub(hostSigningPubKey);
  const canonical = canonicalEventBytes({
    id: e.id,
    seq: e.seq,
    createdAt: e.createdAt,
    gameType: e.gameType,
    kind: e.kind,
    publicPayload: e.publicPayload,
    fromPlayerId: e.fromPlayerId
  });
  const sigBytes = b64UrlToBytes(e.hostSignature);
  return crypto.subtle.verify('Ed25519', pub, sigBytes, canonical);
}

export async function verifyGameStatePublicSignature(hostSigningPubKey: string, s: GameStatePublic): Promise<boolean> {
  const pub = await importEd25519Pub(hostSigningPubKey);
  const canonical = canonicalGameStatePublicBytes({ id: s.id, seq: s.seq, state: s.state });
  const sigBytes = b64UrlToBytes(s.hostSignature);
  return crypto.subtle.verify('Ed25519', pub, sigBytes, canonical);
}

