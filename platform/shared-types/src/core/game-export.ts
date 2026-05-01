import { b64UrlToBytes, bytesToB64Url } from './encoding';
import { verifyEventSignature } from './host-signatures';
import { GAME_FINALIZED_KIND } from './shared-state';
import type { EventId, PlayerId } from './ids';
import type { UnixMs } from './schemas';
import type { EventSeq } from './shared-state';
import type { Signature } from './keys';

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

export type GameExportV1 = {
  exportVersion: 1;
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
  };
  players: GameExportPlayer[];
  hostSigningPubKey: string;
  events: GameExportEvent[];
  exportSignature: string;
};

export type VerificationResult = {
  ok: boolean;
  exportSignatureValid: boolean;
  eventResults: Array<{ seq: number; id: string; signatureValid: boolean }>;
  seqContiguous: boolean;
  hasFinalizedEvent: boolean;
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
  bundle: Omit<GameExportV1, 'exportSignature'>
): Uint8Array<ArrayBuffer> {
  const text = sortedStringify({
    events: bundle.events,
    exportedAt: bundle.exportedAt,
    exportVersion: bundle.exportVersion,
    hostSigningPubKey: bundle.hostSigningPubKey,
    platform: bundle.platform,
    players: bundle.players,
    room: bundle.room
  });
  return new TextEncoder().encode(text);
}

export async function signExport(
  signingPrivKey: CryptoKey,
  bundle: Omit<GameExportV1, 'exportSignature'>
): Promise<string> {
  const canonical = canonicalExportBytes(bundle);
  const sigBuffer = await crypto.subtle.sign('Ed25519', signingPrivKey, canonical);
  return bytesToB64Url(new Uint8Array(sigBuffer));
}

// ─── Verification ─────────────────────────────────────────────────────────────

export async function verifyGameExport(bundle: GameExportV1): Promise<VerificationResult> {
  const errors: string[] = [];

  if (bundle.exportVersion !== 1) {
    errors.push(`Unknown export version: ${bundle.exportVersion}`);
    return {
      ok: false,
      exportSignatureValid: false,
      eventResults: [],
      seqContiguous: false,
      hasFinalizedEvent: false,
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

  // 3. Check seq values are zero-based and contiguous.
  const seqContiguous =
    bundle.events.length === 0 ||
    bundle.events.every((evt, i) => {
      if (i === 0) return evt.seq === 0;
      const prev = bundle.events[i - 1];
      return prev !== undefined && evt.seq === prev.seq + 1;
    });
  if (!seqContiguous) errors.push('Event seq values are not contiguous from 0');

  // 4. Check for the finalization marker.
  const hasFinalizedEvent = bundle.events.some((evt) => evt.kind === GAME_FINALIZED_KIND);
  if (!hasFinalizedEvent) errors.push('Missing game/finalized event');

  return {
    ok: errors.length === 0,
    exportSignatureValid,
    eventResults,
    seqContiguous,
    hasFinalizedEvent,
    errors
  };
}
