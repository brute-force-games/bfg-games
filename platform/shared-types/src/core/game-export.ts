import { b64UrlToBytes, bytesToB64Url } from './encoding';
import { verifyEventSignature } from './host-signatures';
import { GAME_FINALIZED_KIND } from './shared-state';
import { verifySubmissionSignature } from './submissions';
import type { EventId, PlayerId } from './ids';
import type { GameType, UnixMs } from './schemas';
import type { EventSeq, SubmissionNonce } from './shared-state';
import type {
  EncryptedPayload,
  GameEncPubKeyBytes,
  SecretMessageIv,
  Signature,
  SigningPubKeyBytes
} from './keys';

const HOST_ACCEPTED_SUBMISSION_KIND = 'host/accepted_submission' as const;

// ─── Export types ─────────────────────────────────────────────────────────────
// Plain (unbranded) types so the export is a clean JSON-serializable record.

export type GameExportEvent = {
  id: string;
  seq: number;
  createdAt: number;
  kind: string;
  publicPayload: unknown;
  fromPlayerId: string | null;
  hostSignature: string;
};

export type GameExportPlayer = {
  playerId: string;
  displayName: string;
  avatarColor: string;
  role: string;
  signingPubKey: string;
  encPubKey: string;
};

// Player-signed submission envelope plus host-attested decrypted plaintext.
// The signature covers the encrypted form; the plaintext lets an external
// verifier replay the game with a different engine implementation without
// holding the host's private key.
export type GameExportSubmission = {
  id: string;
  fromPlayerId: string;
  createdAt: number;
  nonce: number;
  gameType: string;
  kind: string;
  iv: string;
  toHostCiphertext: string;
  signature: string;
  // Base64 (standard, not URL-safe) of the decrypted plaintext bytes, as
  // attested by the host. External verifiers cannot independently re-decrypt
  // (that would require the host's private key), but they CAN verify the
  // player signature on the encrypted envelope, and trust-and-verify the
  // plaintext by replaying with a chosen engine and comparing event output.
  plaintextB64: string;
};

export type GameExportV2 = {
  exportVersion: 2;
  exportedAt: number;
  platform: {
    appVersion: string;
    gameType: string;
    gameVersion: string;
  };
  room: {
    roomId: string;
    gameConfig: unknown;
    seed: string;
    startedAt: number;
    finishedAt: number;
    outcome: 'win' | 'draw' | 'abandoned';
    winnerPlayerIds: string[];
    // Host's per-room X25519 encryption pubkey. Required to verify player
    // signatures on submissions (it's part of the canonical signed bytes).
    hostEncPubKey: string;
  };
  players: GameExportPlayer[];
  hostSigningPubKey: string;
  events: GameExportEvent[];
  submissions: GameExportSubmission[];
  exportSignature: string;
};

// Back-compat alias so existing imports keep working.
export type GameExportV1 = GameExportV2;

export type SubmissionVerificationResult = {
  id: string;
  signatureValid: boolean;
  // Whether a `host/accepted_submission` event references this submission.
  linked: boolean;
};

export type VerificationResult = {
  ok: boolean;
  exportSignatureValid: boolean;
  eventResults: Array<{ seq: number; id: string; signatureValid: boolean }>;
  submissionResults: SubmissionVerificationResult[];
  seqContiguous: boolean;
  hasFinalizedEvent: boolean;
  // Every host/accepted_submission event has a matching submission and
  // every submission is linked to one event.
  linkageComplete: boolean;
  errors: string[];
};

// ─── Canonical bytes for export signature ────────────────────────────────────
// Covers all fields except `exportSignature` itself, with sorted keys at every
// level for deterministic output across environments.

function sortedStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      );
    }
    return v;
  });
}

export function canonicalExportBytes(
  bundle: Omit<GameExportV2, 'exportSignature'>
): Uint8Array<ArrayBuffer> {
  const text = sortedStringify({
    events: bundle.events,
    exportedAt: bundle.exportedAt,
    exportVersion: bundle.exportVersion,
    hostSigningPubKey: bundle.hostSigningPubKey,
    platform: bundle.platform,
    players: bundle.players,
    room: bundle.room,
    submissions: bundle.submissions
  });
  return new TextEncoder().encode(text);
}

export async function signExport(
  signingPrivKey: CryptoKey,
  bundle: Omit<GameExportV2, 'exportSignature'>
): Promise<string> {
  const canonical = canonicalExportBytes(bundle);
  const sigBuffer = await crypto.subtle.sign('Ed25519', signingPrivKey, canonical);
  return bytesToB64Url(new Uint8Array(sigBuffer));
}

// ─── Verification ─────────────────────────────────────────────────────────────

