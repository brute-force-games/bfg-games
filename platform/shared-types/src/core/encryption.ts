import { b64UrlToBytes, bytesToB64Url } from './encoding';
import type { LoadedGameHostKeypair, LoadedPlayerIdentity } from './identity';
import type { PlayerId } from './ids';
import {
  zEncryptedPayload,
  zSecretMessageIv,
  type EncryptedPayload,
  type GameEncPubKeyBytes,
  type PlayerEncPubKeyBytes,
  type SecretMessageIv
} from './keys';
import type { GameType } from './schemas';

const SUBMISSION_AAD_DOMAIN = 'submission_aad_v1';
const SUBMISSION_KEY_DOMAIN = 'submission_key_v1';

const HOSTMSG_AAD_DOMAIN = 'hostmsg_aad_v1';
const HOSTMSG_KEY_DOMAIN = 'hostmsg_key_v1';

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

export type SubmissionAadFields = {
  fromPlayerId: PlayerId;
  createdAt: number;
  nonce: number;
  gameType: GameType;
  kind: string;
  hostEncPubKey: GameEncPubKeyBytes;
  playerEncPubKey: PlayerEncPubKeyBytes;
};

export function canonicalSubmissionAadBytes(f: SubmissionAadFields): Uint8Array<ArrayBuffer> {
  return lengthPrefixed([
    SUBMISSION_AAD_DOMAIN,
    f.fromPlayerId,
    f.createdAt,
    f.nonce,
    f.gameType,
    f.kind,
    f.hostEncPubKey,
    f.playerEncPubKey
  ]);
}

async function importX25519Pub(pub: PlayerEncPubKeyBytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', b64UrlToBytes(pub), { name: 'X25519' }, false, []);
}

async function importX25519PubHost(pub: GameEncPubKeyBytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', b64UrlToBytes(pub), { name: 'X25519' }, false, []);
}

async function deriveAesGcmKeyFromEcdh(opts: {
  sharedSecret: Uint8Array<ArrayBuffer>;
  salt: Uint8Array<ArrayBuffer>;
  info: Uint8Array<ArrayBuffer>;
  usage: KeyUsage[];
}): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey('raw', opts.sharedSecret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: opts.salt, info: opts.info },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    opts.usage
  );
}

export type EncryptToHostResult = {
  iv: SecretMessageIv;
  toHostCiphertext: EncryptedPayload;
};

export type HostMessageAadFields = {
  toPlayerId: PlayerId;
  createdAt: number;
  seq: number;
  gameType: GameType;
  kind: string;
  hostEncPubKey: GameEncPubKeyBytes;
  playerEncPubKey: PlayerEncPubKeyBytes;
};

export function canonicalHostMessageAadBytes(f: HostMessageAadFields): Uint8Array<ArrayBuffer> {
  return lengthPrefixed([
    HOSTMSG_AAD_DOMAIN,
    f.toPlayerId,
    f.createdAt,
    f.seq,
    f.gameType,
    f.kind,
    f.hostEncPubKey,
    f.playerEncPubKey
  ]);
}

export type EncryptToPlayerResult = {
  iv: SecretMessageIv;
  ciphertextToPlayer: EncryptedPayload;
};

/**
 * Encrypts a host-authored payload so only the target player can decrypt it.
 *
 * Key agreement: X25519 ECDH between hostEncPriv and playerEncPub.
 * Key derivation: HKDF-SHA256 → AES-GCM-256 key.
 * AEAD binding: canonical AAD bytes over immutable message context.
 */
export async function encryptHostMessageToPlayer(opts: {
  hostKeypair: LoadedGameHostKeypair;
  playerEncPubKey: PlayerEncPubKeyBytes;
  aad: Omit<HostMessageAadFields, 'hostEncPubKey'> & { hostEncPubKey: GameEncPubKeyBytes };
  plaintext: Uint8Array;
}): Promise<EncryptToPlayerResult> {
  const playerPubKey = await importX25519Pub(opts.playerEncPubKey);
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'X25519', public: playerPubKey },
    opts.hostKeypair.privKey,
    256
  );
  const sharedSecret = new Uint8Array(sharedBits as ArrayBuffer);

  const salt = b64UrlToBytes(opts.aad.hostEncPubKey);
  const info = lengthPrefixed([HOSTMSG_KEY_DOMAIN, opts.aad.toPlayerId, opts.aad.gameType, opts.aad.kind]);
  const aesKey = await deriveAesGcmKeyFromEcdh({ sharedSecret, salt, info, usage: ['encrypt'] });

  const ivBytes = new Uint8Array(12);
  crypto.getRandomValues(ivBytes);
  const iv = zSecretMessageIv.parse(bytesToB64Url(ivBytes));

  const aadBytes = canonicalHostMessageAadBytes({ ...opts.aad, playerEncPubKey: opts.playerEncPubKey });
  const plain = new Uint8Array(new ArrayBuffer(opts.plaintext.byteLength));
  plain.set(opts.plaintext);
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ivBytes, additionalData: aadBytes },
    aesKey,
    plain
  );

  return {
    iv,
    ciphertextToPlayer: zEncryptedPayload.parse(bytesToB64Url(new Uint8Array(cipherBuf)))
  };
}

