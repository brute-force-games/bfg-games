// Transport-agnostic multiplayer types and interfaces.
//
// This package defines the contract that frontend code (SyncContext, routes,
// game engines) talks to. Concrete transports (TinyBase, future native, ...)
// live in their own packages and `implements RoomStore`.

export type {
  ConnectOptions,
  GameConfigJson,
  GameExportV1,
  GameType,
  Player,
  Room,
  RoomStatus,
  SecretPoolItem
} from '@brute-force-games/shared-types';

export type {
  LocalStore,
  PlayerId,
  RoomId,
  LocalRoomRole,
  LocalRoomRoleHost,
  HostRoomBootstrap,
  Submission,
  SubmissionId,
  Event as RoomEvent,
  EventId,
  GameStatePublic,
  GameStatePrivate,
  LobbyChatSubmission,
  LobbyChatEvent,
  ChatSubmissionId,
  ChatEventId,
  EncryptedPayload,
  SecretMessageIv,
  LoadedGameHostKeypair
} from '@brute-force-games/shared-types';

import type {
  ConnectOptions,
  EncryptedPayload,
  Event as RoomEvent,
  GameExportV1,
  GameStatePublic,
  GameStatePrivate,
  GameType,
  HostRoomBootstrap,
  LoadedGameHostKeypair,
  LobbyChatEvent,
  LobbyChatSubmission,
  LocalRoomRole,
  Player,
  PlayerId,
  Room,
  RoomId,
  SecretMessageIv,
  Submission,
  SubmissionId,
  ChatSubmissionId
} from '@brute-force-games/shared-types';

// ─── HostClaim ──────────────────────────────────────────────────────────────
//
// A locally-held credential that designates the bearer as host of a specific
// room. The keypair is generated when the host first creates the room and
// persisted via `RoomRoleTracker`.
//
// Trust-the-client model: any client that holds the keypair can sign as host.
// Conflict resolution is by `room.hostEncPubKey` — whichever public key is
// already in the synced room row remains canonical; mismatched local claims
// will fail host-only writes.
export type HostClaim = {
  hostKeypair: LoadedGameHostKeypair;
};

// Room-level connect options accepted by every transport. Concrete transports
// may extend this with additional fields (e.g. wsUrl for TinyBase).
export type RoomConnectOptions = ConnectOptions & {
  /**
   * If present, the caller asserts they are host of `roomId`. The store will
   * adopt the supplied keypair and use it for all host-only operations.
   * Without a hostClaim, the client behaves as a non-host even if it happens
   * to share an identity with `room.hostPlayerId`.
   */
  hostClaim?: HostClaim;
  /**
   * If present AND a hostClaim is provided AND no `room` row exists yet,
   * the store will write the canonical row using these defaults. Ignored
   * otherwise.
   */
  bootstrapRoomIfMissing?: HostRoomBootstrap;
};

// ─── Player submission input ────────────────────────────────────────────────
//
// Player-side intent to submit a move/action. Either pre-encrypted bytes
// (iv + toHostCiphertext) or plaintext (which the store will encrypt).
export type SubmitInput = {
  iv?: SecretMessageIv;
  toHostCiphertext?: EncryptedPayload;
  plaintext?: Uint8Array;
  kind: string;
  gameType?: GameType;
};

// ─── Host loop ──────────────────────────────────────────────────────────────
//
// The host loop encapsulates the per-host state that used to live in the play
// route's useRefs: a submission validator (for signature + nonce checks), a
// processed-set (for dedup across host restarts), and the seq counter for
// emitted events. Engines plug into the loop via a handler that produces
// `HostLoopAction[]` from a decrypted submission.

export type HostLoopSubmissionInput = {
  /** The submission row that was accepted by signature+nonce validation. */
  submission: Submission;
  /** Decoded plaintext bytes (host already decrypted it). */
  plaintext: Uint8Array;
  /** Room state as observed when processing started. */
  room: Room;
};

export type HostLoopAction =
  | {
      kind: 'event';
      eventKind: string;
      publicPayload: unknown;
      /** Defaults to the submission's fromPlayerId, or selfPlayerId for host-driven actions. */
      fromPlayerId?: PlayerId;
    }
  | {
      kind: 'gameStatePublic';
      state: unknown;
    }
  | {
      kind: 'gameStateHistory';
      /** Public snapshot to persist into the history table. */
      state: unknown;
    }
  | {
      kind: 'gameStatePrivate';
      /**
       * One private-state value per player. The store encrypts each value to
       * the target player's encPubKey. Engines should not pre-encrypt.
       */
      perPlayer: ReadonlyArray<{
        playerId: PlayerId;
        kind: string;
        value: unknown;
      }>;
    }
  | {
      kind: 'updateRoom';
      patch: Partial<Omit<Room, 'id'>>;
    };

export type HostLoopHandlers = {
  /**
   * Called once per accepted submission. Return `HostLoopAction[]` to apply,
   * or `null` to drop the submission silently (already-acked dedup is handled
   * by the store).
   */
  onSubmission(
    input: HostLoopSubmissionInput
  ): Promise<HostLoopAction[] | null> | HostLoopAction[] | null;
};

export type HostLoopHandle = {
  /** Stop processing further submissions. Idempotent. */
  stop(): void;
};

