import { b64UrlToBytes, bytesToB64Url } from './encoding';
import type { LoadedPlayerIdentity } from './identity';
import type { PlayerId } from './ids';
import {
  zSignature,
  type EncryptedPayload,
  type GameEncPubKeyBytes,
  type SecretMessageIv,
  type Signature,
  type SigningPubKeyBytes
} from './keys';
import type { GameType, UnixMs } from './schemas';
import type { Submission, SubmissionNonce } from './shared-state';

// Domain-separator string. Bump the version suffix when the field set or
// ordering changes so old signatures fail loudly under a new protocol.
const SUBMISSION_DOMAIN = 'submission_v1';

// Length-prefixed concatenation: each part is encoded as UTF-8 bytes prefixed
// by a 4-byte big-endian length. Unambiguous regardless of field contents.
// Returns a `Uint8Array<ArrayBuffer>` (rather than the wider `ArrayBufferLike`)
// so the result satisfies WebCrypto's `BufferSource` parameter type.
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

export type SubmissionSignableFields = {
  fromPlayerId: PlayerId;
  createdAt: UnixMs;
  nonce: SubmissionNonce;
  iv: SecretMessageIv;
  toHostCiphertext: EncryptedPayload;
  gameType: GameType;
  kind: string;
  // Binds the signature to a specific host encryption key. Once we add
  // `room.hostKeyVersion`, that should be included too — for v1 the pubkey
  // serves both as identity and version since rotation also changes it.
  hostEncPubKey: GameEncPubKeyBytes;
};

export function canonicalSubmissionBytes(
  s: SubmissionSignableFields
): Uint8Array<ArrayBuffer> {
  return lengthPrefixed([
    SUBMISSION_DOMAIN,
    s.fromPlayerId,
    s.createdAt,
    s.nonce,
    s.iv,
    s.toHostCiphertext,
    s.gameType,
    s.kind,
    s.hostEncPubKey
  ]);
}

// ─── Player side: produce a signature ──────────────────────────────────────

export async function signSubmission(
  identity: LoadedPlayerIdentity,
  fields: SubmissionSignableFields
): Promise<Signature> {
  if (fields.fromPlayerId !== identity.playerId) {
    throw new Error(
      `signSubmission: fromPlayerId (${fields.fromPlayerId}) does not match identity.playerId (${identity.playerId})`
    );
  }
  const canonical = canonicalSubmissionBytes(fields);
  const sigBuffer = await crypto.subtle.sign('Ed25519', identity.signing.privKey, canonical);
  return zSignature.parse(bytesToB64Url(new Uint8Array(sigBuffer)));
}

// ─── Host side: verify a signature ─────────────────────────────────────────

async function importEd25519Pub(pub: SigningPubKeyBytes): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    b64UrlToBytes(pub),
    { name: 'Ed25519' },
    false,
    ['verify']
  );
}

export async function verifySubmissionSignature(
  submission: Submission,
  hostEncPubKey: GameEncPubKeyBytes,
  playerSigningPubKey: SigningPubKeyBytes
): Promise<boolean> {
  const pubKey = await importEd25519Pub(playerSigningPubKey);
  const canonical = canonicalSubmissionBytes({
    fromPlayerId: submission.fromPlayerId,
    createdAt: submission.createdAt,
    nonce: submission.nonce,
    iv: submission.iv,
    toHostCiphertext: submission.toHostCiphertext,
    gameType: submission.gameType,
    kind: submission.kind,
    hostEncPubKey
  });
  const sigBytes = b64UrlToBytes(submission.signature);
  return crypto.subtle.verify('Ed25519', pubKey, sigBytes, canonical);
}

// ─── Host-side validator: signature + replay (per-player monotonic nonce) ──

export type SubmissionRejectReason =
  | 'unknown_player'
  | 'bad_signature'
  | 'replay_or_old_nonce';

export type SubmissionValidationResult =
  | { ok: true }
  | { ok: false; reason: SubmissionRejectReason };

export class HostSubmissionValidator {
  // Per-player highest accepted nonce. In-memory only for v1; a host restart
  // resets this to empty. To restore on restart, replay the events log and
  // prime per-player nonces (events should carry the source nonce —
  // currently TODO, see SHARED-STATES-PLAN).
  private readonly lastAcceptedNonce = new Map<PlayerId, number>();
  private readonly hostEncPubKey: GameEncPubKeyBytes;
  private readonly getPlayerSigningPubKey: (
    playerId: PlayerId
  ) => SigningPubKeyBytes | null;

  constructor(opts: {
    hostEncPubKey: GameEncPubKeyBytes;
    getPlayerSigningPubKey: (playerId: PlayerId) => SigningPubKeyBytes | null;
  }) {
    this.hostEncPubKey = opts.hostEncPubKey;
    this.getPlayerSigningPubKey = opts.getPlayerSigningPubKey;
  }

  // Validates: known player → signature → nonce monotonicity. Records the
  // nonce on success so future submissions with same/lower nonce are rejected.
  async validate(submission: Submission): Promise<SubmissionValidationResult> {
    const pubKey = this.getPlayerSigningPubKey(submission.fromPlayerId);
    if (!pubKey) return { ok: false, reason: 'unknown_player' };

    const sigOk = await verifySubmissionSignature(
      submission,
      this.hostEncPubKey,
      pubKey
    );
    if (!sigOk) return { ok: false, reason: 'bad_signature' };

    const lastNonce = this.lastAcceptedNonce.get(submission.fromPlayerId) ?? -1;
    if (submission.nonce <= lastNonce) {
      return { ok: false, reason: 'replay_or_old_nonce' };
    }
    this.lastAcceptedNonce.set(submission.fromPlayerId, submission.nonce);
    return { ok: true };
  }

  // For host restart / handover: feed accepted nonces from the event log.
  primeNonce(playerId: PlayerId, nonce: number): void {
    const current = this.lastAcceptedNonce.get(playerId) ?? -1;
    if (nonce > current) this.lastAcceptedNonce.set(playerId, nonce);
  }

  snapshotNonces(): ReadonlyMap<PlayerId, number> {
    return new Map(this.lastAcceptedNonce);
  }
}
