import { useEffect, useMemo, useState, type ReactElement } from 'react';

import {
  HANGMAN_EVT_GAME_OVER,
  HANGMAN_EVT_GUESSED,
  HANGMAN_EVT_STARTED,
  HANGMAN_SUBMIT_GUESS,
  zHangmanPublicState,
  type HangmanConfig
} from '@brute-force-games/shared-types';

import type { RoomEvent } from '@brute-force-games/multiplayer-types';

import type { PlayerUIProps } from '../types';

// ─── Hangman figure ───────────────────────────────────────────────────────────

function HangmanFigure({ wrongGuesses }: { wrongGuesses: number }) {
  const s = (n: number) => wrongGuesses >= n;
  return (
    <svg width={140} height={170} viewBox="0 0 140 170" style={{ display: 'block' }}>
      {/* Gallows */}
      <line x1={10} y1={160} x2={130} y2={160} stroke="#555" strokeWidth={3} strokeLinecap="round" />
      <line x1={50} y1={160} x2={50} y2={10} stroke="#555" strokeWidth={3} strokeLinecap="round" />
      <line x1={50} y1={10} x2={95} y2={10} stroke="#555" strokeWidth={3} strokeLinecap="round" />
      <line x1={95} y1={10} x2={95} y2={30} stroke="#555" strokeWidth={2} strokeLinecap="round" />
      {/* Head */}
      {s(1) && <circle cx={95} cy={42} r={12} stroke="#c0392b" strokeWidth={2.5} fill="none" />}
      {/* Body */}
      {s(2) && <line x1={95} y1={54} x2={95} y2={100} stroke="#c0392b" strokeWidth={2.5} strokeLinecap="round" />}
      {/* Left arm */}
      {s(3) && <line x1={95} y1={65} x2={74} y2={86} stroke="#c0392b" strokeWidth={2.5} strokeLinecap="round" />}
      {/* Right arm */}
      {s(4) && <line x1={95} y1={65} x2={116} y2={86} stroke="#c0392b" strokeWidth={2.5} strokeLinecap="round" />}
      {/* Left leg */}
      {s(5) && <line x1={95} y1={100} x2={74} y2={130} stroke="#c0392b" strokeWidth={2.5} strokeLinecap="round" />}
      {/* Right leg */}
      {s(6) && <line x1={95} y1={100} x2={116} y2={130} stroke="#c0392b" strokeWidth={2.5} strokeLinecap="round" />}
    </svg>
  );
}

// ─── Masked word display ──────────────────────────────────────────────────────

function MaskedWord({ letters }: { letters: string[] }) {
  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
      {letters.map((l, i) => (
        <div
          key={i}
          style={{
            width: 34,
            height: 44,
            borderBottom: `3px solid ${l === '_' ? '#aaa' : '#2a7ae2'}`,
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
            paddingBottom: 4,
            fontSize: 22,
            fontWeight: 700,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            color: '#1a1a1a',
            transition: 'border-color 0.2s'
          }}
        >
          {l === '_' ? '' : l}
        </div>
      ))}
    </div>
  );
}

// ─── Letter grid ─────────────────────────────────────────────────────────────

function LetterGrid(props: {
  guessedLetters: string[];
  word: string | null;
  onGuess: (l: string) => void;
  disabled: boolean;
}) {
  const { guessedLetters, word, onGuess, disabled } = props;
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  return (
    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', maxWidth: 340 }}>
      {letters.map((l) => {
        const isGuessed = guessedLetters.includes(l);
        const wasCorrect = isGuessed && word ? word.includes(l) : false;
        const wasWrong = isGuessed && !wasCorrect;
        return (
          <button
            key={l}
            onClick={() => onGuess(l)}
            disabled={isGuessed || disabled}
            style={{
              width: 34,
              height: 34,
              borderRadius: 6,
              border: wasWrong
                ? '1px solid #e8a0a0'
                : wasCorrect
                  ? '1px solid #a0c8a0'
                  : '1px solid #ccc',
              background: wasWrong ? '#fde8e8' : wasCorrect ? '#e8f5e8' : '#fff',
              color: isGuessed ? '#999' : '#333',
              cursor: isGuessed || disabled ? 'default' : 'pointer',
              fontWeight: 700,
              fontSize: 13,
              transition: 'all 0.1s'
            }}
          >
            {l}
          </button>
        );
      })}
    </div>
  );
}

// ─── Activity feed ────────────────────────────────────────────────────────────

