import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import {
  generateGameHostKeypair,
  generateRoomSeed,
  loadGameHostKeypair,
  loadPlayerIdentity,
  zLocalRoomRoleHost,
  type GameType,
  type HostRoomBootstrap,
  type LoadedGameHostKeypair,
  type LoadedPlayerIdentity,
  type LocalRoomRole,
  type LocalRoomRoleHost,
  type PreferencesV1,
  type RoomId,
  type RoomSeed,
  type RoomStatus,
  type PlayerId
} from '@brute-force-games/shared-types';

import type { RoomRoleTracker, RoomStore } from '@brute-force-games/multiplayer-types';

import {
  BrowserRoomRoleTracker,
  TinyBaseRoomStoreClient
} from '@brute-force-games/multiplayer-tinybase';

import { createMergeableStore } from 'tinybase';
import type { TablesSchema } from 'tinybase';

import { generateInviteCode, makeRoomId } from '../utils/invite';

import { WebLocalStore } from './localStore';

export type SelfRoomRole = 'host' | 'player' | 'observer' | 'unknown';

export type RoomsIndexRow = {
  roomId: RoomId;
  lastSeenAt: number;
  connected: boolean;
  wsUrl: string;
  roomStatus: RoomStatus | 'unknown';
  gameType: GameType | 'unknown';
  hostPlayerId: string;
  selfRole: SelfRoomRole;
};

type SyncContextValue = {
  identity: LoadedPlayerIdentity;
  preferences: PreferencesV1;
  updatePreferences: (next: Omit<PreferencesV1, 'version'>) => void;
  getRoomStore: (roomId: RoomId) => RoomStore;
  releaseRoomStore: (roomId: RoomId) => void;
  roomsIndex: RoomsIndexRow[];
  touchRoomIndex: (
    roomId: RoomId,
    patch: Partial<Omit<RoomsIndexRow, 'roomId'>> & { wsUrl?: string }
  ) => void;

  // ─── Per-room role (driven by the abstract RoomRoleTracker) ───────────
  // The role tracker is the local-only, implementation-agnostic source of
  // truth for "what role am I in this room?". The multiplayer adapter's
  // synced room row is *not* used for that decision.
  /** Mints a new host keypair, persists a host role-record, returns the room id + invite code. */
  createHostedRoom: (input: {
    defaultGameType: GameType;
    defaultGameConfig?: unknown;
    maxPlayers?: number;
    /** Seed for deterministic RNG — use generateRoomSeed() for a random game. */
    seed: RoomSeed;
  }) => Promise<{ roomId: RoomId; invite: string; role: LocalRoomRoleHost }>;
  /** Returns the persisted local role for `roomId`, or null. */
  getRoleForRoom: (roomId: RoomId) => LocalRoomRole | null;
  /** Loads the persisted host keypair for `roomId`, or null if not a host record. */
  loadHostKeypairForRoom: (roomId: RoomId) => Promise<LoadedGameHostKeypair | null>;
  /** Forgets the local role for a room (does NOT modify any synced state). */
  forgetRoleForRoom: (roomId: RoomId) => void;
};

const Ctx = createContext<SyncContextValue | null>(null);

const ROOMS_INDEX_SCHEMA = {
  roomsIndex: {
    lastSeenAt: { type: 'number', default: 0 },
    connected: { type: 'boolean', default: false },
    wsUrl: { type: 'string', default: '' },
    roomStatus: { type: 'string', default: 'unknown' },
    gameType: { type: 'string', default: 'unknown' },
    hostPlayerId: { type: 'string', default: '' },
    selfRole: { type: 'string', default: 'unknown' }
  }
} as const satisfies TablesSchema;

