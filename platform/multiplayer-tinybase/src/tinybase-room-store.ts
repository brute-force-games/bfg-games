import { createMergeableStore } from 'tinybase';
import type { MergeableStore } from 'tinybase';

import {
  HostSubmissionValidator,
  HostLobbyChatValidator,
  SINGLETON_PUBLIC_STATE_ID,
  bytesToB64Url,
  decryptSubmissionFromPlayer,
  decryptLobbyChatMessageFromPlayer,
  encryptSubmissionToHost,
  encryptLobbyChatMessageToHost,
  encryptHostMessageToPlayer,
  decryptHostMessageFromHost,
  requireHost,
  signEvent,
  signGameStatePublic,
  signGameStateHistoryRow,
  signSubmission,
  canonicalExportBytes,
  signExport,
  GAME_FINALIZED_KIND,
  signLobbyChatEvent,
  signLobbyChatSubmission,
  zChatEventId,
  zChatSubmissionId,
  zEventId,
  zLobbyChatEvent,
  zLobbyChatMessage,
  zLobbyChatSubmission,
  zEventsPrivate,
  zGameStatePrivate,
  zGameStatePublic,
  zGameStateHistoryRow,
  zEvent,
  zPlayer,
  zRoom,
  zSubmission,
  zSubmissionId,
  type ChatEventId,
  type ChatSubmissionId,
  type EncryptedPayload,
  type Event as RoomEvent,
  type EventId,
  type EventSeq,
  type EventsPrivate,
  type GameStateHistoryRow,
  type GameStatePrivate,
  type GameStatePublic,
  type GameExportV1,
  type GameType,
  type LobbyChatEvent,
  type LobbyChatSubmission,
  type LoadedGameHostKeypair,
  type LoadedPlayerIdentity,
  type Player,
  type PlayerId,
  type Room,
  type RoomId,
  type SecretMessageIv,
  type Submission,
  type SubmissionId,
  type SubmissionNonce,
  type UnixMs
} from '@brute-force-games/shared-types';

import type {
  HostClaim,
  HostLoopAction,
  HostLoopHandle,
  HostLoopHandlers,
  HostRoomBootstrap,
  RoomConnectOptions,
  RoomStore,
  SubmitInput
} from '@brute-force-games/multiplayer-types';

import { ROOM_TABLES_SCHEMA, readAllRows, readRow, writeRow } from './schema';
import type { RoomSyncHandle, RoomSyncProvider } from './sync/RoomSyncProvider';
import { WsRoomSyncProvider } from './sync/WsRoomSyncProvider';

// Internal kind used to mark submissions as accepted, so that on host
// reconnect/restart we don't re-process the same submission. The publicPayload
// holds `{ submissionId }`.
const HOST_ACCEPTED_SUBMISSION_KIND = 'host/accepted_submission' as const;

const HEARTBEAT_INTERVAL_MS = 15_000;

// Default in-memory nonce provider — reloads start over from 1 (host will
// reject everything until it crosses the prior session's max). Callers
// running in a real browser should pass a persistent provider; see
// `WebLocalStore.makeSubmissionNonceProvider` in platform/web.
function defaultInMemoryNonceProvider(): () => number {
  let n = 0;
  return () => ++n;
}

export type TinyBaseRoomStoreOptions = {
  identity: LoadedPlayerIdentity;
  /** Returns a strictly-increasing nonce per call. Persist across reloads. */
  getNextSubmissionNonce?: () => number;
  displayName?: string;
  avatarColor?: string;
  /** Swap transport without touching RoomStore consumers. */
  syncProvider?: RoomSyncProvider;
};

// Re-exports of the abstract host-claim and connect-options types from
// multiplayer-types. These are kept for backwards compatibility with callers
// that import the TinyBase-prefixed names; new code should import directly
// from `@brute-force-games/multiplayer-types`.
export type TinyBaseHostClaim = HostClaim;
export type TinyBaseConnectOptions = RoomConnectOptions;

// Default room fields used only on the very first connect for a freshly
// created room — i.e., when no `room` row exists yet in the synced store.
// Ignored on subsequent connects; the canonical row in the synced store wins.
//
// Alias of the abstract `HostRoomBootstrap` shape; kept for backwards
// compatibility with TinyBase-prefixed imports.
export type TinyBaseBootstrapRoom = HostRoomBootstrap;

function makeSubmissionId(): SubmissionId {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return zSubmissionId.parse(`sub_${bytesToB64Url(bytes)}`);
}

function makeEventId(): EventId {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return zEventId.parse(`evt_${bytesToB64Url(bytes)}`) as EventId;
}

function makeChatSubmissionId(): ChatSubmissionId {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return zChatSubmissionId.parse(`csub_${bytesToB64Url(bytes)}`);
}

function makeChatEventId(): ChatEventId {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return zChatEventId.parse(`cevt_${bytesToB64Url(bytes)}`);
}

export class TinyBaseRoomStoreClient implements RoomStore {
  private store: MergeableStore;
  private sync: RoomSyncHandle | null = null;
  private heartbeat: number | null = null;

  private readonly identity: LoadedPlayerIdentity;
  private readonly getNextSubmissionNonce: () => number;
  private displayName: string;
  private avatarColor: string;
  private selfReady: boolean = false;
  private hostKeypair: LoadedGameHostKeypair | null = null;
  private connectedRoomId: RoomId | null = null;
  private readonly joinedAt: number;
  private syncProvider: RoomSyncProvider;

