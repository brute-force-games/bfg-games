import {
  zLocalRoomRole,
  type LocalRoomRole,
  type RoomId
} from '@brute-force-games/shared-types';
import type { RoomRoleTracker } from '@brute-force-games/multiplayer-types';

// localStorage-backed implementation of `RoomRoleTracker`. Kept alongside
// the TinyBase room-store adapter so the browser bundle ships exactly one
// pair of multiplayer pieces: a `RoomRoleTracker` (this file) and a
// `RoomStore` (TinyBaseRoomStoreClient). Other adapters (native, server,
// memory-only for tests) implement the same `RoomRoleTracker` interface.
//
// Storage layout: one localStorage entry per known room, key
// `bfg.room-role.v1.<roomId>`. The value is a JSON-encoded `LocalRoomRole`.
// Cross-tab updates are picked up via the `storage` event so subscribers in
// other tabs see live changes too.

const KEY_PREFIX = 'bfg.room-role.v1.';

function keyFor(roomId: RoomId): string {
  return `${KEY_PREFIX}${roomId}`;
}

function parseRoleOrNull(raw: string | null): LocalRoomRole | null {
  if (!raw) return null;
  try {
    const json = JSON.parse(raw);
    const parsed = zLocalRoomRole.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export class BrowserRoomRoleTracker implements RoomRoleTracker {
  private readonly listeners = new Set<() => void>();
  private readonly onStorage = (e: StorageEvent) => {
    if (!e.key) {
      // localStorage cleared
      this.notify();
      return;
    }
    if (e.key.startsWith(KEY_PREFIX)) {
      this.notify();
    }
  };

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', this.onStorage);
    }
  }

  get(roomId: RoomId): LocalRoomRole | null {
    return parseRoleOrNull(localStorage.getItem(keyFor(roomId)));
  }

  set(role: LocalRoomRole): void {
    localStorage.setItem(keyFor(role.roomId), JSON.stringify(role));
    this.notify();
  }

  delete(roomId: RoomId): void {
    localStorage.removeItem(keyFor(roomId));
    this.notify();
  }

  list(): LocalRoomRole[] {
    const out: LocalRoomRole[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(KEY_PREFIX)) continue;
      const role = parseRoleOrNull(localStorage.getItem(k));
      if (role) out.push(role);
    }
    return out;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  destroy(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', this.onStorage);
    }
    this.listeners.clear();
  }

  private notify(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
        // listeners must not throw; swallow to keep the rest healthy
      }
    }
  }
}
