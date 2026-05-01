import {
  GOFISH_EVT_ASKED,
  GOFISH_EVT_BOOK_MADE,
  GOFISH_EVT_DEALT,
  GOFISH_EVT_DREW,
  GOFISH_EVT_GAME_OVER,
  GOFISH_EVT_GO_FISH,
  GOFISH_EVT_TRANSFERRED,
  GOFISH_RANKS,
  GOFISH_SUBMIT_ASK,
  GOFISH_SUBMIT_DRAW,
  zGoFishConfig,
  zGoFishPrivateState,
  zGoFishPublicState,
  zGoFishSubmission,
  type GoFishConfig,
  type GoFishPublicState,
  type GoFishRank
} from '@brute-force-games/shared-types';

import type { HostLoopAction, PlayerId } from '@brute-force-games/multiplayer-types';

import { defineGameEngine } from '../types';
import type {
  ActiveGameMetadata,
  ApplySubmissionInput,
  ApplySubmissionResult,
  AutoPlayInput,
  AutoPlayResult,
  GameEngine,
  GameStep,
  StartGameInput
} from '../types';

import { GoFishPlayerUI } from './PlayerUI';

const GOFISH_GAME_TYPE = 'gofish';
export const GOFISH_PRIVATE_KIND = 'gofish/state_private_v1' as const;

function ConfigUI() {
  return null;
}