/**
 * Decrypts a host-authored payload using the player's private key and the
 * room's published hostEncPubKey.
 */
export async function decryptHostMessageFromHost(opts: {
  identity: LoadedPlayerIdentity;
  hostEncPubKey: GameEncPubKeyBytes;
  aad: HostMessageAadFields;
  iv: SecretMessageIv;
  ciphertextToPlayer: EncryptedPayload;
}): Promise<Uint8Array<ArrayBuffer>> {
  const hostPubKey = await importX25519PubHost(opts.hostEncPubKey);
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'X25519', public: hostPubKey },
    opts.identity.enc.privKey,
    256
  );
  const sharedSecret = new Uint8Array(sharedBits as ArrayBuffer);

  const salt = b64UrlToBytes(opts.hostEncPubKey);
  const info = lengthPrefixed([HOSTMSG_KEY_DOMAIN, opts.aad.toPlayerId, opts.aad.gameType, opts.aad.kind]);
  const aesKey = await deriveAesGcmKeyFromEcdh({ sharedSecret, salt, info, usage: ['decrypt'] });

  const ivBytes = b64UrlToBytes(opts.iv);
  const aadBytes = canonicalHostMessageAadBytes(opts.aad);
  const cipherBytes = b64UrlToBytes(opts.ciphertextToPlayer);
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes, additionalData: aadBytes },
    aesKey,
    cipherBytes
  );
  return new Uint8Array(plainBuf as ArrayBuffer);
}

/**
 * Encrypts a move payload so only the host can decrypt it.
 *
 * Key agreement: X25519 ECDH between playerEncPriv and hostEncPub.
 * Key derivation: HKDF-SHA256 → AES-GCM-256 key.
 * AEAD binding: canonical AAD bytes over immutable submission context.
 */
export async function encryptSubmissionToHost(opts: {
  identity: LoadedPlayerIdentity;
  hostEncPubKey: GameEncPubKeyBytes;
  aad: Omit<SubmissionAadFields, 'playerEncPubKey'>;
  plaintext: Uint8Array;
}): Promise<EncryptToHostResult> {
  const hostPubKey = await importX25519PubHost(opts.hostEncPubKey);
  const sharedBits = await crypto.subtle.deriveBits({ name: 'X25519', public: hostPubKey }, opts.identity.enc.privKey, 256);
  const sharedSecret = new Uint8Array(sharedBits as ArrayBuffer);

  const salt = b64UrlToBytes(opts.hostEncPubKey);
  const info = lengthPrefixed([SUBMISSION_KEY_DOMAIN, opts.aad.fromPlayerId, opts.aad.gameType, opts.aad.kind]);
  const aesKey = await deriveAesGcmKeyFromEcdh({ sharedSecret, salt, info, usage: ['encrypt'] });

  const ivBytes = new Uint8Array(12);
  crypto.getRandomValues(ivBytes);
  const iv = zSecretMessageIv.parse(bytesToB64Url(ivBytes));

  const aadBytes = canonicalSubmissionAadBytes({ ...opts.aad, playerEncPubKey: opts.identity.enc.pub });
  // Copy into an explicit ArrayBuffer-backed view to satisfy WebCrypto's
  // narrowed BufferSource typing under TS 6 (avoid SharedArrayBuffer).
  const plain = new Uint8Array(new ArrayBuffer(opts.plaintext.byteLength));
  plain.set(opts.plaintext);
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ivBytes, additionalData: aadBytes },
    aesKey,
    plain
  );

  return {
    iv,
    toHostCiphertext: zEncryptedPayload.parse(bytesToB64Url(new Uint8Array(cipherBuf)))
  };
}

/**
 * Decrypts a player submission payload using the host's private key and the
 * player's published encryption public key.
 */
export async function decryptSubmissionFromPlayer(opts: {
  hostKeypair: LoadedGameHostKeypair;
  playerEncPubKey: PlayerEncPubKeyBytes;
  hostEncPubKey: GameEncPubKeyBytes;
  aad: SubmissionAadFields;
  iv: SecretMessageIv;
  toHostCiphertext: EncryptedPayload;
}): Promise<Uint8Array<ArrayBuffer>> {
  const playerPubKey = await importX25519Pub(opts.playerEncPubKey);
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'X25519', public: playerPubKey },
    opts.hostKeypair.privKey,
    256
  );
  const sharedSecret = new Uint8Array(sharedBits as ArrayBuffer);

  const salt = b64UrlToBytes(opts.hostEncPubKey);
  const info = lengthPrefixed([SUBMISSION_KEY_DOMAIN, opts.aad.fromPlayerId, opts.aad.gameType, opts.aad.kind]);
  const aesKey = await deriveAesGcmKeyFromEcdh({ sharedSecret, salt, info, usage: ['decrypt'] });

  const ivBytes = b64UrlToBytes(opts.iv);
  const aadBytes = canonicalSubmissionAadBytes(opts.aad);
  const cipherBytes = b64UrlToBytes(opts.toHostCiphertext);
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes, additionalData: aadBytes },
    aesKey,
    cipherBytes
  );
  return new Uint8Array(plainBuf as ArrayBuffer);
}