  // Host-loop state. Owned by the store rather than the React tree so that:
  //   - Validator instances aren't recreated on remount (replay protection
  //     stays correct across StrictMode double-mounts and hot reloads).
  //   - The processed-set is durable for the lifetime of the connection,
  //     not the lifetime of a useEffect.
  //   - Two host loops can't accidentally race against each other within a
  //     single process: starting a second loop stops the first.
  private gameHostLoop: { stop: () => void } | null = null;
  private chatHostLoop: { stop: () => void } | null = null;

  constructor(opts: TinyBaseRoomStoreOptions) {
    this.store = createMergeableStore();
    this.store.setTablesSchema(ROOM_TABLES_SCHEMA);
    this.identity = opts.identity;
    this.getNextSubmissionNonce = opts.getNextSubmissionNonce ?? defaultInMemoryNonceProvider();
    this.displayName = opts.displayName ?? `Player ${opts.identity.playerId.slice(-4)}`;
    this.avatarColor = opts.avatarColor ?? '#4f46e5';
    this.joinedAt = Date.now();
    this.syncProvider = opts.syncProvider ?? new WsRoomSyncProvider();
  }

  get selfPlayerId(): PlayerId {
    return this.identity.playerId;
  }

  setSelfProfile(input: { displayName?: string; avatarColor?: string }): void {
    if (input.displayName != null) this.displayName = input.displayName;
    if (input.avatarColor != null) this.avatarColor = input.avatarColor;
    // If connected, publish immediately; if not, it will be published on connect.
    if (this.connectedRoomId) this.upsertSelfPlayer();
  }

  setSelfReady(ready: boolean): void {
    this.selfReady = ready;
    // Persist immediately (and keep it on subsequent heartbeats).
    this.upsertSelfPlayer();
  }

  // ─── Reads ──────────────────────────────────────────────────────────────

  getRoomOrNull(roomId: string): Room | null {
    return readRow(zRoom, this.store, 'room', roomId);
  }

  getPlayers(): Player[] {
    return readAllRows(zPlayer, this.store, 'players');
  }

  getSubmissions(): Submission[] {
    return readAllRows(zSubmission, this.store, 'submissions');
  }

  getEvents(): RoomEvent[] {
    return readAllRows(zEvent, this.store, 'events');
  }

  getLobbyChatSubmissions(): LobbyChatSubmission[] {
    return readAllRows<LobbyChatSubmission>(zLobbyChatSubmission, this.store, 'chatSubmissions');
  }

  getLobbyChatEvents(): LobbyChatEvent[] {
    return readAllRows<LobbyChatEvent>(zLobbyChatEvent, this.store, 'chatEvents');
  }

  getGameStatePublicOrNull(): GameStatePublic | null {
    return readRow(zGameStatePublic, this.store, 'gameStatePublic', 'state_public');
  }

  getGameStateHistory(): GameStateHistoryRow[] {
    return readAllRows(zGameStateHistoryRow, this.store, 'gameStateHistory').sort((a, b) => a.seq - b.seq);
  }

  getGameStatePrivateOrNull(playerId: PlayerId): GameStatePrivate | null {
    return readRow(zGameStatePrivate, this.store, 'gameStatePrivate', playerId);
  }

  getRoom(): Room {
    return this.requireConnectedRoom();
  }

  onPlayersChanged(cb: (players: Player[]) => void): () => void {
    const fire = () => cb(this.getPlayers());
    fire();
    const listenerId = this.store.addTableListener('players', () => fire());
    return () => this.store.delListener(listenerId);
  }

  onSubmissionsChanged(cb: (submissions: Submission[]) => void): () => void {
    const fire = () => cb(this.getSubmissions());
    fire();
    const listenerId = this.store.addTableListener('submissions', () => fire());
    return () => this.store.delListener(listenerId);
  }

  onRoomChanged(cb: (room: Room | null) => void): () => void {
    const fire = () => {
      if (!this.connectedRoomId) return cb(null);
      cb(this.getRoomOrNull(this.connectedRoomId));
    };
    fire();
    const listenerId = this.store.addTableListener('room', () => fire());
    return () => this.store.delListener(listenerId);
  }

  onLobbyChatSubmissionsChanged(
    cb: (submissions: LobbyChatSubmission[]) => void
  ): () => void {
    const fire = () => cb(this.getLobbyChatSubmissions());
    fire();
    const listenerId = this.store.addTableListener('chatSubmissions', () => fire());
    return () => this.store.delListener(listenerId);
  }

  onLobbyChatEventsChanged(cb: (events: LobbyChatEvent[]) => void): () => void {
    const fire = () => cb(this.getLobbyChatEvents());
    fire();
    const listenerId = this.store.addTableListener('chatEvents', () => fire());
    return () => this.store.delListener(listenerId);
  }

  onGameStatePublicChanged(cb: (state: GameStatePublic | null) => void): () => void {
    const fire = () => cb(this.getGameStatePublicOrNull());
    fire();
    const listenerId = this.store.addTableListener('gameStatePublic', () => fire());
    return () => this.store.delListener(listenerId);
  }

  onGameStateHistoryChanged(cb: (rows: GameStateHistoryRow[]) => void): () => void {
    const fire = () => cb(this.getGameStateHistory());
    fire();
    const listenerId = this.store.addTableListener('gameStateHistory', () => fire());
    return () => this.store.delListener(listenerId);
  }

  onGameStatePrivateChanged(playerId: PlayerId, cb: (state: GameStatePrivate | null) => void): () => void {
    const fire = () => cb(this.getGameStatePrivateOrNull(playerId));
    fire();
    const listenerId = this.store.addTableListener('gameStatePrivate', () => fire());
    return () => this.store.delListener(listenerId);
  }

