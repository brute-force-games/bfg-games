import { createFileRoute, Link } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';

import { useSync } from '../sync/SyncContext';
import type { LocalRoomRole } from '@brute-force-games/multiplayer-types';

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
    (raw as Record<string, unknown>).exportVersion !== 2
  ) {
    throw new Error('Not a valid game record bundle (expected exportVersion: 2)');
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
  const eventOk = result.eventResults.filter((r) => r.signatureValid).length;
  const subOk = result.submissionResults.filter((r) => r.signatureValid).length;
  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
      <span style={{
        background: bg, color, border: `1px solid ${color}`,
        borderRadius: 6, padding: '2px 10px', fontSize: 13, fontWeight: 600
      }}>
        {label}
      </span>
      <div style={{ fontSize: 11, color: '#555' }}>
        events: {eventOk}/{result.eventResults.length} host-signed •
        submissions: {subOk}/{result.submissionResults.length} player-signed •
        linkage: {result.linkageComplete ? 'complete' : 'incomplete'}
      </div>
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
  const submissionSigMap = new Map(
    (verification?.submissionResults ?? []).map((r) => [r.id, r.signatureValid])
  );
  const submissionById = new Map(bundle.submissions.map((s) => [s.id, s]));

  return (
    <div style={{ marginTop: 16 }}>
      <h3 style={{ margin: '0 0 8px' }}>Event log — {bundle.events.length} events, {bundle.submissions.length} submissions</h3>
      <div style={{ fontFamily: 'monospace', fontSize: 12, overflowY: 'auto', maxHeight: 540, border: '1px solid #ddd', borderRadius: 8 }}>
        {bundle.events.map((evt, i) => {
          const isFinalized = evt.kind === GAME_FINALIZED_KIND;
          const isAck = evt.kind === 'host/accepted_submission';
          const sigOk = sigMap.get(evt.id);
          const sigBadge = verification === null ? null : sigOk
            ? <span style={{ color: '#1a7f3c', marginLeft: 4 }} title="host signature valid">✓ host</span>
            : <span style={{ color: '#b91c1c', marginLeft: 4 }} title="host signature invalid">✗ host</span>;

          // For host/accepted_submission events, show the linked submission's
          // player-signature status alongside the host-signature badge.
          const ackSubmissionId =
            isAck && evt.publicPayload && typeof evt.publicPayload === 'object'
              ? (evt.publicPayload as { submissionId?: unknown }).submissionId
              : null;
          const linkedSub = typeof ackSubmissionId === 'string' ? submissionById.get(ackSubmissionId) : undefined;
          const linkedSubSigOk =
            typeof ackSubmissionId === 'string' ? submissionSigMap.get(ackSubmissionId) : undefined;
          const playerSigBadge = verification === null || linkedSub === undefined
            ? null
            : linkedSubSigOk
              ? <span style={{ color: '#1a7f3c', marginLeft: 4 }} title="player signature valid">✓ player</span>
              : <span style={{ color: '#b91c1c', marginLeft: 4 }} title="player signature invalid">✗ player</span>;

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
                <span style={{ fontWeight: 600, color: isFinalized ? '#1a7f3c' : isAck ? '#7c3aed' : '#1d4ed8' }}>{evt.kind}</span>
                {evt.fromPlayerId && (
                  <span style={{ color: '#666' }}>
                    from: {playerNames.get(evt.fromPlayerId) ?? evt.fromPlayerId}
                  </span>
                )}
                {sigBadge}
                {playerSigBadge}
              </div>
              {evt.publicPayload !== null && evt.publicPayload !== undefined && (
                <pre style={{ margin: '4px 0 0 42px', color: '#444', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {JSON.stringify(evt.publicPayload, null, 2)}
                </pre>
              )}
              {linkedSub && (
                <div style={{ margin: '4px 0 0 42px', color: '#666', fontSize: 11 }}>
                  → submission nonce={linkedSub.nonce} kind={linkedSub.kind} plaintext={
                    (() => {
                      try {
                        const bytes = atob(linkedSub.plaintextB64);
                        const arr = new Uint8Array(bytes.length);
                        for (let j = 0; j < bytes.length; j++) arr[j] = bytes.charCodeAt(j);
                        const txt = new TextDecoder().decode(arr);
                        try { return JSON.stringify(JSON.parse(txt)); } catch { return txt; }
                      } catch { return '(binary)'; }
                    })()
                  }
                </div>
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

// ─── My hosted games ──────────────────────────────────────────────────────────

function MyHostedGames({ onRoomId }: { onRoomId: (roomId: string) => void }) {
  const { listLocalRoles, roomsIndex } = useSync();

  const hostedRoles = useMemo(() => {
    const roles = listLocalRoles().filter((r): r is Extract<LocalRoomRole, { kind: 'host' }> => r.kind === 'host');
    roles.sort((a, b) => b.createdAt - a.createdAt);
    return roles;
  }, [listLocalRoles]);

  const indexByRoomId = useMemo(
    () => new Map(roomsIndex.map((r) => [r.roomId, r])),
    [roomsIndex]
  );

  if (hostedRoles.length === 0) return null;

  return (
    <div style={{ marginTop: 24 }}>
      <h3 style={{ margin: '0 0 10px' }}>My hosted games</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {hostedRoles.map((role) => {
          const indexed = indexByRoomId.get(role.roomId);
          const gameType = indexed?.gameType ?? role.bootstrap?.gameType ?? 'unknown';
          const status = indexed?.roomStatus ?? 'unknown';
          const isFinished = status === 'finished';
          return (
            <div
              key={role.roomId}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '10px 14px',
                border: '1px solid #e5e7eb',
                borderRadius: 8,
                background: '#fafafa',
                flexWrap: 'wrap'
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, color: '#444' }}>
                  {role.roomId}
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 3, fontSize: 13, color: '#666', flexWrap: 'wrap' }}>
                  <span><strong style={{ color: '#333' }}>{gameType}</strong></span>
                  {status !== 'unknown' ? (
                    <span style={{ color: isFinished ? '#166534' : '#555' }}>
                      {status}
                    </span>
                  ) : null}
                  <span>{new Date(role.createdAt).toLocaleDateString()}</span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flex: '0 0 auto' }}>
                {isFinished ? (
                  <button
                    type="button"
                    style={{ fontSize: 13 }}
                    onClick={() => onRoomId(role.roomId)}
                  >
                    Load record
                  </button>
                ) : null}
                <Link to="/room/$roomId/play" params={{ roomId: role.roomId }}>
                  Open room
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main route component ─────────────────────────────────────────────────────

export function ReviewRoute() {
  const search = Route.useSearch();
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'idle' });
  const [verification, setVerification] = useState<VerificationResult | null>(null);
  const { getRoomStore, loadHostKeypairForRoom, listLocalRoles } = useSync();

  const loadBundle = useCallback((bundle: GameExportV1) => {
    setLoadState({ kind: 'loaded', bundle });
    setVerification(null);
    void verifyGameExport(bundle).then(setVerification);
  }, []);

  const loadText = useCallback((text: string) => {
    try {
      loadBundle(parseBundle(text));
    } catch (e) {
      setLoadState({ kind: 'error', message: String(e) });
    }
  }, [loadBundle]);

  const loadRoomRecord = useCallback(async (roomId: string) => {
    const role = listLocalRoles().find((r) => r.roomId === roomId);
    if (!role || role.kind !== 'host') return;
    setLoadState({ kind: 'loading', source: `room ${roomId}` });
    try {
      const store = getRoomStore(roomId as import('@brute-force-games/multiplayer-types').RoomId);
      const hostKeypair = await loadHostKeypairForRoom(roomId as import('@brute-force-games/multiplayer-types').RoomId);
      if (!hostKeypair) throw new Error('Host keypair not found');
      const wsUrl = `wss://todo.demo.tinybase.org/${encodeURIComponent(roomId)}`;
      await store.connect({ roomId: roomId as import('@brute-force-games/multiplayer-types').RoomId, wsUrl, hostClaim: { hostKeypair } });
      const record = await store.exportGameRecord({ appVersion: __APP_GIT_SHA__, engineVersion: 'unknown' });
      loadBundle(record);
    } catch (e) {
      setLoadState({ kind: 'error', message: `Failed to load room record: ${String(e)}` });
    }
  }, [getRoomStore, loadHostKeypairForRoom, listLocalRoles, loadBundle]);

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
          <>
            <MyHostedGames onRoomId={(id) => { void loadRoomRecord(id); }} />
            <DropZone onFile={loadText} />
          </>
        )
      )}
    </div>
  );
}