function hashSeedToU32(seed: string): number {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleSeeded<T>(seed: string, items: readonly T[]): T[] {
  const rng = mulberry32(hashSeedToU32(seed));
  const a = items.slice() as T[];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

function makeGoFishDeck(): GoFishRank[] {
  const deck: GoFishRank[] = [];
  for (const r of GOFISH_RANKS) deck.push(r, r, r, r);
  return deck;
}

function countRanks(hand: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of hand) m.set(r, (m.get(r) ?? 0) + 1);
  return m;
}

// ─── Start game ─────────────────────────────────────────────────────────────

async function startGame(opts: StartGameInput<GoFishConfig>): Promise<HostLoopAction[]> {
  const participants = opts.readyPlayers.slice(0, 4);
  if (participants.length < 2) return [];

  const { room, ctx } = opts;
  const deckSeed = `${room.seed}|${room.id}|gofish|deal_v1`;
  const deck = shuffleSeeded(deckSeed, makeGoFishDeck());
  const handSize = participants.length === 2 ? 7 : 5;

  const handsByPlayerId: Record<string, GoFishRank[]> = {};
  for (const p of participants) handsByPlayerId[p.id] = [];
  for (let i = 0; i < handSize; i++) {
    for (const p of participants) {
      const card = deck.shift();
      if (!card) break;
      handsByPlayerId[p.id]!.push(card);
    }
  }

  const publicState = zGoFishPublicState.parse({
    phase: 'active',
    turnPlayerId: participants[0]!.id,
    deckCount: deck.length,
    players: participants.map((p) => ({
      playerId: p.id,
      handCount: handsByPlayerId[p.id]!.length,
      bookCount: 0
    })),
    winnerPlayerIds: []
  });

  const startingHandCounts = Object.fromEntries(
    participants.map((p) => [p.id, handsByPlayerId[p.id]!.length])
  );

  const perPlayer = participants.map((p) => ({
    playerId: p.id as PlayerId,
    kind: GOFISH_PRIVATE_KIND,
    value:
      p.id === ctx.selfPlayerId
        ? zGoFishPrivateState.parse({
            hand: handsByPlayerId[p.id]!,
            host: { deck, handsByPlayerId }
          })
        : zGoFishPrivateState.parse({ hand: handsByPlayerId[p.id]! })
  }));

  return [
    {
      kind: 'event',
      eventKind: GOFISH_EVT_DEALT,
      publicPayload: {
        kind: GOFISH_EVT_DEALT,
        startingHandCounts,
        deckCount: deck.length,
        firstTurnPlayerId: participants[0]!.id
      },
      fromPlayerId: ctx.selfPlayerId
    },
    { kind: 'gameStatePrivate', perPlayer },
    { kind: 'gameStatePublic', state: publicState },
    { kind: 'updateRoom', patch: { status: 'active' } }
  ];
}

// ─── Apply submission ───────────────────────────────────────────────────────

async function applySubmissionV1(
  opts: ApplySubmissionInput<GoFishConfig>
): Promise<HostLoopAction[] | null> {
  const { submission: s, plaintext, room, ctx } = opts;

  // ── Decode the submission ──────────────────────────────────────────────────
  const decoded = new TextDecoder().decode(plaintext);
  let submission: { kind: string } | null = null;
  try {
    const json = JSON.parse(decoded);
    const parsed = zGoFishSubmission.safeParse(json);
    if (parsed.success) submission = parsed.data;
  } catch {
    // invalid JSON
  }
  if (!submission) return null;

  // ── Shared: read + validate public state ──────────────────────────────────
  const snap = ctx.store.getGameStatePublicOrNull();
  const parsedPublic = snap ? zGoFishPublicState.safeParse(snap.state) : null;
  if (!parsedPublic || !parsedPublic.success) return null;
  const publicState = parsedPublic.data;
  if (publicState.phase !== 'active') return null;
  if (publicState.turnPlayerId !== s.fromPlayerId) return null;

  // ── Shared: decrypt host private state ────────────────────────────────────
  const hostPrivateRow = ctx.store.getGameStatePrivateOrNull(ctx.selfPlayerId);
  if (!hostPrivateRow) return null;
  const hostPrivateUnknown = await ctx.store.decryptJsonForSelfFromGameStatePrivate({
    row: hostPrivateRow,
    seq: hostPrivateRow.seq,
    gameType: room.gameType,
    kind: GOFISH_PRIVATE_KIND
  });
  const hostPrivateParsed = zGoFishPrivateState.safeParse(hostPrivateUnknown);
  const hostPrivateHost = hostPrivateParsed.success ? hostPrivateParsed.data.host : null;
  if (!hostPrivateHost) return null;

  const handsBy: Record<string, GoFishRank[]> = { ...hostPrivateHost.handsByPlayerId } as Record<
    string,
    GoFishRank[]
  >;
  const deck: GoFishRank[] = hostPrivateHost.deck.slice();

  // ── Draw handler ──────────────────────────────────────────────────────────
  if (submission.kind === GOFISH_SUBMIT_DRAW) {
    const playerHand = ((handsBy[s.fromPlayerId] ?? []) as GoFishRank[]).slice();
    if (playerHand.length > 0) return null; // hand not empty
    if (deck.length === 0) return null; // deck empty, nothing to draw

    const drawn = deck.shift()!;
    playerHand.push(drawn);
    handsBy[s.fromPlayerId] = playerHand;

    const actions: HostLoopAction[] = [];

    actions.push({
      kind: 'event',
      eventKind: GOFISH_EVT_DREW,
      publicPayload: {
        kind: GOFISH_EVT_DREW,
        playerId: s.fromPlayerId,
        deckCount: deck.length
      },
      fromPlayerId: s.fromPlayerId
    });

    // Check for books on the drawn card
    const bookCounts = new Map<string, number>(
      publicState.players.map((p) => [p.playerId, p.bookCount] as const)
    );
    const drawnCounts = countRanks(playerHand);
    for (const [rank, c] of drawnCounts) {
      if (c < 4) continue;
      const nextHand: GoFishRank[] = [];
      let removed = 0;
      for (const r of playerHand) {
        if (r === rank && removed < 4) removed++;
        else nextHand.push(r);
      }
      handsBy[s.fromPlayerId] = nextHand;
      const nextBookCount = (bookCounts.get(s.fromPlayerId) ?? 0) + 1;
      bookCounts.set(s.fromPlayerId, nextBookCount);
      actions.push({
        kind: 'event',
        eventKind: GOFISH_EVT_BOOK_MADE,
        publicPayload: {
          kind: GOFISH_EVT_BOOK_MADE,
          playerId: s.fromPlayerId,
          rank,
          newBookCount: nextBookCount
        },
        fromPlayerId: s.fromPlayerId
      });
    }

    const nextPlayers = publicState.players.map((p) => ({
      ...p,
      handCount: (handsBy[p.playerId] ?? []).length,
      bookCount: bookCounts.get(p.playerId) ?? p.bookCount
    }));

    const isOver = nextPlayers.some((p) => p.handCount === 0);
    const maxBooks = Math.max(...nextPlayers.map((p) => p.bookCount), 0);
    const winners = isOver
      ? nextPlayers.filter((p) => p.bookCount === maxBooks).map((p) => p.playerId)
      : [];

    if (isOver) {
      const bookCountsObj = Object.fromEntries(nextPlayers.map((p) => [p.playerId, p.bookCount]));
      actions.push({
        kind: 'event',
        eventKind: GOFISH_EVT_GAME_OVER,
        publicPayload: {
          kind: GOFISH_EVT_GAME_OVER,
          winnerPlayerIds: winners,
          bookCounts: bookCountsObj
        },
        fromPlayerId: s.fromPlayerId
      });
    }

    const nextPublic = zGoFishPublicState.parse({
      ...publicState,
      deckCount: deck.length,
      turnPlayerId: isOver ? null : (s.fromPlayerId as PlayerId),
      phase: isOver ? 'finished' : 'active',
      winnerPlayerIds: winners,
      players: nextPlayers
    });

    const perPlayer = nextPlayers.map((p) => ({
      playerId: p.playerId as PlayerId,
      kind: GOFISH_PRIVATE_KIND,
      value:
        p.playerId === ctx.selfPlayerId
          ? zGoFishPrivateState.parse({
              hand: handsBy[p.playerId] ?? [],
              host: { deck, handsByPlayerId: handsBy }
            })
          : zGoFishPrivateState.parse({ hand: handsBy[p.playerId] ?? [] })
    }));

    actions.push({ kind: 'gameStatePrivate', perPlayer });
    actions.push({ kind: 'gameStatePublic', state: nextPublic });
    if (isOver) actions.push({ kind: 'updateRoom', patch: { status: 'finished' } });

    return actions;
  }

  // ── Ask handler ───────────────────────────────────────────────────────────
  if (submission.kind !== GOFISH_SUBMIT_ASK) return null;

  let ask: { kind: typeof GOFISH_SUBMIT_ASK; targetPlayerId: PlayerId; rank: GoFishRank } | null =
    null;
  try {
    const parsed = zGoFishSubmission.safeParse(submission);
    if (parsed.success && parsed.data.kind === GOFISH_SUBMIT_ASK) ask = parsed.data;
  } catch {
    // invalid
  }
  if (!ask) return null;

  if (ask.targetPlayerId === s.fromPlayerId) return null;

  const askingHand = ((handsBy[s.fromPlayerId] ?? []) as GoFishRank[]).slice();
  const targetHand = ((handsBy[ask.targetPlayerId] ?? []) as GoFishRank[]).slice();
  if (!askingHand.includes(ask.rank)) return null;

  const actions: HostLoopAction[] = [];

  // Event: asked
  actions.push({
    kind: 'event',
    eventKind: GOFISH_EVT_ASKED,
    publicPayload: {
      kind: GOFISH_EVT_ASKED,
      askingPlayerId: s.fromPlayerId,
      targetPlayerId: ask.targetPlayerId,
      rank: ask.rank
    },
    fromPlayerId: s.fromPlayerId
  });

  const transferredCount = targetHand.filter((r) => r === ask.rank).length;
  let nextTurn: PlayerId = ask.targetPlayerId;

  if (transferredCount > 0) {
    handsBy[ask.targetPlayerId] = targetHand.filter((r) => r !== ask.rank);
    handsBy[s.fromPlayerId] = askingHand.concat(Array(transferredCount).fill(ask.rank));
    nextTurn = s.fromPlayerId as PlayerId;

    actions.push({
      kind: 'event',
      eventKind: GOFISH_EVT_TRANSFERRED,
      publicPayload: {
        kind: GOFISH_EVT_TRANSFERRED,
        fromPlayerId: ask.targetPlayerId,
        toPlayerId: s.fromPlayerId,
        rank: ask.rank,
        count: transferredCount
      },
      fromPlayerId: s.fromPlayerId
    });
  } else {
    let drewCard = false;
    if (deck.length > 0) {
      const drawn = deck.shift()!;
      drewCard = true;
      askingHand.push(drawn);
      handsBy[s.fromPlayerId] = askingHand;
      nextTurn =
        drawn === ask.rank ? (s.fromPlayerId as PlayerId) : (ask.targetPlayerId as PlayerId);
    }

    actions.push({
      kind: 'event',
      eventKind: GOFISH_EVT_GO_FISH,
      publicPayload: {
        kind: GOFISH_EVT_GO_FISH,
        playerId: s.fromPlayerId,
        deckCount: deck.length,
        drewCard
      },
      fromPlayerId: s.fromPlayerId
    });
  }

  // Detect new books for any player whose hand was modified.
  const bookCounts = new Map<string, number>(
    publicState.players.map((p) => [p.playerId, p.bookCount] as const)
  );
  const changed = new Set<PlayerId>([s.fromPlayerId as PlayerId, ask.targetPlayerId]);
  for (const pid of changed) {
    const hand = (handsBy[pid] ?? []).slice();
    const counts = countRanks(hand);
    for (const [rank, c] of counts) {
      if (c < 4) continue;
      let removed = 0;
      const nextHand: GoFishRank[] = [];
      for (const r of hand) {
        if (r === rank && removed < 4) removed++;
        else nextHand.push(r);
      }
      handsBy[pid] = nextHand;
      const nextBookCount = (bookCounts.get(pid) ?? 0) + 1;
      bookCounts.set(pid, nextBookCount);

      actions.push({
        kind: 'event',
        eventKind: GOFISH_EVT_BOOK_MADE,
        publicPayload: {
          kind: GOFISH_EVT_BOOK_MADE,
          playerId: pid,
          rank,
          newBookCount: nextBookCount
        },
        fromPlayerId: s.fromPlayerId
      });
    }
  }

  const nextPlayers = publicState.players.map((p) => ({
    ...p,
    handCount: (handsBy[p.playerId] ?? []).length,
    bookCount: bookCounts.get(p.playerId) ?? p.bookCount
  }));

  const isOver = nextPlayers.some((p) => p.handCount === 0);
  const maxBooks = Math.max(...nextPlayers.map((p) => p.bookCount), 0);
  const winners = isOver
    ? nextPlayers.filter((p) => p.bookCount === maxBooks).map((p) => p.playerId)
    : [];

  if (isOver) {
    const bookCountsObj = Object.fromEntries(nextPlayers.map((p) => [p.playerId, p.bookCount]));
    actions.push({
      kind: 'event',
      eventKind: GOFISH_EVT_GAME_OVER,
      publicPayload: {
        kind: GOFISH_EVT_GAME_OVER,
        winnerPlayerIds: winners,
        bookCounts: bookCountsObj
      },
      fromPlayerId: s.fromPlayerId
    });
  }

  const nextPublic = zGoFishPublicState.parse({
    ...publicState,
    deckCount: deck.length,
    turnPlayerId: isOver ? null : nextTurn,
    phase: isOver ? 'finished' : 'active',
    winnerPlayerIds: winners,
    players: nextPlayers
  });

  // Per-player private snapshots; host carries the full deck + all hands.
  const perPlayer = nextPlayers.map((p) => ({
    playerId: p.playerId as PlayerId,
    kind: GOFISH_PRIVATE_KIND,
    value:
      p.playerId === ctx.selfPlayerId
        ? zGoFishPrivateState.parse({
            hand: handsBy[p.playerId] ?? [],
            host: { deck, handsByPlayerId: handsBy }
          })
        : zGoFishPrivateState.parse({ hand: handsBy[p.playerId] ?? [] })
  }));

  actions.push({ kind: 'gameStatePrivate', perPlayer });
  actions.push({ kind: 'gameStatePublic', state: nextPublic });
  if (isOver) actions.push({ kind: 'updateRoom', patch: { status: 'finished' } });

  return actions;
}

async function autoPlay(opts: AutoPlayInput<GoFishConfig>): Promise<AutoPlayResult> {
  const { store, selfPlayerId, room, players } = opts;

  const snap = store.getGameStatePublicOrNull();
  if (!snap) return null;
  const parsed = zGoFishPublicState.safeParse(snap.state);
  if (!parsed.success) return null;
  const state = parsed.data;
  if (state.turnPlayerId !== selfPlayerId) return null;
  if (state.phase !== 'active') return null;

  const privateRow = store.getGameStatePrivateOrNull(selfPlayerId);
  if (!privateRow) return null;
  const privateUnknown = await store.decryptJsonForSelfFromGameStatePrivate({
    row: privateRow,
    seq: privateRow.seq,
    gameType: room.gameType,
    kind: GOFISH_PRIVATE_KIND
  });
  const privateParsed = zGoFishPrivateState.safeParse(privateUnknown);
  if (!privateParsed.success) return null;
  const hand = privateParsed.data.hand;

  if (hand.length === 0) {
    if (state.deckCount === 0) return null;
    return {
      submission: {
        kind: GOFISH_SUBMIT_DRAW,
        plaintext: new TextEncoder().encode(JSON.stringify({ kind: GOFISH_SUBMIT_DRAW }))
      },
      description: 'Drew a card (empty hand)'
    };
  }

  const rank = hand[0]!;
  const others = state.players.filter((p) => p.playerId !== selfPlayerId);
  if (others.length === 0) return null;
  const target = others[0]!;
  const targetName =
    players.find((p) => p.id === target.playerId)?.displayName ??
    target.playerId.slice(0, 10) + '…';

  return {
    submission: {
      kind: GOFISH_SUBMIT_ASK,
      plaintext: new TextEncoder().encode(
        JSON.stringify({ kind: GOFISH_SUBMIT_ASK, targetPlayerId: target.playerId, rank })
      )
    },
    description: `Asked ${targetName} for ${rank === 'A' ? 'Aces' : rank + 's'}`
  };
}

async function applySubmission(opts: ApplySubmissionInput<GoFishConfig>): Promise<ApplySubmissionResult | null> {
  const actionsV1 = await applySubmissionV1(opts);
  if (!actionsV1) return null;

  const actions = actionsV1.filter(
    (a) => !(a.kind === 'updateRoom' && (a.patch as { status?: unknown } | undefined)?.status === 'finished')
  );

  const lastPublic = [...actions].reverse().find((a) => a.kind === 'gameStatePublic');
  const parsed =
    lastPublic && lastPublic.kind === 'gameStatePublic'
      ? zGoFishPublicState.safeParse(lastPublic.state)
      : null;

  if (parsed?.success && parsed.data.phase === 'finished') {
    return {
      actions,
      outcome: { kind: 'won', winnerPlayerIds: parsed.data.winnerPlayerIds ?? [] }
    };
  }

  return { actions, outcome: { kind: 'continue' } };
}

function getActiveGameMetadata(input: {
  state: GoFishPublicState;
  players: ReadonlyArray<{ id: string; displayName: string }>;
  selfPlayerId: string;
}): ActiveGameMetadata {
  const { state } = input;
  const meta: ActiveGameMetadata = {
    phase: state.phase === 'finished' ? 'finished' : 'active',
    eligiblePlayerIds: state.turnPlayerId ? [state.turnPlayerId] : [],
    badges: [{ label: 'Deck', value: `${state.deckCount} cards` }],
    perPlayer: state.players.map((p) => ({
      playerId: p.playerId,
      isCurrent: state.turnPlayerId === p.playerId,
      secondary: `✋ ${p.handCount}  📚 ${p.bookCount}`
    }))
  };
  if (state.phase === 'finished') {
    meta.outcome = {
      kind: 'won',
      winnerPlayerIds: state.winnerPlayerIds,
      summary: state.winnerPlayerIds.length === 1 ? 'Winner' : 'Winners'
    };
  }
  return meta;
}

function formatStep(input: {
  step: GameStep;
  players: ReadonlyArray<{ id: string; displayName: string }>;
  currentState: GoFishPublicState | null;
}): { summary: string } | null {
  const { step } = input;
  if (step.kind.startsWith('host/')) return null;
  if (step.kind.startsWith('framework/')) return null;
  if (!step.kind.startsWith('gofish/')) return null;
  return { summary: step.kind };
}

export const GoFishGameEngine = defineGameEngine({
  gameType: GOFISH_GAME_TYPE,
  displayName: 'Go Fish',
  version: '1.0.0',
  configSchema: zGoFishConfig,
  stateSchema: zGoFishPublicState,
  defaultConfig: {
    minPlayers: 2,
    maxPlayers: 4,
    startingHandSize2p: 7,
    startingHandSize3pPlus: 5,
    mustHaveRankToAsk: true as const
  },
  minPlayers: 2,
  maxPlayers: 4,
  ConfigUI,
  startGame,
  applySubmission,
  getActiveGameMetadata,
  formatStep,
  PlayerUI: GoFishPlayerUI,
  autoPlay
} satisfies GameEngine<GoFishConfig, GoFishPublicState>);