  // ─── Connection ─────────────────────────────────────────────────────────

  async connect(opts: RoomConnectOptions): Promise<void> {
    // Allow switching rooms: if we're already connected, only no-op if the room matches.
    if (this.sync) {
      if (this.connectedRoomId === opts.roomId) return;
      this.disconnect();
    }

    // Set this *before* awaiting sync. The room-row table listener fires for
    // every write that lands during the initial sync, and `onRoomChanged`'s
    // fire() reads `this.connectedRoomId` to know which row to surface. If we
    // set it after startSync, the listener fires with `connectedRoomId === null`
    // for every sync write, the subscriber sees `null`, and once sync settles
    // there are no further table changes — leaving subscribers permanently
    // stuck on `null` even though the row is sitting in the store. Concretely:
    // observers joining a room with status='active' would never see the engine
    // UI render, because the play route's gate is `room?.status === 'active'`.
    this.connectedRoomId = opts.roomId;

    try {
      this.sync = await this.syncProvider.connect({ store: this.store, wsUrl: opts.wsUrl });
      await this.sync.start();
    } catch (err) {
      // Roll back so a partially-failed connect doesn't masquerade as connected.
      this.connectedRoomId = null;
      throw err;
    }

    // Host-claim handling (trust-the-client model):
    // The caller is the source of truth for "am I host?". If they pass a
    // claim, we adopt the keypair and may bootstrap the room row when no row
    // is present yet. We never auto-elect ourselves as host based on the
    // (synced, racy) absence of a `room` row.
    if (opts.hostClaim) {
      this.hostKeypair = opts.hostClaim.hostKeypair;

      const existingRoom = this.getRoomOrNull(opts.roomId);
      if (!existingRoom) {
        if (opts.bootstrapRoomIfMissing) {
          this.bootstrapRoomAsHost({
            roomId: opts.roomId,
            hostKeypair: this.hostKeypair,
            bootstrap: opts.bootstrapRoomIfMissing
          });
        }
        // If no bootstrap was provided we do nothing here: the row will
        // arrive via sync (host-reload case). UI shows "Loading room…".
      } else if (existingRoom.hostEncPubKey !== this.hostKeypair.pub) {
        // Local claim disagrees with the synced room. Possible causes:
        //   - Two devices both claimed host of this room (clients trust
        //     themselves, so this is allowed but won't work cleanly).
        //   - A previous version of this client wrote the row.
        // We do NOT overwrite the row; the existing host remains canonical.
        // Host-only writes will fail the requireHostForWrite check below.
        // eslint-disable-next-line no-console
        console.warn(
          `TinyBaseRoomStoreClient: local host claim for ${opts.roomId} does not match synced room.hostEncPubKey; this client will behave as a non-host`
        );
      }
    }

    // Rejoin: preserve prior membership. If the synced player row already has
    // us as ready, keep us ready so a reload/SPA-revisit doesn't drop us back
    // to "not joined" — which would otherwise be unrecoverable when the room
    // is mid-game (the lobby's Join toggle isn't rendered with status='active').
    // The synced row may not have arrived yet at this point; the per-player
    // listener installed below promotes selfReady the moment it does.
    const priorRow = readRow(zPlayer, this.store, 'players', this.identity.playerId);
    if (priorRow?.isReady === true) {
      this.selfReady = true;
    }
    this.installSelfReadyHoist();

    this.upsertSelfPlayer();
    this.heartbeat = window.setInterval(() => this.upsertSelfPlayer(), HEARTBEAT_INTERVAL_MS);
  }

  // Listens for our own player row appearing/changing in the synced store.
  // If the synced row says isReady=true and we still believe we're not ready
  // (typical right after connect, before the initial sync delivers our row),
  // hoist it into selfReady once. We never demote: an explicit
  // `setSelfReady(false)` is the only way to clear readiness, so a remote
  // tab toggling us off can't fight our local setSelfReady writes.
  private hoistListenerId: string | null = null;
  private installSelfReadyHoist(): void {
    if (this.hoistListenerId != null) {
      this.store.delListener(this.hoistListenerId);
      this.hoistListenerId = null;
    }
    this.hoistListenerId = this.store.addRowListener(
      'players',
      this.identity.playerId,
      () => {
        if (this.selfReady) return;
        const row = readRow(zPlayer, this.store, 'players', this.identity.playerId);
        if (row?.isReady === true) {
          this.selfReady = true;
          // Re-stamp our own row so a subsequent local heartbeat doesn't
          // accidentally regress isReady on its next tick.
          this.upsertSelfPlayer();
        }
      }
    );
  }