export async function verifyGameExport(bundle: GameExportV2): Promise<VerificationResult> {
  const errors: string[] = [];

  if (bundle.exportVersion !== 2) {
    errors.push(`Unsupported export version: ${bundle.exportVersion} (expected 2)`);
    return {
      ok: false,
      exportSignatureValid: false,
      eventResults: [],
      submissionResults: [],
      seqContiguous: false,
      hasFinalizedEvent: false,
      linkageComplete: false,
      errors
    };
  }

  // 1. Verify the export signature over the whole bundle.
  let exportSignatureValid = false;
  try {
    const canonical = canonicalExportBytes(bundle);
    const pubKeyBytes = b64UrlToBytes(bundle.hostSigningPubKey);
    const pub = await crypto.subtle.importKey(
      'raw',
      pubKeyBytes,
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    const sigBytes = b64UrlToBytes(bundle.exportSignature);
    exportSignatureValid = await crypto.subtle.verify('Ed25519', pub, sigBytes, canonical);
    if (!exportSignatureValid) errors.push('Export signature is invalid');
  } catch (e) {
    errors.push(`Export signature check failed: ${String(e)}`);
  }

  // 2. Verify each event's host signature.
  const eventResults: Array<{ seq: number; id: string; signatureValid: boolean }> = [];
  for (const evt of bundle.events) {
    let signatureValid = false;
    try {
      signatureValid = await verifyEventSignature(bundle.hostSigningPubKey, {
        id: evt.id as EventId,
        seq: evt.seq as EventSeq,
        createdAt: evt.createdAt as UnixMs,
        kind: evt.kind,
        publicPayload: evt.publicPayload,
        fromPlayerId: evt.fromPlayerId as PlayerId | null,
        hostSignature: evt.hostSignature as Signature
      });
      if (!signatureValid) errors.push(`Event seq=${evt.seq} has invalid signature`);
    } catch (e) {
      errors.push(`Event seq=${evt.seq} signature check threw: ${String(e)}`);
    }
    eventResults.push({ seq: evt.seq, id: evt.id, signatureValid });
  }

  // 3. Verify each submission's player signature against the matching player's
  // signing pubkey. Build a player → signingPubKey lookup first.
  const signingPubKeyByPlayer = new Map<string, string>();
  for (const p of bundle.players) signingPubKeyByPlayer.set(p.playerId, p.signingPubKey);

  // Linkage: each submission should be referenced by exactly one
  // host/accepted_submission event (and vice versa).
  const ackedSubmissionIds = new Set<string>();
  for (const evt of bundle.events) {
    if (evt.kind !== HOST_ACCEPTED_SUBMISSION_KIND) continue;
    const p = evt.publicPayload as { submissionId?: unknown } | null;
    if (p && typeof p.submissionId === 'string') ackedSubmissionIds.add(p.submissionId);
  }

  const submissionResults: SubmissionVerificationResult[] = [];
  const seenSubmissionIds = new Set<string>();
  for (const s of bundle.submissions) {
    seenSubmissionIds.add(s.id);
    let signatureValid = false;
    const playerPubKey = signingPubKeyByPlayer.get(s.fromPlayerId);
    if (!playerPubKey) {
      errors.push(`Submission ${s.id} from unknown player ${s.fromPlayerId}`);
    } else {
      try {
        signatureValid = await verifySubmissionSignature(
          {
            id: s.id as never,
            fromPlayerId: s.fromPlayerId as PlayerId,
            createdAt: s.createdAt as UnixMs,
            nonce: s.nonce as SubmissionNonce,
            iv: s.iv as SecretMessageIv,
            toHostCiphertext: s.toHostCiphertext as EncryptedPayload,
            signature: s.signature as Signature,
            gameType: s.gameType as GameType,
            kind: s.kind
          },
          bundle.room.hostEncPubKey as GameEncPubKeyBytes,
          playerPubKey as SigningPubKeyBytes
        );
        if (!signatureValid) errors.push(`Submission ${s.id} has invalid player signature`);
      } catch (e) {
        errors.push(`Submission ${s.id} signature check threw: ${String(e)}`);
      }
    }
    const linked = ackedSubmissionIds.has(s.id);
    if (!linked) errors.push(`Submission ${s.id} has no host/accepted_submission event`);
    submissionResults.push({ id: s.id, signatureValid, linked });
  }

  // Each acked submissionId should appear in the submissions array.
  for (const ackedId of ackedSubmissionIds) {
    if (!seenSubmissionIds.has(ackedId)) {
      errors.push(`host/accepted_submission references missing submission ${ackedId}`);
    }
  }
  const linkageComplete =
    submissionResults.every((r) => r.linked) && ackedSubmissionIds.size === seenSubmissionIds.size;

  // 4. Check seq values are zero-based and contiguous.
  const seqContiguous =
    bundle.events.length === 0 ||
    bundle.events.every((evt, i) => {
      if (i === 0) return evt.seq === 0;
      const prev = bundle.events[i - 1];
      return prev !== undefined && evt.seq === prev.seq + 1;
    });
  if (!seqContiguous) errors.push('Event seq values are not contiguous from 0');

  // 5. Check for the finalization marker.
  const hasFinalizedEvent = bundle.events.some((evt) => evt.kind === GAME_FINALIZED_KIND);
  if (!hasFinalizedEvent) errors.push('Missing game/finalized event');

  return {
    ok: errors.length === 0,
    exportSignatureValid,
    eventResults,
    submissionResults,
    seqContiguous,
    hasFinalizedEvent,
    linkageComplete,
    errors
  };
}
