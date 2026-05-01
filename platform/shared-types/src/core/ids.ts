import { z } from 'zod';

export const PREFIX = {
  player: 'plyr',
  room: 'room',
  game: 'game',
  round: 'rnd',
  submission: 'sub',
  secretPool: 'spol',
  event: 'evt',
  eventsPrivate: 'epvt',
  chatSubmission: 'csub',
  inviteCode: 'ivc',
  chatEvent: 'cevt'
} as const;

function hasPrefix(prefix: string, s: string): boolean {
  return s.startsWith(prefix + '_');
}

export const zPlayerId = z
  .string()
  .refine((s) => hasPrefix(PREFIX.player, s), 'Invalid PlayerId')
  .brand<'PlayerId'>();
export type PlayerId = z.infer<typeof zPlayerId>;

export const zRoomId = z
  .string()
  .refine((s) => hasPrefix(PREFIX.room, s), 'Invalid RoomId')
  .brand<'RoomId'>();
export type RoomId = z.infer<typeof zRoomId>;

export const zGameId = z
  .string()
  .refine((s) => hasPrefix(PREFIX.game, s), 'Invalid GameId')
  .brand<'GameId'>();
export type GameId = z.infer<typeof zGameId>;

export const zRoundId = z
  .string()
  .refine((s) => hasPrefix(PREFIX.round, s), 'Invalid RoundId')
  .brand<'RoundId'>();
export type RoundId = z.infer<typeof zRoundId>;

export const zSubmissionId = z
  .string()
  .refine((s) => hasPrefix(PREFIX.submission, s), 'Invalid SubmissionId')
  .brand<'SubmissionId'>();
export type SubmissionId = z.infer<typeof zSubmissionId>;

export const zSecretPoolItemId = z
  .string()
  .refine((s) => hasPrefix(PREFIX.secretPool, s), 'Invalid SecretPoolItemId')
  .brand<'SecretPoolItemId'>();
export type SecretPoolItemId = z.infer<typeof zSecretPoolItemId>;

export const zEventId = z
  .string()
  .refine((s) => hasPrefix(PREFIX.event, s), 'Invalid EventId')
  .brand<'EventId'>();
export type EventId = z.infer<typeof zEventId>;

// Composite row ID for the eventsPrivate table: `epvt_<evtId>|<playerId>`.
// `|` is not in base64url so it cannot collide with the inner ids.
export const zEventsPrivateRowId = z
  .string()
  .refine((s) => hasPrefix(PREFIX.eventsPrivate, s), 'Invalid EventsPrivateRowId')
  .brand<'EventsPrivateRowId'>();
export type EventsPrivateRowId = z.infer<typeof zEventsPrivateRowId>;

export const zChatSubmissionId = z
  .string()
  .refine((s) => hasPrefix(PREFIX.chatSubmission, s), 'Invalid ChatSubmissionId')
  .brand<'ChatSubmissionId'>();
export type ChatSubmissionId = z.infer<typeof zChatSubmissionId>;

export const zChatEventId = z
  .string()
  .refine((s) => hasPrefix(PREFIX.chatEvent, s), 'Invalid ChatEventId')
  .brand<'ChatEventId'>();
export type ChatEventId = z.infer<typeof zChatEventId>;

export const zInviteCode = z
  .string()
  .refine((s) => hasPrefix(PREFIX.inviteCode, s), 'Invalid InviteCode')
  .brand<'InviteCode'>();
export type InviteCode = z.infer<typeof zInviteCode>;