export function SyncProvider(props: { children: React.ReactNode }) {
  const localStore = useMemo(() => new WebLocalStore(), []);
  // The RoomRoleTracker is the *only* thing SyncContext uses to answer
  // "am I host of this room?". It is supplied here as a concrete
  // BrowserRoomRoleTracker but consumed throughout this file as the
  // abstract `RoomRoleTracker` interface.
  const roleTracker = useMemo<RoomRoleTracker>(() => new BrowserRoomRoleTracker(), []);
  useEffect(() => () => roleTracker.destroy?.(), [roleTracker]);

  const [bootstrap, setBootstrap] = useState<{
    identity: LoadedPlayerIdentity;
    preferences: PreferencesV1;
  } | null>(null);
  // Stable accessors below close over bootstrapRef rather than the bootstrap
  // state directly. This lets us expose `getRoomStore` etc. as referentially
  // stable callbacks that consumers can put in useEffect/useMemo deps without
  // tearing down per render of SyncProvider.
  const bootstrapRef = useRef(bootstrap);
  bootstrapRef.current = bootstrap; // sync update so callbacks see the current value on first render
  const roomStoresRef = useRef(new Map<RoomId, TinyBaseRoomStoreClient>());
  const roomStoreUnsubsRef = useRef(new Map<RoomId, Array<() => void>>());
  const nonceProviderRef = useRef<(() => number) | null>(null);

  // SyncProvider owns the lifetime of all room stores. Components that visit
  // a room must NOT destroy the store on unmount (StrictMode setup → cleanup
  // → setup would race with that, and creating a new store on every cleanup
  // turns into a re-render storm). On SyncProvider unmount, destroy them all.
  useEffect(() => {
    const stores = roomStoresRef.current;
    const unsubs = roomStoreUnsubsRef.current;
    return () => {
      for (const list of unsubs.values()) for (const u of list) u();
      unsubs.clear();
      for (const s of stores.values()) s.destroy();
      stores.clear();
    };
  }, []);

  const masterStore = useMemo(() => {
    const s = createMergeableStore();
    s.setTablesSchema(ROOMS_INDEX_SCHEMA);
    return s;
  }, []);
  const [roomsIndex, setRoomsIndex] = useState<RoomsIndexRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const serialized = await localStore.ensureIdentity();
      const identity = await loadPlayerIdentity(serialized);
      const prefs = localStore.ensurePreferencesV1(identity.playerId);
      if (cancelled) return;
      nonceProviderRef.current = localStore.makeSubmissionNonceProvider(identity.playerId as PlayerId);
      setBootstrap({ identity, preferences: prefs });
    })();
    return () => {
      cancelled = true;
    };
  }, [localStore]);

  // Keep `roomsIndex` state in sync with the master store.
  useEffect(() => {
    const compute = () => {
      const table = masterStore.getTable('roomsIndex');
      const rows: RoomsIndexRow[] = Object.entries(table).map(([roomId, r]) => ({
        roomId: roomId as RoomId,
        lastSeenAt: Number(r.lastSeenAt ?? 0),
        connected: Boolean(r.connected),
        wsUrl: String(r.wsUrl ?? ''),
        roomStatus: (r.roomStatus as any) ?? 'unknown',
        gameType: (r.gameType as any) ?? 'unknown',
        hostPlayerId: String(r.hostPlayerId ?? ''),
        selfRole: (r.selfRole as any) ?? 'unknown'
      }));
      rows.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
      setRoomsIndex(rows);
    };
    compute();
    const id = masterStore.addTableListener('roomsIndex', compute);
    return () => {
      masterStore.delListener(id);
    };
  }, [masterStore]);

  const touchRoomIndex = useCallback<SyncContextValue['touchRoomIndex']>(
    (roomId, patch) => {
      const existing = masterStore.getRow('roomsIndex', roomId) ?? {};
      masterStore.setRow('roomsIndex', roomId, {
        ...existing,
        ...patch,
        lastSeenAt: Date.now()
      });
    },
    [masterStore]
  );

  // selfRole comes from the local role tracker (never the synced room row).
  const computeSelfRoleForRoom = useCallback(
    (roomId: RoomId, currentIdentity: LoadedPlayerIdentity): SelfRoomRole => {
      const role = roleTracker.get(roomId);
      if (role?.kind === 'host' && role.hostPlayerId === currentIdentity.playerId) return 'host';
      return 'player';
    },
    [roleTracker]
  );

  const ensureRoomListeners = useCallback(
    (roomId: RoomId, currentIdentity: LoadedPlayerIdentity, roomStore: RoomStore) => {
      if (roomStoreUnsubsRef.current.has(roomId)) return;

      const unsubs: Array<() => void> = [];

      // The synced room row contributes hostPlayerId / status / gameType for
      // display only. selfRole always comes from the role tracker.
      unsubs.push(
        roomStore.onRoomChanged((room) => {
          if (!room) return;
          touchRoomIndex(roomId, {
            hostPlayerId: room.hostPlayerId,
            roomStatus: room.status,
            gameType: room.gameType,
            selfRole: computeSelfRoleForRoom(roomId, currentIdentity)
          });
        })
      );

      roomStoreUnsubsRef.current.set(roomId, unsubs);
    },
    [computeSelfRoleForRoom, touchRoomIndex]
  );

  // Stable role-tracker helpers (referentially stable across renders so
  // consumers can list them as useEffect dependencies safely).
  const getRoleForRoom = useCallback<SyncContextValue['getRoleForRoom']>(
    (roomId) => roleTracker.get(roomId),
    [roleTracker]
  );

  const loadHostKeypairForRoom = useCallback<SyncContextValue['loadHostKeypairForRoom']>(
    async (roomId) => {
      const role = roleTracker.get(roomId);
      if (!role || role.kind !== 'host') return null;
      return loadGameHostKeypair(role.hostKeypair);
    },
    [roleTracker]
  );

  const forgetRoleForRoom = useCallback<SyncContextValue['forgetRoleForRoom']>(
    (roomId) => roleTracker.delete(roomId),
    [roleTracker]
  );

  const releaseRoomStore = useCallback<SyncContextValue['releaseRoomStore']>(
    (roomId) => {
      const unsubs = roomStoreUnsubsRef.current.get(roomId);
      if (unsubs) {
        for (const u of unsubs) u();
        roomStoreUnsubsRef.current.delete(roomId);
      }
      const store = roomStoresRef.current.get(roomId);
      if (store) {
        store.destroy();
        roomStoresRef.current.delete(roomId);
      }
      masterStore.delRow('roomsIndex', roomId);
    },
    [masterStore]
  );

  const getRoomStore = useCallback<SyncContextValue['getRoomStore']>(
    (roomId) => {
      const b = bootstrapRef.current;
      if (!b) throw new Error('SyncProvider: bootstrap not ready');
      const existing = roomStoresRef.current.get(roomId);
      if (existing) {
        ensureRoomListeners(roomId, b.identity, existing);
        return existing;
      }
      const store = new TinyBaseRoomStoreClient({
        identity: b.identity,
        ...(nonceProviderRef.current ? { getNextSubmissionNonce: nonceProviderRef.current } : {}),
        displayName: b.preferences.displayName,
        avatarColor: b.preferences.avatarColor
      });
      roomStoresRef.current.set(roomId, store);
      ensureRoomListeners(roomId, b.identity, store);
      return store;
    },
    [ensureRoomListeners]
  );

  const updatePreferences = useCallback<SyncContextValue['updatePreferences']>(
    (next) => {
      const b = bootstrapRef.current;
      if (!b) return;
      const saved = localStore.savePreferencesV1(next);
      for (const s of roomStoresRef.current.values()) {
        s.setSelfProfile({ displayName: saved.displayName, avatarColor: saved.avatarColor });
      }
      setBootstrap({ ...b, preferences: saved });
    },
    [localStore]
  );

  const createHostedRoom = useCallback<SyncContextValue['createHostedRoom']>(
    async (input) => {
      const b = bootstrapRef.current;
      if (!b) throw new Error('SyncProvider: bootstrap not ready');
      const roomId = makeRoomId() as RoomId;
      const invite = generateInviteCode();
      const hostKeypair = await generateGameHostKeypair();
      const bootstrapHints: HostRoomBootstrap = {
        gameType: input.defaultGameType,
        gameConfig: input.defaultGameConfig,
        maxPlayers: input.maxPlayers,
        ...(input.seed ? { seed: input.seed } : {})
      };
      const loadedHostKeypair = await loadGameHostKeypair(hostKeypair);
      const role = zLocalRoomRoleHost.parse({
        kind: 'host',
        version: 1,
        roomId,
        hostPlayerId: b.identity.playerId,
        hostKeypair,
        bootstrap: bootstrapHints,
        createdAt: Date.now()
      });
      roleTracker.set(role);

      // Bootstrap the room store immediately — the host is implicitly connected
      // the moment they create the room. This writes the room row and the host's
      // player row locally so the room UI is ready before the WS connect attempt.
      // We reach into roomStoresRef to get the concrete TinyBaseRoomStoreClient
      // (getRoomStore returns the abstract RoomStore which lacks this method).
      const roomStore = (() => {
        const existing = roomStoresRef.current.get(roomId);
        if (existing) return existing;
        const s = new TinyBaseRoomStoreClient({
          identity: b.identity,
          ...(nonceProviderRef.current ? { getNextSubmissionNonce: nonceProviderRef.current } : {}),
          displayName: b.preferences.displayName,
          avatarColor: b.preferences.avatarColor
        });
        roomStoresRef.current.set(roomId, s);
        return s;
      })();
      roomStore.bootstrapAsHostLocal({
        roomId,
        inviteCode: invite,
        hostKeypair: loadedHostKeypair,
        bootstrap: bootstrapHints
      });

      touchRoomIndex(roomId, {
        connected: false,
        roomStatus: 'waiting',
        gameType: input.defaultGameType,
        hostPlayerId: b.identity.playerId,
        selfRole: 'host'
      });

      return { roomId, invite, role };
    },
    [roleTracker, touchRoomIndex]
  );

  if (!bootstrap) {
    return <div style={{ padding: 16 }}>Loading identity…</div>;
  }

  const value: SyncContextValue = {
    identity: bootstrap.identity,
    preferences: bootstrap.preferences,
    updatePreferences,
    getRoomStore,
    releaseRoomStore,
    roomsIndex,
    touchRoomIndex,
    createHostedRoom,
    getRoleForRoom,
    loadHostKeypairForRoom,
    forgetRoleForRoom
  };

  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
}

export function useSync(): SyncContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('SyncProvider missing');
  return v;
}

export function useRoomsIndex(): RoomsIndexRow[] {
  return useSync().roomsIndex;
}
