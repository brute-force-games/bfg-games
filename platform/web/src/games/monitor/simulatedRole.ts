import type { UserGameRoleKind } from '@brute-force-games/shared-types';

/** Whether the simulated role may use host X25519 priv for player→host ciphertext. */
export function simulatedUsesHostPriv(role: UserGameRoleKind): boolean {
  return role === 'host_moderator';
}

/** Whether the simulated role may use the local player's X25519 priv for host→player ciphertext. */
export function simulatedUsesPlayerPriv(role: UserGameRoleKind): boolean {
  return (
    role === 'player' ||
    role === 'participant_observer' ||
    role === 'host_player'
  );
}
