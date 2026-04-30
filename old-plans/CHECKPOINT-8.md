# CHECKPOINT 8 — Controlled seeds + more deterministic, replayable games

Date: 2026-04-26

This checkpoint is a delta from `old-plans/CHECKPOINT-7.md`.

## High-level themes

Checkpoint 7 surfaced a key reproducibility gap: we already *derive* randomness from `room.seed`, but the host bootstrap was still generating the seed implicitly (time-based). This checkpoint closes that loop by making seeds a **first-class, caller-controlled input**, so game setups can be replayed intentionally.

In the same spirit, we extended the “engine plugin” surface by adding a couple more **seed-driven game engines** (Hangman, Bingo). These are lightweight engines intended to validate that:

- the `GameEngine` abstraction holds up for multiple game types,
- host-authoritative loops are easy to exercise,
- and seeded randomness produces consistent results from the same room seed.

## What changed since CHECKPOINT 7

### Controlled seeds for room bootstrapping (determinism knob)

We made it possible to supply a deterministic seed when creating a hosted room, rather than always falling back to timestamps.

- **Why**: reproducibility requires the ability to intentionally set the seed, then re-run the same “initial deal / board / word selection” deterministically.
- **What**:
  - `HostRoomBootstrap` now supports an optional `seed`.
  - The host’s initial room-row bootstrap uses the provided seed for `room.seed` when present.
  - `SyncContext.createHostedRoom(...)` accepts an optional `seed` so callers can control it at room creation time.

Net effect: “same seed + same room id + same game” yields the same initial random-derived setup.

Practical note: the seed is currently **plumbed as an API input**, not exposed as a first-class UI field yet. If you don’t pass a seed, the host continues to use the previous time-based default.

### More games that lean on `room.seed` for reproducible setups

We introduced two additional engines that intentionally use `room.seed` as the root of any randomness:

- **Hangman**:
  - chooses a word deterministically from a word list using a seed derived from `room.seed` + room identity
  - uses encrypted host-private state to keep the plaintext word from observers
  - ends with a clean `finished` state and room status update
  - implements `autoPlay` as “guess the next most common letter not yet guessed”

- **Bingo**:
  - generates each player’s board deterministically from `room.seed` + player id
  - generates a deterministic call order once (host-private) from `room.seed`
  - keeps public state as called numbers + per-player derived board stats
  - implements `autoPlay` as “call the next number” on your turn

Net effect: these engines serve as “determinism testbeds” for the host loop + state model, and help validate that the plugin architecture stays consistent as the game catalog grows.

### Registry expansion

We registered the new engines in the central game registry so they can be selected/loaded like existing games.

Practical note: these engines are also wired into the **host lobby “Game” selector** (Hangman/Bingo appear as options), so you can start them from the normal room flow.

## Current workspace status (sanity check)

As of writing this doc, this checkpoint exists in the working tree and includes new untracked game-engine folders (Hangman/Bingo). If you want this checkpoint to be “real” in the git history, the new engine files need committing along with the seed-plumbing changes.

## Notes / known gaps

- Seed control currently applies at **room creation/bootstrap time**. If we later want “change seed and restart game in the same room,” we should make seed either:
  - part of the host-only “reset room” flow, or
  - a game-config field that is copied into (and/or derived into) the room seed when starting a match.
- Determinism still depends on the definition of “same inputs” (same ready player set/order, same game config, same room id, same seed). If any of these drift, the derived setup will drift too — which is expected.

