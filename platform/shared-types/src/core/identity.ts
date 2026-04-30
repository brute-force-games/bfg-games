import { z } from 'zod';

import { bytesToB64Url } from './encoding';
import { zPlayerId, type PlayerId } from './ids';
import {
  zEd25519PrivJwk,
  zGameEncPubKeyBytes,
  zPlayerEncPubKeyBytes,
  zSigningPubKeyBytes,
  zX25519PrivJwk,
  type Ed25519PrivJwk,
  type GameEncPubKeyBytes,
  type PlayerEncPubKeyBytes,
  type SigningPubKeyBytes,
  type X25519PrivJwk
} from './keys';

// ─── Persisted (serializable) identity ──────────────────────────────────────
// Stored in LocalStore. Public bytes are published to peers; private JWKs
// stay on this device.

export const zPlayerIdentity = z
  .object({
    playerId: zPlayerId,
    signing: z.object({
      pub: zSigningPubKeyBytes,
      privJwk: zEd25519PrivJwk
    }),
    enc: z.object({
      pub: zPlayerEncPubKeyBytes,
      privJwk: zX25519PrivJwk
    })
  })
  .brand<'PlayerIdentity'>();
export type PlayerIdentity = z.infer<typeof zPlayerIdentity>;

// Per-room host encryption keypair. The host generates a fresh one per room
// (or per host-handover); the private JWK never leaves the host.
export const zGameHostKeypair = z
  .object({
    pub: zGameEncPubKeyBytes,
    privJwk: zX25519PrivJwk
  })
  .brand<'GameHostKeypair'>();
export type GameHostKeypair = z.infer<typeof zGameHostKeypair>;

// ─── Loaded (runtime) identity ──────────────────────────────────────────────
// Holds imported CryptoKey objects ready for sign / deriveBits. Never
// serialized; the brand is TS-only.

declare const __loadedIdentityBrand: unique symbol;
declare const __loadedHostKeypairBrand: unique symbol;

export type LoadedPlayerIdentity = {
  readonly [__loadedIdentityBrand]: 'LoadedPlayerIdentity';
  readonly playerId: PlayerId;
  readonly signing: {
    readonly pub: SigningPubKeyBytes;
    readonly privKey: CryptoKey;
  };
  readonly enc: {
    readonly pub: PlayerEncPubKeyBytes;
    readonly privKey: CryptoKey;
  };
};

export type LoadedGameHostKeypair = {
  readonly [__loadedHostKeypairBrand]: 'LoadedGameHostKeypair';
  readonly pub: GameEncPubKeyBytes;
  readonly privKey: CryptoKey;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function makePlayerId(): PlayerId {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return zPlayerId.parse(`plyr_${bytesToB64Url(bytes)}`);
}

async function generateOkpKeypair(
  algName: 'Ed25519' | 'X25519'
): Promise<{ rawPub: Uint8Array; privJwk: JsonWebKey }> {
  const usages: KeyUsage[] =
    algName === 'Ed25519' ? ['sign', 'verify'] : ['deriveBits', 'deriveKey'];
  const pair = (await crypto.subtle.generateKey(
    { name: algName },
    true,
    usages
  )) as CryptoKeyPair;
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { rawPub, privJwk };
}

async function importEd25519Priv(jwk: Ed25519PrivJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    jwk as unknown as JsonWebKey,
    { name: 'Ed25519' },
    false,
    ['sign']
  );
}

async function importX25519Priv(jwk: X25519PrivJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    jwk as unknown as JsonWebKey,
    { name: 'X25519' },
    false,
    ['deriveBits', 'deriveKey']
  );
}

// ─── Generators ─────────────────────────────────────────────────────────────

export async function generatePlayerIdentity(): Promise<PlayerIdentity> {
  const sign = await generateOkpKeypair('Ed25519');
  const enc = await generateOkpKeypair('X25519');
  return zPlayerIdentity.parse({
    playerId: makePlayerId(),
    signing: { pub: bytesToB64Url(sign.rawPub), privJwk: sign.privJwk },
    enc: { pub: bytesToB64Url(enc.rawPub), privJwk: enc.privJwk }
  });
}

export async function generateGameHostKeypair(): Promise<GameHostKeypair> {
  const { rawPub, privJwk } = await generateOkpKeypair('X25519');
  return zGameHostKeypair.parse({
    pub: bytesToB64Url(rawPub),
    privJwk
  });
}

// ─── Loaders (deserialize → import CryptoKeys) ──────────────────────────────

export async function loadPlayerIdentity(
  identity: PlayerIdentity
): Promise<LoadedPlayerIdentity> {
  const [signingPriv, encPriv] = await Promise.all([
    importEd25519Priv(identity.signing.privJwk),
    importX25519Priv(identity.enc.privJwk)
  ]);
  return {
    playerId: identity.playerId,
    signing: { pub: identity.signing.pub, privKey: signingPriv },
    enc: { pub: identity.enc.pub, privKey: encPriv }
  } as LoadedPlayerIdentity;
}

export async function loadGameHostKeypair(
  keypair: GameHostKeypair
): Promise<LoadedGameHostKeypair> {
  const privKey = await importX25519Priv(keypair.privJwk);
  return { pub: keypair.pub, privKey } as LoadedGameHostKeypair;
}