  disconnect(): void {
    this.gameHostLoop?.stop();
    this.gameHostLoop = null;
    this.chatHostLoop?.stop();
    this.chatHostLoop = null;
    if (this.heartbeat != null) {
      window.clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (this.hoistListenerId != null) {
      this.store.delListener(this.hoistListenerId);
      this.hoistListenerId = null;
    }
    if (this.sync) {
      void this.sync.stop();
      this.sync.destroy();
      this.sync = null;
    }
    this.connectedRoomId = null;
    this.hostKeypair = null;

    // Clear any previously-synced rows so a future connect starts clean and UI
    // doesn't briefly render stale players/room data.
    this.store.delTables();
    this.store.setTablesSchema(ROOM_TABLES_SCHEMA);
  }

  /** Permanent teardown (use when navigating away to free memory). */
  destroy(): void {
    this.gameHostLoop?.stop();
    this.gameHostLoop = null;
    this.chatHostLoop?.stop();
    this.chatHostLoop = null;
    if (this.heartbeat != null) {
      window.clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (this.hoistListenerId != null) {
      this.store.delListener(this.hoistListenerId);
      this.hoistListenerId = null;
    }
    if (this.sync) {
      void this.sync.stop();
      this.sync.destroy();
      this.sync = null;
    }
    this.connectedRoomId = null;
    this.hostKeypair = null;
    this.store.delTables();
  }

  // ─── Dev-only escape hatch ───────────────────────────────────────────────
  // During development it's acceptable to wipe a room if the shared object has
  // invalid rows that would otherwise crash strict Zod parsing. The caller
  // must supply the same defaults they would have on initial creation; we
  // deliberately don't keep them around between connects.
  resetRoomAsHost(bootstrap: HostRoomBootstrap): void {
    this.requireHostForWrite('resetRoomAsHost');
    const roomId = this.connectedRoomId;
    if (!roomId) throw new Error('resetRoomAsHost: not connected');
    const hostKeypair = this.requireHostKeypair();

    this.store.delTables();
    this.store.setTablesSchema(ROOM_TABLES_SCHEMA);
    this.bootstrapRoomAsHost({ roomId, hostKeypair, bootstrap });
    this.upsertSelfPlayer();
  }

  // ─── Player-side writes ─────────────────────────────────────────────────

  private upsertSelfPlayer(): void {
    const now = Date.now();
    writeRow(this.store, 'players', {
      id: this.identity.playerId,
      displayName: this.displayName,
      avatarColor: this.avatarColor,
      role: 'player',
      score: 0,
      isConnected: true,
      isReady: this.selfReady,
      joinedAt: this.joinedAt,
      lastSeen: now,
      signingPubKey: this.identity.signing.pub,
      encPubKey: this.identity.enc.pub,
      autoplayMode: 'off',
      autoplaySince: null
    });
  }

  // Player → host encrypted submission. The caller has already encrypted
  // the move payload (AES-GCM via X25519 ECDH). This method can either accept
  // pre-encrypted bytes (iv + ciphertext) or plaintext (which it will encrypt
  // to the current hostEncPubKey).
  async submit(input: SubmitInput): Promise<SubmissionId> {
    const room = this.requireConnectedRoom();
    const id = makeSubmissionId();
    const nonce = this.getNextSubmissionNonce() as SubmissionNonce;
    const createdAt = 0 as UnixMs;
    const gameType = input.gameType ?? room.gameType;
    const fromPlayerId = this.identity.playerId;

    const encrypted =
      input.iv && input.toHostCiphertext
        ? { iv: input.iv, toHostCiphertext: input.toHostCiphertext }
        : input.plaintext
          ? await encryptSubmissionToHost({
              identity: this.identity,
              hostEncPubKey: room.hostEncPubKey,
              aad: {
                fromPlayerId,
                createdAt,
                nonce,
                gameType,
                kind: input.kind,
                hostEncPubKey: room.hostEncPubKey
              },
              plaintext: input.plaintext
            })
          : null;

    if (!encrypted) {
      throw new Error('submit: provide either (iv + toHostCiphertext) or plaintext');
    }

    const signature = await signSubmission(this.identity, {
      fromPlayerId,
      createdAt,
      nonce,
      iv: encrypted.iv,
      toHostCiphertext: encrypted.toHostCiphertext,
      gameType,
      kind: input.kind,
      hostEncPubKey: room.hostEncPubKey
    });

    const row: Submission = {
      id,
      fromPlayerId,
      toHostCiphertext: encrypted.toHostCiphertext,
      iv: encrypted.iv,
      signature,
      nonce,
      createdAt,
      gameType,
      kind: input.kind
    };
    writeRow(this.store, 'submissions', row);
    return id;
  }

  async submitLobbyChatMessage(input: { text: string }): Promise<ChatSubmissionId> {
    const room = this.requireConnectedRoom();
    const id = makeChatSubmissionId();
    const nonce = this.getNextSubmissionNonce() as SubmissionNonce;
    const createdAt = Date.now() as UnixMs;
    const fromPlayerId = this.identity.playerId;

    const message = zLobbyChatMessage.parse({ text: input.text });
    const encrypted = await encryptLobbyChatMessageToHost({
      identity: this.identity,
      hostEncPubKey: room.hostEncPubKey,
      fromPlayerId,
      createdAt,
      nonce,
      message
    });

    const signature = await signLobbyChatSubmission(this.identity, {
      fromPlayerId,
      createdAt,
      nonce,
      iv: encrypted.iv,
      toHostCiphertext: encrypted.toHostCiphertext,
      hostEncPubKey: room.hostEncPubKey
    });

    const row = zLobbyChatSubmission.parse({
      id,
      fromPlayerId,
      toHostCiphertext: encrypted.toHostCiphertext,
      iv: encrypted.iv,
      signature,
      nonce,
      createdAt
    }) as LobbyChatSubmission;
    writeRow(this.store, 'chatSubmissions', row);
    return id;
  }

  // ─── Host-only writes (guarded by `requireHost`) ────────────────────────

  async writeEvent(event: RoomEvent): Promise<void> {
    this.requireHostForWrite('writeEvent');
    writeRow(this.store, 'events', event);
  }

  async writeEventsPrivate(row: EventsPrivate): Promise<void> {
    this.requireHostForWrite('writeEventsPrivate');
    writeRow(this.store, 'eventsPrivate', row);
  }

  async writeGameStatePublic(snapshot: GameStatePublic): Promise<void> {
    this.requireHostForWrite('writeGameStatePublic');
    writeRow(this.store, 'gameStatePublic', snapshot);
  }

  async writeGameStateHistoryRow(row: GameStateHistoryRow): Promise<void> {
    this.requireHostForWrite('writeGameStateHistoryRow');
    writeRow(this.store, 'gameStateHistory', row);
  }

  async writeGameStatePrivate(snapshot: GameStatePrivate): Promise<void> {
    this.requireHostForWrite('writeGameStatePrivate');
    writeRow(this.store, 'gameStatePrivate', snapshot);
  }

  async encryptJsonToPlayerForGameStatePrivate(opts: {
    toPlayerId: PlayerId;
    seq: number;
    gameType: GameType;
    kind: string;
    value: unknown;
  }): Promise<{ kind: 'encrypted'; ciphertext: EncryptedPayload; iv: SecretMessageIv }> {
    this.requireHostForWrite('encryptJsonToPlayerForGameStatePrivate');
    const room = this.requireConnectedRoom();
    if (!this.hostKeypair) throw new Error('encryptJsonToPlayerForGameStatePrivate: missing hostKeypair');
    const player = this.getPlayers().find((p) => p.id === opts.toPlayerId);
    if (!player) throw new Error(`encryptJsonToPlayerForGameStatePrivate: missing player ${opts.toPlayerId}`);

    const plaintext = new TextEncoder().encode(JSON.stringify(opts.value));
    const createdAt = 0; // Fixed in AAD so decryption doesn't need the timestamp stored in the row.
    const encrypted = await encryptHostMessageToPlayer({
      hostKeypair: this.hostKeypair,
      playerEncPubKey: player.encPubKey,
      aad: {
        toPlayerId: opts.toPlayerId,
        createdAt,
        seq: opts.seq,
        gameType: opts.gameType,
        kind: opts.kind,
        hostEncPubKey: room.hostEncPubKey,
        playerEncPubKey: player.encPubKey
      },
      plaintext
    });

    return {
      kind: 'encrypted',
      ciphertext: encrypted.ciphertextToPlayer,
      iv: encrypted.iv
    };
  }

  async decryptJsonForSelfFromGameStatePrivate(opts: {
    row: GameStatePrivate;
    seq: number;
    gameType: GameType;
    kind: string;
  }): Promise<unknown> {
    const room = this.requireConnectedRoom();
    if (opts.row.kind === 'plain') return opts.row.state;

    const createdAt = 0; // Not stored in row; we keep it fixed in AAD for v1 snapshots.
    const bytes = await decryptHostMessageFromHost({
      identity: this.identity,
      hostEncPubKey: room.hostEncPubKey,
      aad: {
        toPlayerId: opts.row.id,
        createdAt,
        seq: opts.seq,
        gameType: opts.gameType,
        kind: opts.kind,
        hostEncPubKey: room.hostEncPubKey,
        playerEncPubKey: this.identity.enc.pub
      },
      iv: opts.row.iv,
      ciphertextToPlayer: opts.row.ciphertext
    });
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  async updateRoomAsHost(patch: Partial<Omit<Room, 'id'>>): Promise<Room> {
    this.requireHostForWrite('updateRoomAsHost');
    const room = this.requireConnectedRoom();

    // Determinism inputs are locked once a match is active/finished.
    if (room.status === 'active' || room.status === 'finished') {
      const touchesLocked =
        'gameType' in patch ||
        'gameConfig' in patch ||
        'maxPlayers' in patch ||
        'seed' in patch;
      if (touchesLocked) {
        throw new Error('updateRoomAsHost: game config is locked while active/finished');
      }
    }

    const next = zRoom.parse({ ...room, ...patch });
    writeRow(this.store, 'room', next);
    return next;
  }

  async exportGameRecord(opts: {
    appVersion: string;
    engineVersion: string;
  }): Promise<GameExportV1> {
    this.requireHostForWrite('exportGameRecord');
    const room = this.requireConnectedRoom();
    const hostKeypair = this.requireHostKeypair();
    const events = this.getEvents().sort((a, b) => a.seq - b.seq);
    const players = this.getPlayers();

    const finalizedEvent = events.find((e) => e.kind === GAME_FINALIZED_KIND);
    const finalizedPayload = finalizedEvent?.publicPayload as
      | { outcome?: string; winnerPlayerIds?: string[] }
      | null
      | undefined;

    const startedAt = events[0]?.createdAt ?? (Date.now() as UnixMs);
    const finishedAt = finalizedEvent?.createdAt ?? (Date.now() as UnixMs);
    const outcome = (finalizedPayload?.outcome ?? 'abandoned') as 'win' | 'draw' | 'abandoned';
    const winnerPlayerIds = finalizedPayload?.winnerPlayerIds ?? [];

    const bundle: Omit<GameExportV1, 'exportSignature'> = {
      exportVersion: 1,
      exportedAt: Date.now() as UnixMs,
      platform: {
        appVersion: opts.appVersion,
        gameType: room.gameType,
        gameVersion: opts.engineVersion
      },
      room: {
        roomId: room.id,
        gameConfig: room.gameConfig,
        seed: room.seed,
        startedAt,
        finishedAt,
        outcome,
        winnerPlayerIds
      },
      players: players.map((p) => ({
        playerId: p.id,
        displayName: p.displayName,
        avatarColor: p.avatarColor,
        role: p.role,
        signingPubKey: p.signingPubKey,
        encPubKey: p.encPubKey
      })),
      hostSigningPubKey: this.identity.signing.pub,
      events: events.map((e) => ({
        id: e.id,
        seq: e.seq,
        createdAt: e.createdAt,
        kind: e.kind,
        publicPayload: e.publicPayload,
        fromPlayerId: e.fromPlayerId,
        hostSignature: e.hostSignature
      }))
    };

    const exportSignature = await signExport(this.identity.signing.privKey, bundle);
    return { ...bundle, exportSignature };
  }

  // Returns a host-side submission validator wired to this room. Throws if
  // the caller is not the host. The returned validator holds in-memory nonce
  // state — reuse one instance for the lifetime of a host session.
  createHostValidator(): HostSubmissionValidator {
    this.requireHostForWrite('createHostValidator');
    const hostKeypair = this.requireHostKeypair();
    return new HostSubmissionValidator({
      hostEncPubKey: hostKeypair.pub,
      getPlayerSigningPubKey: (playerId) => {
        const players = this.getPlayers();
        const p = players.find((row) => row.id === playerId);
        return p?.signingPubKey ?? null;
      }
    });
  }

  createLobbyChatValidator(): HostLobbyChatValidator {
    this.requireHostForWrite('createLobbyChatValidator');
    const hostKeypair = this.requireHostKeypair();
    return new HostLobbyChatValidator({
      hostEncPubKey: hostKeypair.pub,
      getPlayerSigningPubKey: (playerId) => {
        const players = this.getPlayers();
        const p = players.find((row) => row.id === playerId);
        return p?.signingPubKey ?? null;
      }
    });
  }

  // Host-only: decrypt a submission after signature+nonce validation.
  async decryptSubmissionForHost(submission: Submission): Promise<Uint8Array<ArrayBuffer>> {
    this.requireHostForWrite('decryptSubmissionForHost');
    const room = this.requireConnectedRoom();
    const hostKeypair = this.requireHostKeypair();
    const players = this.getPlayers();
    const p = players.find((row) => row.id === submission.fromPlayerId);
    if (!p) {
      throw new Error(`decryptSubmissionForHost: player ${submission.fromPlayerId} not found`);
    }
    return decryptSubmissionFromPlayer({
      hostKeypair,
      playerEncPubKey: p.encPubKey,
      hostEncPubKey: room.hostEncPubKey,
      aad: {
        fromPlayerId: submission.fromPlayerId,
        createdAt: submission.createdAt,
        nonce: submission.nonce,
        gameType: submission.gameType,
        kind: submission.kind,
        hostEncPubKey: room.hostEncPubKey,
        playerEncPubKey: p.encPubKey
      },
      iv: submission.iv,
      toHostCiphertext: submission.toHostCiphertext
    });
  }

  async decryptLobbyChatSubmissionForHost(
    submission: LobbyChatSubmission
  ): Promise<{ text: string }> {
    this.requireHostForWrite('decryptLobbyChatSubmissionForHost');
    const room = this.requireConnectedRoom();
    const hostKeypair = this.requireHostKeypair();
    const players = this.getPlayers();
    const p = players.find((row) => row.id === submission.fromPlayerId);
    if (!p) {
      throw new Error(`decryptLobbyChatSubmissionForHost: player ${submission.fromPlayerId} not found`);
    }
    const msg = await decryptLobbyChatMessageFromPlayer({
      hostKeypair,
      playerEncPubKey: p.encPubKey,
      hostEncPubKey: room.hostEncPubKey,
      fromPlayerId: submission.fromPlayerId,
      createdAt: submission.createdAt,
      nonce: submission.nonce,
      iv: submission.iv,
      toHostCiphertext: submission.toHostCiphertext
    });
    return msg;
  }

  async writeLobbyChatEvent(input: {
    seq: EventSeq;
    createdAt: UnixMs;
    fromPlayerId: PlayerId;
    text: string;
  }): Promise<LobbyChatEvent> {
    this.requireHostForWrite('writeLobbyChatEvent');
    const id = makeChatEventId();
    const unsigned = {
      id,
      seq: input.seq,
      createdAt: input.createdAt,
      fromPlayerId: input.fromPlayerId,
      text: input.text
    };
    const hostSignature = await signLobbyChatEvent(this.identity, unsigned);
    const row = zLobbyChatEvent.parse({ ...unsigned, hostSignature }) as LobbyChatEvent;
    writeRow(this.store, 'chatEvents', row);
    return row;
  }

  // ─── Host loops + action application ────────────────────────────────────
  //
  // `applyHostActions` is the single host-side "write events + snapshots"
  // primitive. It assigns monotone seq numbers to events (starting from
  // `max(existing event.seq) + 1`), signs them, and tags any
  // `gameStatePublic`/`gameStatePrivate` snapshots with the seq of the most
  // recent event in the batch (or the pre-batch max if no events were
  // emitted). This unifies the seq semantics that used to live ad-hoc in the
  // play route's host effect.

  async applyHostActions(actions: ReadonlyArray<HostLoopAction>): Promise<void> {
    if (actions.length === 0) return;
    this.requireHostForWrite('applyHostActions');
    const existingEvents = this.getEvents();
    const maxSeq = existingEvents.reduce((m, e) => (e.seq > m ? e.seq : m), -1);
    let nextEventSeq = (maxSeq + 1) as EventSeq;

    for (const action of actions) {
      switch (action.kind) {
        case 'event': {
          const eventSeq = nextEventSeq;
          nextEventSeq = (nextEventSeq + 1) as EventSeq;
          await this.writeEvent(
            await this.signedEvent({
              seq: eventSeq,
              eventKind: action.eventKind,
              publicPayload: action.publicPayload,
              fromPlayerId: action.fromPlayerId ?? this.identity.playerId
            })
          );
          break;
        }
        case 'gameStatePublic': {
          // Snapshot reflects state through the most recently-issued event in
          // this batch. If no event was issued yet, use the previous max.
          const seq = (nextEventSeq - 1) as EventSeq;
          await this.writeGameStatePublic(
            await this.signedGameStatePublic({ seq, state: action.state })
          );
          break;
        }
        case 'gameStateHistory': {
          // History rows align to the same seq convention as gameStatePublic:
          // the most recently-issued event in this batch (or the previous max
          // if no events were emitted).
          const seq = (nextEventSeq - 1) as EventSeq;
          await this.writeGameStateHistoryRow(
            await this.signedGameStateHistoryRow({ seq, state: action.state })
          );
          break;
        }
        case 'gameStatePrivate': {
          const seq = (nextEventSeq - 1) as EventSeq;
          const room = this.requireConnectedRoom();
          for (const item of action.perPlayer) {
            const enc = await this.encryptJsonToPlayerForGameStatePrivate({
              toPlayerId: item.playerId,
              seq,
              gameType: room.gameType,
              kind: item.kind,
              value: item.value
            });
            await this.writeGameStatePrivate({
              id: item.playerId,
              kind: 'encrypted',
              seq,
              ciphertext: enc.ciphertext,
              iv: enc.iv
            });
          }
          break;
        }
        case 'updateRoom': {
          await this.updateRoomAsHost(action.patch);
          break;
        }
      }
    }
  }

  startHostLoop(handlers: HostLoopHandlers): HostLoopHandle {
    // Validates the caller is host and we hold the keypair.
    this.requireHostForWrite('startHostLoop');

    // If an old loop is still running, stop it. This makes the API resilient
    // to React effect remounts: the second `startHostLoop` call wins, and
    // we never have two validators racing on seq counters.
    this.gameHostLoop?.stop();

    const validator = new HostSubmissionValidator({
      hostEncPubKey: this.requireHostKeypair().pub,
      getPlayerSigningPubKey: (playerId) => {
        const players = this.getPlayers();
        const p = players.find((row) => row.id === playerId);
        return p?.signingPubKey ?? null;
      }
    });

    // Prime per-player nonce highs from existing submissions so a host
    // restart doesn't accept replays.
    const submissions = this.getSubmissions();
    const maxNonceByPlayer = new Map<string, number>();
    for (const s of submissions) {
      const prev = maxNonceByPlayer.get(s.fromPlayerId) ?? -1;
      if (s.nonce > prev) maxNonceByPlayer.set(s.fromPlayerId, s.nonce);
    }
    for (const [playerId, nonce] of maxNonceByPlayer) {
      validator.primeNonce(playerId as never, nonce);
    }

    // Seed the processed-set from existing `host/accepted_submission` events
    // so we don't re-emit downstream events on host reconnect.
    const processed = new Set<string>();
    for (const e of this.getEvents()) {
      if (e.kind !== HOST_ACCEPTED_SUBMISSION_KIND) continue;
      const p = e.publicPayload as { submissionId?: unknown } | null;
      if (p && typeof p.submissionId === 'string') processed.add(p.submissionId);
    }

    let stopped = false;
    const unsubscribe = this.onSubmissionsChanged((subs) => {
      if (stopped) return;
      void (async () => {
        const room = this.getRoomOrNull(this.connectedRoomId ?? '');
        if (!room) return;

        for (const s of subs) {
          if (stopped) return;
          if (processed.has(s.id)) continue;

          const ok = await validator.validate(s);
          if (!ok.ok) {
            // Mark as processed so we don't keep retrying invalid submissions.
            processed.add(s.id);
            continue;
          }

          const plaintext = await this.decryptSubmissionForHost(s);

          let actions: HostLoopAction[] | null = null;
          try {
            actions = await Promise.resolve(
              handlers.onSubmission({ submission: s, plaintext, room })
            );
          } catch (err) {
            // Engine threw on this submission; drop it. Mark as processed so
            // it doesn't retry forever.
            // eslint-disable-next-line no-console
            console.error('host loop: onSubmission threw, dropping submission', err);
            processed.add(s.id);
            continue;
          }

          // Always mark as processed (and emit the bookkeeping event) so we
          // don't reprocess on restart, even if the engine returned null.
          processed.add(s.id);

          const ackAction: HostLoopAction = {
            kind: 'event',
            eventKind: HOST_ACCEPTED_SUBMISSION_KIND,
            publicPayload: { submissionId: s.id },
            fromPlayerId: s.fromPlayerId
          };

          const allActions: HostLoopAction[] = actions ? [ackAction, ...actions] : [ackAction];
          await this.applyHostActions(allActions);
        }
      })();
    });

    const handle: HostLoopHandle = {
      stop: () => {
        stopped = true;
        unsubscribe();
      }
    };
    this.gameHostLoop = handle;
    return handle;
  }

  startLobbyChatHostLoop(): HostLoopHandle {
    this.requireHostForWrite('startLobbyChatHostLoop');
    this.chatHostLoop?.stop();

    const validator = new HostLobbyChatValidator({
      hostEncPubKey: this.requireHostKeypair().pub,
      getPlayerSigningPubKey: (playerId) => {
        const players = this.getPlayers();
        const p = players.find((row) => row.id === playerId);
        return p?.signingPubKey ?? null;
      }
    });

    // Seed processed-set from existing chat events. Chat events don't carry a
    // submission ID directly, so we use (fromPlayerId, createdAt) as a stable
    // best-effort key to avoid double-emitting on host reload. Any remaining
    // duplicates are harmless from the player's perspective (chat is
    // append-only) but would inflate the event log unnecessarily.
    const processed = new Set<string>();
    for (const e of this.getLobbyChatEvents()) {
      processed.add(`${e.fromPlayerId}:${e.createdAt}`);
    }

    let stopped = false;
    const unsubscribe = this.onLobbyChatSubmissionsChanged((subs) => {
      if (stopped) return;
      void (async () => {
        for (const s of subs) {
          if (stopped) return;
          const key = `${s.fromPlayerId}:${s.createdAt}`;
          if (processed.has(key)) continue;
          processed.add(key);

          const ok = await validator.validate(s);
          if (!ok.ok) continue;

          const msg = await this.decryptLobbyChatSubmissionForHost(s);
          const existing = this.getLobbyChatEvents();
          const maxSeq = existing.reduce((m, e) => (e.seq > m ? e.seq : m), -1);
          const seq = (maxSeq + 1) as EventSeq;
          await this.writeLobbyChatEvent({
            seq,
            createdAt: Date.now() as UnixMs,
            fromPlayerId: s.fromPlayerId,
            text: msg.text
          });
        }
      })();
    });

    const handle: HostLoopHandle = {
      stop: () => {
        stopped = true;
        unsubscribe();
      }
    };
    this.chatHostLoop = handle;
    return handle;
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private async signedEvent(opts: {
    seq: EventSeq;
    eventKind: string;
    publicPayload: unknown;
    fromPlayerId: PlayerId;
  }): Promise<RoomEvent> {
    const unsigned: Omit<RoomEvent, 'hostSignature'> = {
      id: makeEventId(),
      seq: opts.seq,
      createdAt: Date.now() as UnixMs,
      kind: opts.eventKind,
      publicPayload: opts.publicPayload,
      fromPlayerId: opts.fromPlayerId
    };
    const hostSignature = await signEvent(this.identity, unsigned);
    return zEvent.parse({ ...unsigned, hostSignature }) as RoomEvent;
  }

  private async signedGameStateHistoryRow(opts: {
    seq: EventSeq;
    state: unknown;
  }): Promise<GameStateHistoryRow> {
    const unsigned = { id: String(opts.seq), seq: opts.seq, state: opts.state };
    const hostSignature = await signGameStateHistoryRow(this.identity, unsigned);
    return zGameStateHistoryRow.parse({ ...unsigned, hostSignature }) as GameStateHistoryRow;
  }

  private async signedGameStatePublic(opts: {
    seq: EventSeq;
    state: unknown;
  }): Promise<GameStatePublic> {
    const unsigned = {
      id: SINGLETON_PUBLIC_STATE_ID,
      seq: opts.seq,
      state: opts.state
    } as const;
    const hostSignature = await signGameStatePublic(this.identity, unsigned);
    return zGameStatePublic.parse({ ...unsigned, hostSignature }) as GameStatePublic;
  }

  // Writes the canonical `room` row using the caller-supplied bootstrap
  // defaults. Idempotent in the CRDT sense: two hosts that bootstrap the same
  // room with the same `hostKeypair` will write byte-identical rows. Different
  // host keypairs would produce conflicting `hostEncPubKey` values, but the
  // trust-the-client model gates this by the local `LocalStore.getHostClaim`.
  private bootstrapRoomAsHost(opts: {
    roomId: RoomId;
    hostKeypair: LoadedGameHostKeypair;
    bootstrap: TinyBaseBootstrapRoom;
  }): void {
    const now = Date.now();
    writeRow(this.store, 'room', {
      id: opts.roomId,
      inviteCode: '',
      hostPlayerId: this.identity.playerId,
      hostEncPubKey: opts.hostKeypair.pub,
      status: 'waiting',
      maxPlayers: opts.bootstrap.maxPlayers ?? 8,
      seed: opts.bootstrap.seed ?? String(now),
      gameType: opts.bootstrap.gameType,
      gameConfig: opts.bootstrap.gameConfig ?? {},
      dropBehavior: 'pause',
      disconnectGraceMs: 15_000,
      turnTimeoutMs: 0
    });
  }

  private requireConnectedRoom(): Room {
    if (!this.connectedRoomId) {
      throw new Error('TinyBaseRoomStoreClient: not connected');
    }
    const room = this.getRoomOrNull(this.connectedRoomId);
    if (!room) {
      throw new Error(`TinyBaseRoomStoreClient: room ${this.connectedRoomId} not found`);
    }
    return room;
  }

  private requireHostForWrite(context: string): void {
    const room = this.requireConnectedRoom();
    requireHost(this.identity.playerId, room.hostPlayerId, context);

    // Trust-the-client host gate: even if `room.hostPlayerId` matches our
    // identity, we must hold the matching host keypair locally. Otherwise we
    // can't sign or decrypt anything host-authoritatively, and writing under
    // someone else's host pubkey would produce events that no one can verify.
    if (!this.hostKeypair) {
      throw new Error(`${context}: no local host claim — refusing host-only write`);
    }
    if (room.hostEncPubKey !== this.hostKeypair.pub) {
      throw new Error(
        `${context}: local host keypair does not match room.hostEncPubKey — refusing host-only write`
      );
    }
  }

  private requireHostKeypair(): LoadedGameHostKeypair {
    if (!this.hostKeypair) {
      throw new Error(
        'TinyBaseRoomStoreClient: no host keypair loaded — this client is not hosting'
      );
    }
    return this.hostKeypair;
  }
}

// Silence unused-import nags without changing the public surface; these are
// re-exported for callers who need to read or validate rows directly.
export { zEventsPrivate, zGameStatePrivate, zGameStatePublic };