// ─── RoomStore ──────────────────────────────────────────────────────────────
//
// The transport-agnostic surface that frontend code consumes. Methods are
// grouped by role: identity, connection, reads, subscriptions, player
// intents, host-only writes, and host loops.
export interface RoomStore {
  // Identity
  readonly selfPlayerId: PlayerId;
  setSelfProfile(input: { displayName?: string; avatarColor?: string }): void;
  setSelfReady(ready: boolean): void;

  // Connection
  connect(opts: RoomConnectOptions): Promise<void>;
  disconnect(): void;
  destroy(): void;

  // Reads
  getRoom(): Room;
  getRoomOrNull(roomId: string): Room | null;
  getPlayers(): Player[];
  getEvents(): RoomEvent[];
  getSubmissions(): Submission[];
  getLobbyChatSubmissions(): LobbyChatSubmission[];
  getLobbyChatEvents(): LobbyChatEvent[];
  getGameStatePublicOrNull(): GameStatePublic | null;
  getGameStatePrivateOrNull(playerId: PlayerId): GameStatePrivate | null;
  getGameStateHistory(): { seq: number; state: unknown }[];

  // Subscriptions (each returns an unsubscribe function; callbacks fire once
  // synchronously with the current value before subscribing).
  onRoomChanged(cb: (room: Room | null) => void): () => void;
  onPlayersChanged(cb: (players: Player[]) => void): () => void;
  onSubmissionsChanged(cb: (subs: Submission[]) => void): () => void;
  onLobbyChatSubmissionsChanged(cb: (subs: LobbyChatSubmission[]) => void): () => void;
  onLobbyChatEventsChanged(cb: (events: LobbyChatEvent[]) => void): () => void;
  onGameStatePublicChanged(cb: (state: GameStatePublic | null) => void): () => void;
  onGameStatePrivateChanged(
    playerId: PlayerId,
    cb: (state: GameStatePrivate | null) => void
  ): () => void;
  onGameStateHistoryChanged(cb: (rows: { seq: number; state: unknown }[]) => void): () => void;

  // Player-side intents
  submit(input: SubmitInput): Promise<SubmissionId>;
  submitLobbyChatMessage(input: { text: string }): Promise<ChatSubmissionId>;

  // Host-only writes (throw unless a matching hostClaim was passed to connect)
  updateRoomAsHost(patch: Partial<Omit<Room, 'id'>>): Promise<Room>;
  resetRoomAsHost(bootstrap: HostRoomBootstrap): void;

  /**
   * Apply a batch of host actions outside of the submission loop (used for
   * game start, admin actions, etc). Same semantics as the host loop's action
   * application: events get monotone seq numbers, snapshots are signed, and
   * private snapshots are encrypted per player.
   */
  applyHostActions(actions: ReadonlyArray<HostLoopAction>): Promise<void>;

  // Player-side encryption helpers
  /**
   * Decrypts the player's own private game-state snapshot. Plain rows are
   * returned as-is. Throws on AAD mismatch / signature failures.
   */
  decryptJsonForSelfFromGameStatePrivate(opts: {
    row: GameStatePrivate;
    seq: number;
    gameType: GameType;
    kind: string;
  }): Promise<unknown>;

  /**
   * Assembles and signs a `GameExportV1` bundle from the local store.
   * Host-only: throws if no host claim is held. Call after `room.status === 'finished'`.
   */
  exportGameRecord(opts: { appVersion: string; engineVersion: string }): Promise<GameExportV1>;

  // Host loops
  /**
   * Start processing player submissions as host. Encapsulates validator
   * creation, replay protection, processed-set seeding, and seq allocation.
   *
   * Returns immediately; the loop runs until `stop()` is called or the
   * connection is torn down. Throws synchronously if this client doesn't hold
   * a host claim for the connected room.
   */
  startHostLoop(handlers: HostLoopHandlers): HostLoopHandle;

  /**
   * Start processing lobby chat submissions as host. The store handles
   * validation, decryption, and writing chat events. Returns immediately;
   * stop with `handle.stop()`. Throws synchronously if not host.
   */
  startLobbyChatHostLoop(): HostLoopHandle;
}

// ─── RoomRoleTracker ────────────────────────────────────────────────────────
//
// Per-room "what role am I in this room?" store. Local-only, never synced.
// Implementations persist `LocalRoomRole` records keyed by `roomId` to some
// device-local backing store (localStorage, IndexedDB, native preferences,
// etc.) and provide reactive change notifications.
//
// The presence of a `host` record is the authoritative signal for "I am the
// host of this room" — multiplayer adapters MUST NOT derive host status from
// any synced state.
export interface RoomRoleTracker {
  /** Returns the persisted role for `roomId`, or null if none. */
  get(roomId: RoomId): LocalRoomRole | null;
  /** Persists/overwrites the role for `role.roomId`. */
  set(role: LocalRoomRole): void;
  /** Forgets the local role for `roomId`. */
  delete(roomId: RoomId): void;
  /** Lists all persisted roles, in unspecified order. */
  list(): LocalRoomRole[];
  /**
   * Subscribes to any change in the tracker (set/delete on any room).
   * Returns an unsubscribe function. Implementations MUST notify after the
   * change is durable to other readers (i.e. after persistence flush).
   */
  subscribe(cb: () => void): () => void;
  /** Optional teardown for implementations that hold OS resources. */
  destroy?(): void;
}
