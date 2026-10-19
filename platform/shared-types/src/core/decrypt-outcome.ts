import type { LoadedGameHostKeypair, LoadedPlayerIdentity } from './identity';
import type { PlayerId } from './ids';
import type {
  EncryptedPayload,
  GameEncPubKeyBytes,
  PlayerEncPubKeyBytes,
  SecretMessageIv
} from './keys';
import type { SubmissionAadFields, HostMessageAadFields } from './encryption';
import {
  decryptHostMessageFromHost,
  decryptSubmissionFromPlayer
} from './encryption';
import { decryptLobbyChatMessageFromPlayer } from './lobby-chat';
import type { GameType } from './schemas';
import type { EventsPrivate, GameStatePrivate } from './shared-state';

/**
 * Tagged decrypt result for tooling / monitor UI — avoids throws crossing UI boundaries.
 */
export type DecryptOutcome =
  | { kind: 'decrypted'; via: 'playerPriv' | 'hostPriv' | 'plaintext'; value: unknown }
  | { kind: 'opaque'; reason: 'no-key' | 'aad-mismatch' | 'wrong-recipient' };

/** Reserved kind string for host→player payloads tied to `eventsPrivate` rows (v1). */
export const EVENTS_PRIVATE_PAYLOAD_KIND_V1 = 'events_private/v1' as const;

function opaqueFromError(_e: unknown): DecryptOutcome {
  return { kind: 'opaque', reason: 'aad-mismatch' };
}

export async function tryDecryptSubmissionFromPlayer(opts: {
  hostKeypair: LoadedGameHostKeypair;
  playerEncPubKey: PlayerEncPubKeyBytes;
  hostEncPubKey: GameEncPubKeyBytes;
  aad: SubmissionAadFields;
  iv: SecretMessageIv;
  toHostCiphertext: EncryptedPayload;
}): Promise<DecryptOutcome> {
  try {
    const bytes = await decryptSubmissionFromPlayer(opts);
    const text = new TextDecoder().decode(bytes);
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* binary or non-JSON plaintext */
    }
    return { kind: 'decrypted', via: 'hostPriv', value: parsed };
  } catch (e) {
    return opaqueFromError(e);
  }
}

export async function tryDecryptLobbyChatSubmissionFromPlayer(opts: Parameters<
  typeof decryptLobbyChatMessageFromPlayer
>[0]): Promise<DecryptOutcome> {
  try {
    const msg = await decryptLobbyChatMessageFromPlayer(opts);
    return { kind: 'decrypted', via: 'hostPriv', value: msg };
  } catch (e) {
    return opaqueFromError(e);
  }
}

export async function tryDecryptHostMessageForPlayer(opts: {
  identity: LoadedPlayerIdentity;
  hostEncPubKey: GameEncPubKeyBytes;
  aad: HostMessageAadFields;
  iv: SecretMessageIv;
  ciphertextToPlayer: EncryptedPayload;
}): Promise<DecryptOutcome> {
  try {
    const bytes = await decryptHostMessageFromHost(opts);
    const text = new TextDecoder().decode(bytes);
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* leave as utf8 failure → raw handled below */
    }
    return { kind: 'decrypted', via: 'playerPriv', value: parsed };
  } catch (e) {
    return opaqueFromError(e);
  }
}

/**
 * Attempt EventsPrivate decrypt using the same AAD shape as `gameStatePrivate` snapshots:
 * fixed `createdAt: 0` in AAD, `seq` + `kind` from the linked event.
 */
export async function tryDecryptEventsPrivateRow(opts: {
  row: EventsPrivate;
  eventSeq: number;
  gameType: GameType;
  identity: LoadedPlayerIdentity;
  hostEncPubKey: GameEncPubKeyBytes;
  playerEncPubKey: PlayerEncPubKeyBytes;
}): Promise<DecryptOutcome> {
  const createdAt = 0;
  return tryDecryptHostMessageForPlayer({
    identity: opts.identity,
    hostEncPubKey: opts.hostEncPubKey,
    aad: {
      toPlayerId: opts.row.playerId,
      createdAt,
      seq: opts.eventSeq,
      gameType: opts.gameType,
      kind: EVENTS_PRIVATE_PAYLOAD_KIND_V1,
      hostEncPubKey: opts.hostEncPubKey,
      playerEncPubKey: opts.playerEncPubKey
    },
    iv: opts.row.iv,
    ciphertextToPlayer: opts.row.ciphertextToPlayer
  });
}

export async function tryDecryptGameStatePrivateEncrypted(opts: {
  row: Extract<GameStatePrivate, { kind: 'encrypted' }>;
  seq: number;
  gameType: GameType;
  kind: string;
  identity: LoadedPlayerIdentity;
  hostEncPubKey: GameEncPubKeyBytes;
  playerEncPubKey: PlayerEncPubKeyBytes;
}): Promise<DecryptOutcome> {
  const createdAt = 0;
  return tryDecryptHostMessageForPlayer({
    identity: opts.identity,
    hostEncPubKey: opts.hostEncPubKey,
    aad: {
      toPlayerId: opts.row.id,
      createdAt,
      seq: opts.seq,
      gameType: opts.gameType,
      kind: opts.kind,
      hostEncPubKey: opts.hostEncPubKey,
      playerEncPubKey: opts.playerEncPubKey
    },
    iv: opts.row.iv,
    ciphertextToPlayer: opts.row.ciphertext
  });
}

/** Whether `row` targets `playerId` for host→player ciphertext semantics. */
export function isEncryptedPrivateForPlayer(row: GameStatePrivate, playerId: PlayerId): boolean {
  return row.kind === 'encrypted' && row.id === playerId;
}
