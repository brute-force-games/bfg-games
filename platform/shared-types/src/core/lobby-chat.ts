import { z } from 'zod';

import { b64UrlToBytes, bytesToB64Url } from './encoding';
import type { LoadedGameHostKeypair, LoadedPlayerIdentity } from './identity';
import type { PlayerId } from './ids';
import {
  zEncryptedPayload,
  zSecretMessageIv,
  zSignature,
  type EncryptedPayload,
  type GameEncPubKeyBytes,
  type PlayerEncPubKeyBytes,
  type SecretMessageIv,
  type Signature,
  type SigningPubKeyBytes
} from './keys';
import { zChatEventId, zChatSubmissionId, zPlayerId, type ChatEventId, type ChatSubmissionId } from './ids';
import { zUnixMs, type UnixMs } from './schemas';
import { zEventSeq, zSubmissionNonce, type SubmissionNonce } from './shared-state';

// Uses the same WebCrypto primitives as game submissions, but dedicated domains
// so lobby chat keys/signatures cannot be confused with game protocols.
const CHAT_SUBMISSION_DOMAIN = 'lobby_chat_submission_v1';
const CHAT_EVENT_DOMAIN = 'lobby_chat_event_v1';
const CHAT_AAD_DOMAIN = 'lobby_chat_aad_v1';
const CHAT_KEY_DOMAIN = 'lobby_chat_key_v1';

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

// ─── Zod schemas ────────────────────────────────────────────────────────────

export const zLobbyChatMessage = z
  .object({
    text: z.string().min(1).max(500)
  });
export type LobbyChatMessage = z.infer<typeof zLobbyChatMessage>;

export const zLobbyChatSubmission = z
  .object({
    id: zChatSubmissionId,
    fromPlayerId: zPlayerId,
    toHostCiphertext: zEncryptedPayload,
    iv: zSecretMessageIv,
    signature: zSignature,
    nonce: zSubmissionNonce,
    createdAt: zUnixMs
  });
export type LobbyChatSubmission = z.infer<typeof zLobbyChatSubmission>;

export const zLobbyChatEvent = z
  .object({
    id: zChatEventId,
    seq: zEventSeq,
    createdAt: zUnixMs,
    fromPlayerId: zPlayerId,
    text: z.string().min(1).max(500),
    hostSignature: zSignature
  });
export type LobbyChatEvent = z.infer<typeof zLobbyChatEvent>;

// ─── Submission signing & verification ─────────────────────────────────────

export type LobbyChatSubmissionSignableFields = {
  fromPlayerId: PlayerId;
  createdAt: UnixMs;
  nonce: SubmissionNonce;
  iv: SecretMessageIv;
  toHostCiphertext: EncryptedPayload;
  hostEncPubKey: GameEncPubKeyBytes;
};

export function canonicalLobbyChatSubmissionBytes(
  s: LobbyChatSubmissionSignableFields
): Uint8Array<ArrayBuffer> {
  return lengthPrefixed([
    CHAT_SUBMISSION_DOMAIN,
    s.fromPlayerId,
    s.createdAt,
    s.nonce,
    s.iv,
    s.toHostCiphertext,
    s.hostEncPubKey
  ]);
}

export async function signLobbyChatSubmission(
  identity: LoadedPlayerIdentity,
  fields: LobbyChatSubmissionSignableFields
): Promise<Signature> {
  if (fields.fromPlayerId !== identity.playerId) {
    throw new Error(
      `signLobbyChatSubmission: fromPlayerId (${fields.fromPlayerId}) does not match identity.playerId (${identity.playerId})`
    );
  }
  const canonical = canonicalLobbyChatSubmissionBytes(fields);
  const sigBuffer = await crypto.subtle.sign('Ed25519', identity.signing.privKey, canonical);
  return zSignature.parse(bytesToB64Url(new Uint8Array(sigBuffer)));
}

