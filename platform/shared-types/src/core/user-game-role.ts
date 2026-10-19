import { z } from 'zod';

import type { PlayerId } from './ids';

/** URL segment under `/room/:roomId/…` — drives navigation only; combine with `UserGameRole` for UI. */
export const zRoomRouteSegment = z.enum(['play', 'host', 'observe', 'spectate']);
export type RoomRouteSegment = z.infer<typeof zRoomRouteSegment>;

/**
 * Explicit game-facing role for chrome and engines. Orthogonal to URL except
 * `anonymous_spectator` (requires `/spectate` entry + observer session tier).
 */
export const zUserGameRoleKind = z.enum([
  'anonymous_spectator',
  'host_moderator',
  'host_player',
  'player',
  'participant_observer'
]);
export type UserGameRoleKind = z.infer<typeof zUserGameRoleKind>;

export type UserGameRole =
  | { kind: 'anonymous_spectator' }
  | { kind: 'host_moderator' }
  | { kind: 'host_player' }
  | { kind: 'player' }
  | { kind: 'participant_observer' };

/** Transport session tier from `RoomStore` (pending → resolved participant vs observer vs moderator). */
export type RoomSessionRole = 'pending' | 'player' | 'observer' | 'moderator';

export type DeriveUserGameRoleInput = {
  route: RoomRouteSegment;
  sessionRole: RoomSessionRole;
  hasHostClaim: boolean;
  /** From local host record; default true when omitted (host participates as a seated player). */
  hostParticipatesAsPlayer: boolean;
  selfPlayerId: PlayerId;
  roomHostPlayerId: PlayerId | null | undefined;
};

/**
 * Derive the effective user game role from session tier, host claim, seat policy, and route.
 */
export function deriveUserGameRole(input: DeriveUserGameRoleInput): UserGameRole {
  const { route, sessionRole, hasHostClaim, hostParticipatesAsPlayer, selfPlayerId, roomHostPlayerId } =
    input;

  if (sessionRole === 'observer') {
    return { kind: 'anonymous_spectator' };
  }

  const hostModerator = hasHostClaim && (!hostParticipatesAsPlayer || sessionRole === 'moderator');
  if (hostModerator) {
    return { kind: 'host_moderator' };
  }

  if (sessionRole === 'pending') {
    if (hasHostClaim && hostParticipatesAsPlayer) return { kind: 'host_player' };
    if (hasHostClaim && !hostParticipatesAsPlayer) return { kind: 'host_moderator' };
    return { kind: 'player' };
  }

  if (!hasHostClaim && sessionRole === 'player' && route === 'observe') {
    return { kind: 'participant_observer' };
  }

  if (!hasHostClaim && sessionRole === 'player') {
    return { kind: 'player' };
  }

  if (hasHostClaim && sessionRole === 'player') {
    const hostMatches = roomHostPlayerId == null || roomHostPlayerId === selfPlayerId;
    if (hostMatches) return { kind: 'host_player' };
  }

  return { kind: 'player' };
}

export function isHostAuthority(role: UserGameRole): boolean {
  return role.kind === 'host_player' || role.kind === 'host_moderator';
}

export function isHostWithSeat(role: UserGameRole): boolean {
  return role.kind === 'host_player';
}

export function isHostModeratorOnly(role: UserGameRole): boolean {
  return role.kind === 'host_moderator';
}

export function canSubmitGameMoves(role: UserGameRole): boolean {
  return role.kind === 'host_player' || role.kind === 'player';
}

export function shouldUseSpectatorChrome(route: RoomRouteSegment, role: UserGameRole): boolean {
  if (route === 'spectate' || route === 'observe') return true;
  if (route === 'host') return false;
  return role.kind === 'participant_observer' || role.kind === 'anonymous_spectator';
}
