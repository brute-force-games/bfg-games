import type {
  DecryptOutcome,
  EventsPrivate,
  GameStatePrivate,
  LoadedGameHostKeypair,
  LoadedPlayerIdentity,
  LobbyChatSubmission,
  Room,
  Submission,
  UserGameRoleKind
} from '@brute-force-games/shared-types';
import {
  tryDecryptEventsPrivateRow,
  tryDecryptGameStatePrivateEncrypted,
  tryDecryptLobbyChatSubmissionFromPlayer,
  tryDecryptSubmissionFromPlayer
} from '@brute-force-games/shared-types';

import type { Player } from '@brute-force-games/multiplayer-types';

import { guessPrivateSnapshotKind } from './privateSnapshotKind';
import { simulatedUsesHostPriv, simulatedUsesPlayerPriv } from './simulatedRole';

export type { DecryptOutcome };

function noKey(): DecryptOutcome {
  return { kind: 'opaque', reason: 'no-key' };
}

function wrongRecipient(): DecryptOutcome {
  return { kind: 'opaque', reason: 'wrong-recipient' };
}

export async function decryptSubmissionForSimulatedRole(opts: {
  submission: Submission;
  room: Room;
  players: Player[];
  role: UserGameRoleKind;
  hostKeypair: LoadedGameHostKeypair | null;
}): Promise<DecryptOutcome> {
  const { submission, room, players, role, hostKeypair } = opts;
  if (!simulatedUsesHostPriv(role)) return noKey();
  if (!hostKeypair) return noKey();

  const from = players.find((p) => p.id === submission.fromPlayerId);
  if (!from) return wrongRecipient();

  return tryDecryptSubmissionFromPlayer({
    hostKeypair,
    playerEncPubKey: from.encPubKey,
    hostEncPubKey: room.hostEncPubKey,
    aad: {
      fromPlayerId: submission.fromPlayerId,
      createdAt: submission.createdAt,
      nonce: submission.nonce,
      gameType: submission.gameType,
      kind: submission.kind,
      hostEncPubKey: room.hostEncPubKey,
      playerEncPubKey: from.encPubKey
    },
    iv: submission.iv,
    toHostCiphertext: submission.toHostCiphertext
  });
}

export async function decryptLobbyChatSubmissionForSimulatedRole(opts: {
  submission: LobbyChatSubmission;
  room: Room;
  players: Player[];
  role: UserGameRoleKind;
  hostKeypair: LoadedGameHostKeypair | null;
}): Promise<DecryptOutcome> {
  const { submission, room, players, role, hostKeypair } = opts;
  if (!simulatedUsesHostPriv(role)) return noKey();
  if (!hostKeypair) return noKey();

  const from = players.find((p) => p.id === submission.fromPlayerId);
  if (!from) return wrongRecipient();

  return tryDecryptLobbyChatSubmissionFromPlayer({
    hostKeypair,
    playerEncPubKey: from.encPubKey,
    hostEncPubKey: room.hostEncPubKey,
    fromPlayerId: submission.fromPlayerId,
    createdAt: submission.createdAt,
    nonce: submission.nonce,
    iv: submission.iv,
    toHostCiphertext: submission.toHostCiphertext
  });
}

export async function decryptGameStatePrivateForSimulatedRole(opts: {
  row: GameStatePrivate;
  room: Room;
  players: Player[];
  role: UserGameRoleKind;
  identity: LoadedPlayerIdentity;
}): Promise<DecryptOutcome> {
  const { row, room, players, role, identity } = opts;

  if (row.kind === 'plain') {
    return { kind: 'decrypted', via: 'plaintext', value: row.state };
  }

  if (!simulatedUsesPlayerPriv(role)) return noKey();

  if (row.id !== identity.playerId) return wrongRecipient();

  const selfPlayer = players.find((p) => p.id === identity.playerId);
  if (!selfPlayer) return wrongRecipient();

  const kindStr = guessPrivateSnapshotKind(room.gameType);
  if (!kindStr) {
    return { kind: 'opaque', reason: 'aad-mismatch' };
  }

  return tryDecryptGameStatePrivateEncrypted({
    row,
    seq: row.seq,
    gameType: room.gameType,
    kind: kindStr,
    identity,
    hostEncPubKey: room.hostEncPubKey,
    playerEncPubKey: selfPlayer.encPubKey
  });
}

export async function decryptEventsPrivateForSimulatedRole(opts: {
  row: EventsPrivate;
  room: Room;
  players: Player[];
  role: UserGameRoleKind;
  identity: LoadedPlayerIdentity;
  eventSeq: number | null;
}): Promise<DecryptOutcome> {
  const { row, room, players, role, identity, eventSeq } = opts;

  if (!simulatedUsesPlayerPriv(role)) return noKey();
  if (row.playerId !== identity.playerId) return wrongRecipient();
  if (eventSeq === null) return { kind: 'opaque', reason: 'aad-mismatch' };

  const recipient = players.find((p) => p.id === row.playerId);
  if (!recipient) return wrongRecipient();

  return tryDecryptEventsPrivateRow({
    row,
    eventSeq,
    gameType: room.gameType,
    identity,
    hostEncPubKey: room.hostEncPubKey,
    playerEncPubKey: recipient.encPubKey
  });
}

// ─── Peek (local client keys — not simulated role) ─────────────────────────

export async function peekDecryptSubmission(opts: {
  submission: Submission;
  room: Room;
  players: Player[];
  hostKeypair: LoadedGameHostKeypair | null;
}): Promise<DecryptOutcome | null> {
  if (!opts.hostKeypair) return null;
  return decryptSubmissionForSimulatedRole({
    submission: opts.submission,
    room: opts.room,
    players: opts.players,
    role: 'host_moderator',
    hostKeypair: opts.hostKeypair
  });
}

export async function peekDecryptLobbyChat(opts: {
  submission: LobbyChatSubmission;
  room: Room;
  players: Player[];
  hostKeypair: LoadedGameHostKeypair | null;
}): Promise<DecryptOutcome | null> {
  if (!opts.hostKeypair) return null;
  return decryptLobbyChatSubmissionForSimulatedRole({
    submission: opts.submission,
    room: opts.room,
    players: opts.players,
    role: 'host_moderator',
    hostKeypair: opts.hostKeypair
  });
}

export async function peekDecryptGameStatePrivate(opts: {
  row: GameStatePrivate;
  room: Room;
  players: Player[];
  identity: LoadedPlayerIdentity;
}): Promise<DecryptOutcome | null> {
  return decryptGameStatePrivateForSimulatedRole({
    row: opts.row,
    room: opts.room,
    players: opts.players,
    role: 'host_player',
    identity: opts.identity
  });
}

export async function peekDecryptEventsPrivate(opts: {
  row: EventsPrivate;
  room: Room;
  players: Player[];
  identity: LoadedPlayerIdentity;
  eventSeq: number | null;
}): Promise<DecryptOutcome | null> {
  return decryptEventsPrivateForSimulatedRole({
    row: opts.row,
    room: opts.room,
    players: opts.players,
    role: 'host_player',
    identity: opts.identity,
    eventSeq: opts.eventSeq
  });
}