function formatEvent(
  ev: RoomEvent,
  playerById: Map<string, { displayName: string }>
): ReactElement {
  const p = ev.publicPayload as Record<string, unknown>;
  const kind = ev.kind;
  const name = (id: string) =>
    playerById.get(id)?.displayName ?? id.slice(0, 10) + '…';

  if (kind === HANGMAN_EVT_STARTED) {
    return (
      <span>
        🎯 Game started — {String(p['wordLength'])}-letter word,{' '}
        {String(p['maxWrongGuesses'])} wrong guesses allowed
      </span>
    );
  }
  if (kind === HANGMAN_EVT_GUESSED) {
    const correct = p['correct'] as boolean;
    return (
      <span>
        <strong>{name(String(p['playerId']))}</strong> guessed{' '}
        <strong style={{ fontFamily: 'monospace' }}>{String(p['letter'])}</strong>{' '}
        {correct ? (
          <span style={{ color: '#2a7a2a' }}>✓ correct</span>
        ) : (
          <span style={{ color: '#c0392b' }}>✗ wrong ({String(p['wrongGuesses'])} total)</span>
        )}
      </span>
    );
  }
  if (kind === HANGMAN_EVT_GAME_OVER) {
    const outcome = p['outcome'] as string;
    return (
      <span>
        🏁 Game over — {outcome === 'win' ? '🎉 guessers win!' : '💀 word wins!'} The word was{' '}
        <strong style={{ fontFamily: 'monospace' }}>{String(p['word'])}</strong>
      </span>
    );
  }
  return <span>{kind}</span>;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function HangmanPlayerUI(props: PlayerUIProps<HangmanConfig>) {
  const { store, room, selfPlayerId, players } = props;
  const playerById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);

  const [gameStatePublic, setGameStatePublic] = useState(() => store.getGameStatePublicOrNull());
  useEffect(() => store.onGameStatePublicChanged(setGameStatePublic), [store]);

  const [events, setEvents] = useState<RoomEvent[]>(() => store.getEvents());
  useEffect(() => { setEvents(store.getEvents()); }, [gameStatePublic, store]);

  const [submitting, setSubmitting] = useState(false);

  const parsedPublic = gameStatePublic
    ? zHangmanPublicState.safeParse(gameStatePublic.state)
    : null;

  if (!parsedPublic?.success) {
    return <div style={{ color: '#777', padding: 16 }}>Waiting for game state…</div>;
  }

  const state = parsedPublic.data;
  const isMyTurn = state.turnPlayerId === selfPlayerId && state.phase === 'active';
  const isFinished = state.phase === 'finished';

  // Reveal word from game-over event if available
  const gameOverEvent = events.find((e) => e.kind === HANGMAN_EVT_GAME_OVER);
  const revealedWord = gameOverEvent
    ? (gameOverEvent.publicPayload as Record<string, unknown>)['word'] as string | undefined
    : undefined;

  const currentName = state.turnPlayerId
    ? (playerById.get(state.turnPlayerId)?.displayName ?? state.turnPlayerId.slice(0, 10) + '…')
    : null;

  async function handleGuess(letter: string) {
    if (submitting || !isMyTurn) return;
    setSubmitting(true);
    try {
      await store.submit({
        kind: HANGMAN_SUBMIT_GUESS,
        plaintext: new TextEncoder().encode(
          JSON.stringify({ kind: HANGMAN_SUBMIT_GUESS, letter })
        )
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 760 }}>
      {/* Main layout: figure + word + keyboard */}
      <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 16, marginBottom: 12 }}>
        {/* Hangman figure */}
        <div style={{
          padding: 12,
          borderRadius: 10,
          border: '1px solid #ddd',
          background: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}>
          <HangmanFigure wrongGuesses={state.wrongGuesses} />
        </div>

        {/* Right column: word + keyboard */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Masked word */}
          <div style={{
            padding: '16px 12px',
            borderRadius: 10,
            border: '1px solid #ddd',
            background: '#fff'
          }}>
            <MaskedWord letters={state.maskedWord} />
          </div>

          {/* Letter grid */}
          <div style={{
            padding: 12,
            borderRadius: 10,
            border: '1px solid #ddd',
            background: '#fff'
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#555', marginBottom: 8 }}>
              {isMyTurn ? 'Pick a letter:' : 'Letters guessed:'}
            </div>
            <LetterGrid
              guessedLetters={state.guessedLetters}
              word={revealedWord ?? null}
              onGuess={(l) => { void handleGuess(l); }}
              disabled={!isMyTurn || submitting || isFinished}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
