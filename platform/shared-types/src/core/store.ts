import type { PlayerIdentity } from './identity';

// Local storage for device-scoped data (identity + preferences). Never
// synced. Per-room role/host-claim tracking lives in `RoomRoleTracker` (see
// `@brute-force-games/multiplayer-types`).
//
// The transport-agnostic `RoomStore` interface lives in
// `@brute-force-games/multiplayer-types`, since it is implemented by
// concrete multiplayer transports rather than by shared-types itself.
export interface LocalStore {
  getIdentity(): PlayerIdentity | null;
  saveIdentity(identity: PlayerIdentity): void;
  getPreferences(): unknown;
  savePreferences(prefs: unknown): void;
}