async function importEd25519Pub(pub: SigningPubKeyBytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', b64UrlToBytes(pub), { name: 'Ed25519' }, false, ['verify']);
}

export async function verifyLobbyChatSubmissionSignature(opts: {
  submission: LobbyChatSubmission;
  hostEncPubKey: GameEncPubKeyBytes;
  playerSigningPubKey: SigningPubKeyBytes;
}): Promise<boolean> {
  const pubKey = await importEd25519Pub(opts.playerSigningPubKey);
  const canonical = canonicalLobbyChatSubmissionBytes({
    fromPlayerId: opts.submission.fromPlayerId,
    createdAt: opts.submission.createdAt,
    nonce: opts.submission.nonce,
    iv: opts.submission.iv,
    toHostCiphertext: opts.submission.toHostCiphertext,
    hostEncPubKey: opts.hostEncPubKey
  });
  const sigBytes = b64UrlToBytes(opts.submission.signature);
  return crypto.subtle.verify('Ed25519', pubKey, sigBytes, canonical);
}

export type LobbyChatRejectReason =
  | 'unknown_player'
  | 'bad_signature'
  | 'replay_or_old_nonce';

export type LobbyChatValidationResult =
  | { ok: true }
  | { ok: false; reason: LobbyChatRejectReason };

export class HostLobbyChatValidator {
  private readonly lastAcceptedNonce = new Map<PlayerId, number>();
  private readonly hostEncPubKey: GameEncPubKeyBytes;
  private readonly getPlayerSigningPubKey: (playerId: PlayerId) => SigningPubKeyBytes | null;

  constructor(opts: {
    hostEncPubKey: GameEncPubKeyBytes;
    getPlayerSigningPubKey: (playerId: PlayerId) => SigningPubKeyBytes | null;
  }) {
    this.hostEncPubKey = opts.hostEncPubKey;
    this.getPlayerSigningPubKey = opts.getPlayerSigningPubKey;
  }

  async validate(submission: LobbyChatSubmission): Promise<LobbyChatValidationResult> {
    const pubKey = this.getPlayerSigningPubKey(submission.fromPlayerId);
    if (!pubKey) return { ok: false, reason: 'unknown_player' };

    const sigOk = await verifyLobbyChatSubmissionSignature({
      submission,
      hostEncPubKey: this.hostEncPubKey,
      playerSigningPubKey: pubKey
    });
    if (!sigOk) return { ok: false, reason: 'bad_signature' };

    const lastNonce = this.lastAcceptedNonce.get(submission.fromPlayerId) ?? -1;
    if (submission.nonce <= lastNonce) return { ok: false, reason: 'replay_or_old_nonce' };

    this.lastAcceptedNonce.set(submission.fromPlayerId, submission.nonce);
    return { ok: true };
  }
}

// ─── Chat message encryption (player → host) ────────────────────────────────

export type LobbyChatAadFields = {
  fromPlayerId: PlayerId;
  createdAt: number;
  nonce: number;
  hostEncPubKey: GameEncPubKeyBytes;
  playerEncPubKey: PlayerEncPubKeyBytes;
};

