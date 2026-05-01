import { createFileRoute, Link } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';

export const Route = createFileRoute('/review')({
  validateSearch: z.object({ bundle: z.string().optional() }),
  component: ReviewRoute
});

import {
  verifyGameExport,
  GAME_FINALIZED_KIND,
  type GameExportV1,
  type VerificationResult
} from '@brute-force-games/shared-types';

// ─── Types ────────────────────────────────────────────────────────────────────

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading'; source: string }
  | { kind: 'loaded'; bundle: GameExportV1 }
  | { kind: 'error'; message: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTs(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function parseBundle(text: string): GameExportV1 {
  const raw = JSON.parse(text) as unknown;
  if (
    raw === null ||
    typeof raw !== 'object' ||
    !('exportVersion' in raw) ||
    (raw as Record<string, unknown>).exportVersion !== 1
  ) {
    throw new Error('Not a valid GameExportV1 bundle (missing exportVersion: 1)');
  }
  return raw as GameExportV1;
}

// ─── Verification badge ───────────────────────────────────────────────────────

function VerificationBadge({ result }: { result: VerificationResult | null }) {
  if (result === null) {
    return (
      <span style={{ color: '#888', fontSize: 13 }}>Verifying…</span>
    );
  }
  const color = result.ok ? '#1a7f3c' : '#b91c1c';
  const bg = result.ok ? '#d1fae5' : '#fee2e2';
  const label = result.ok ? '✓ Verified' : '✗ Verification failed';
  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
      <span style={{
        background: bg, color, border: `1px solid ${color}`,
        borderRadius: 6, padding: '2px 10px', fontSize: 13, fontWeight: 600
      }}>
        {label}
      </span>
      {!result.ok && result.errors.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 20, color: '#b91c1c', fontSize: 12 }}>
          {result.errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
    </div>
  );
}

// ─── Event log ────────────────────────────────────────────────────────────────

function EventLog({ bundle, verification }: { bundle: GameExportV1; verification: VerificationResult | null }) {
  const playerNames = new Map(bundle.players.map((p) => [p.playerId, p.displayName]));

  const sigMap = new Map(
    (verification?.eventResults ?? []).map((r) => [r.id, r.signatureValid])
  );

  return (
    <div style={{ marginTop: 16 }}>
      <h3 style={{ margin: '0 0 8px' }}>Event log — {bundle.events.length} events</h3>
      <div style={{ fontFamily: 'monospace', fontSize: 12, overflowY: 'auto', maxHeight: 540, border: '1px solid #ddd', borderRadius: 8 }}>
        {bundle.events.map((evt, i) => {
          const isFinalized = evt.kind === GAME_FINALIZED_KIND;
          const sigOk = sigMap.get(evt.id);
          const sigBadge = verification === null ? null : sigOk
            ? <span style={{ color: '#1a7f3c', marginLeft: 4 }}>✓</span>
            : <span style={{ color: '#b91c1c', marginLeft: 4 }}>✗</span>;

          return (
            <div
              key={evt.id}
              style={{
                padding: '6px 12px',
                borderBottom: i < bundle.events.length - 1 ? '1px solid #f0f0f0' : undefined,
                background: isFinalized ? '#f0fdf4' : i % 2 === 0 ? '#fff' : '#fafafa'
              }}
            >
              <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span style={{ color: '#999', minWidth: 30, textAlign: 'right' }}>#{evt.seq}</span>
                <span style={{ color: '#555' }}>{formatTs(evt.createdAt)}</span>
                <span style={{ fontWeight: 600, color: isFinalized ? '#1a7f3c' : '#1d4ed8' }}>{evt.kind}</span>
                {evt.fromPlayerId && (
                  <span style={{ color: '#666' }}>
                    from: {playerNames.get(evt.fromPlayerId) ?? evt.fromPlayerId}
                  </span>
                )}
                {sigBadge}
              </div>
              {evt.publicPayload !== null && evt.publicPayload !== undefined && (
                <pre style={{ margin: '4px 0 0 42px', color: '#444', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {JSON.stringify(evt.publicPayload, null, 2)}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Bundle info header ───────────────────────────────────────────────────────

function BundleInfo({ bundle }: { bundle: GameExportV1 }) {
  const { room, platform, players } = bundle;
  const duration = room.finishedAt - room.startedAt;
  const mins = Math.floor(duration / 60_000);
  const secs = Math.floor((duration % 60_000) / 1000);

  return (
    <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 24px', fontSize: 13 }}>
      <div><strong>Game:</strong> {platform.gameType} v{platform.gameVersion}</div>
      <div><strong>Outcome:</strong> {room.outcome}</div>
      <div><strong>Players:</strong> {players.map((p) => p.displayName).join(', ')}</div>
      <div><strong>Duration:</strong> {mins}m {secs}s</div>
      <div><strong>Started:</strong> {new Date(room.startedAt).toLocaleString()}</div>
      <div><strong>App:</strong> {platform.appVersion}</div>
    </div>
  );
}

// ─── Drop zone ────────────────────────────────────────────────────────────────

function DropZone({ onFile }: { onFile: (text: string) => void }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const readFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => onFile(reader.result as string);
    reader.readAsText(file);
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) readFile(file);
      }}
      onClick={() => inputRef.current?.click()}
      style={{
        marginTop: 24,
        border: `2px dashed ${dragging ? '#1d4ed8' : '#ccc'}`,
        borderRadius: 12,
        padding: '48px 24px',
        textAlign: 'center',
        cursor: 'pointer',
        background: dragging ? '#eff6ff' : '#fafafa',
        transition: 'all 0.15s'
      }}
    >
      <div style={{ fontSize: 32, marginBottom: 8 }}>📂</div>
      <div style={{ fontWeight: 600 }}>Drop a game record here</div>
      <div style={{ color: '#888', fontSize: 13, marginTop: 4 }}>
        or click to pick a <code>*-record.json</code> file
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) readFile(file);
        }}
      />
    </div>
  );
}

// ─── Main route component ─────────────────────────────────────────────────────

export function ReviewRoute() {
  const search = Route.useSearch();
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'idle' });
  const [verification, setVerification] = useState<VerificationResult | null>(null);

  const loadText = useCallback((text: string) => {
    try {
      const bundle = parseBundle(text);
      setLoadState({ kind: 'loaded', bundle });
      setVerification(null);
      void verifyGameExport(bundle).then(setVerification);
    } catch (e) {
      setLoadState({ kind: 'error', message: String(e) });
    }
  }, []);

  // Auto-load from ?bundle= URL param (same-origin fetches only to limit risk)
  useEffect(() => {
    const url = search.bundle;
    if (!url) return;

    const isSameOrigin = (() => {
      try {
        const parsed = new URL(url, window.location.href);
        return parsed.origin === window.location.origin || parsed.protocol === 'blob:';
      } catch {
        return false;
      }
    })();

    if (!isSameOrigin) {
      setLoadState({
        kind: 'error',
        message: `Cross-origin bundle URLs are not supported. Host the record file on ${window.location.origin} or load it via the file picker.`
      });
      return;
    }

    setLoadState({ kind: 'loading', source: url });
    fetch(url)
      .then((r) => r.text())
      .then(loadText)
      .catch((e: unknown) => setLoadState({ kind: 'error', message: `Failed to fetch bundle: ${String(e)}` }));
  }, [search.bundle, loadText]);

  const bundle = loadState.kind === 'loaded' ? loadState.bundle : null;

  return (
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>Game Review</h1>
        <Link to="/">Home</Link>
      </div>

      {loadState.kind === 'loading' && (
        <p style={{ color: '#888' }}>Loading bundle from {loadState.source}…</p>
      )}

      {loadState.kind === 'error' && (
        <div style={{ marginTop: 16, padding: 16, background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 8, color: '#7f1d1d' }}>
          <strong>Failed to load bundle</strong>
          <p style={{ margin: '4px 0 0' }}>{loadState.message}</p>
        </div>
      )}

      {bundle ? (
        <>
          <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <VerificationBadge result={verification} />
            <button
              type="button"
              style={{ fontSize: 12, padding: '2px 8px' }}
              onClick={() => {
                setLoadState({ kind: 'idle' });
                setVerification(null);
              }}
            >
              Load different file
            </button>
          </div>
          <BundleInfo bundle={bundle} />
          <EventLog bundle={bundle} verification={verification} />
        </>
      ) : (
        loadState.kind === 'idle' && (
          <DropZone onFile={loadText} />
        )
      )}
    </div>
  );
}