export function canonicalLobbyChatAadBytes(f: LobbyChatAadFields): Uint8Array<ArrayBuffer> {
  return lengthPrefixed([CHAT_AAD_DOMAIN, f.fromPlayerId, f.createdAt, f.nonce, f.hostEncPubKey, f.playerEncPubKey]);
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

export async function encryptLobbyChatMessageToHost(opts: {
  identity: LoadedPlayerIdentity;
  hostEncPubKey: GameEncPubKeyBytes;
  fromPlayerId: PlayerId;
  createdAt: number;
  nonce: number;
  message: LobbyChatMessage;
}): Promise<{ iv: SecretMessageIv; toHostCiphertext: EncryptedPayload }> {
  const hostPubKey = await importX25519PubHost(opts.hostEncPubKey);
  const sharedBits = await crypto.subtle.deriveBits({ name: 'X25519', public: hostPubKey }, opts.identity.enc.privKey, 256);
  const sharedSecret = new Uint8Array(sharedBits as ArrayBuffer);

  const salt = b64UrlToBytes(opts.hostEncPubKey);
  const info = lengthPrefixed([CHAT_KEY_DOMAIN, opts.fromPlayerId]);
  const aesKey = await deriveAesGcmKeyFromEcdh({ sharedSecret, salt, info, usage: ['encrypt'] });

  const ivBytes = new Uint8Array(12);
  crypto.getRandomValues(ivBytes);
  const iv = zSecretMessageIv.parse(bytesToB64Url(ivBytes));

  const aad = canonicalLobbyChatAadBytes({
    fromPlayerId: opts.fromPlayerId,
    createdAt: opts.createdAt,
    nonce: opts.nonce,
    hostEncPubKey: opts.hostEncPubKey,
    playerEncPubKey: opts.identity.enc.pub
  });

  const plaintextBytes = new TextEncoder().encode(JSON.stringify(opts.message));
  const plain = new Uint8Array(new ArrayBuffer(plaintextBytes.byteLength));
  plain.set(plaintextBytes);
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivBytes, additionalData: aad }, aesKey, plain);

  return { iv, toHostCiphertext: zEncryptedPayload.parse(bytesToB64Url(new Uint8Array(cipherBuf))) };
}

export async function decryptLobbyChatMessageFromPlayer(opts: {
  hostKeypair: LoadedGameHostKeypair;
  playerEncPubKey: PlayerEncPubKeyBytes;
  hostEncPubKey: GameEncPubKeyBytes;
  fromPlayerId: PlayerId;
  createdAt: number;
  nonce: number;
  iv: SecretMessageIv;
  toHostCiphertext: EncryptedPayload;
}): Promise<LobbyChatMessage> {
  const playerPubKey = await importX25519Pub(opts.playerEncPubKey);
  const sharedBits = await crypto.subtle.deriveBits({ name: 'X25519', public: playerPubKey }, opts.hostKeypair.privKey, 256);
  const sharedSecret = new Uint8Array(sharedBits as ArrayBuffer);

  const salt = b64UrlToBytes(opts.hostEncPubKey);
  const info = lengthPrefixed([CHAT_KEY_DOMAIN, opts.fromPlayerId]);
  const aesKey = await deriveAesGcmKeyFromEcdh({ sharedSecret, salt, info, usage: ['decrypt'] });

  const aad = canonicalLobbyChatAadBytes({
    fromPlayerId: opts.fromPlayerId,
    createdAt: opts.createdAt,
    nonce: opts.nonce,
    hostEncPubKey: opts.hostEncPubKey,
    playerEncPubKey: opts.playerEncPubKey
  });

  const ivBytes = b64UrlToBytes(opts.iv);
  const cipherBytes = b64UrlToBytes(opts.toHostCiphertext);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes, additionalData: aad }, aesKey, cipherBytes);
  const text = new TextDecoder().decode(new Uint8Array(plainBuf as ArrayBuffer));
  return zLobbyChatMessage.parse(JSON.parse(text));
}

// ─── Host event signing ─────────────────────────────────────────────────────

export function canonicalLobbyChatEventBytes(e: Omit<LobbyChatEvent, 'hostSignature'>): Uint8Array<ArrayBuffer> {
  return lengthPrefixed([CHAT_EVENT_DOMAIN, e.id, e.seq, e.createdAt, e.fromPlayerId, e.text]);
}

export async function signLobbyChatEvent(
  hostIdentity: LoadedPlayerIdentity,
  e: Omit<LobbyChatEvent, 'hostSignature'>
): Promise<Signature> {
  const canonical = canonicalLobbyChatEventBytes(e);
  const sigBuffer = await crypto.subtle.sign('Ed25519', hostIdentity.signing.privKey, canonical);
  return zSignature.parse(bytesToB64Url(new Uint8Array(sigBuffer)));
}

