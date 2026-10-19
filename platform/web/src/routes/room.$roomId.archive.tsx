import { createFileRoute, Link } from '@tanstack/react-router';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';

import { zRoomId } from '@brute-force-games/shared-types';
import type { Player, Room, RoomEvent, RoomStore } from '@brute-force-games/multiplayer-types';

import { useSync } from '../sync/SyncContext';

export const Route = createFileRoute('/room/$roomId/archive')({
  component: RoomArchiveRoute,
  errorComponent: ArchiveError
});

function formatTs(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ─── Query ───────────────────────────────────────────────────────────────────

async function connectRoomStore(
  roomStore: RoomStore,
  roomId: string,
  loadHostKeypairForRoom: (id: never) => Promise<import('@brute-force-games/multiplayer-types').LoadedGameHostKeypair | null>
): Promise<RoomStore> {
  const hostKeypair = await loadHostKeypairForRoom(roomId as never);
  const wsUrl = `wss://todo.demo.tinybase.org/${encodeURIComponent(roomId)}`;
  await roomStore.connect({
    roomId: roomId as never,
    wsUrl,
    ...(hostKeypair ? { hostClaim: { hostKeypair } } : {})
  });
  return roomStore;
}

// ─── Connected archive view ───────────────────────────────────────────────────

function ConnectedArchive({ roomStore }: { roomStore: RoomStore }) {
  const [room, setRoom] = useState<Room | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [events, setEvents] = useState<RoomEvent[]>([]);
  const [stateHistory, setStateHistory] = useState<{ seq: number; state: unknown }[]>([]);

  useEffect(() => {
    const unsubs = [
      roomStore.onRoomChanged(setRoom),
      roomStore.onPlayersChanged(setPlayers),
      roomStore.onGameStateHistoryChanged((rows) => {
        setStateHistory(rows);
        // No onEventsChanged exists; re-read whenever history progresses.
        setEvents(roomStore.getEvents());
      })
    ];
    setEvents(roomStore.getEvents());
    return () => unsubs.forEach((fn) => fn());
  }, [roomStore]);

  const playerNames = useMemo(() => new Map(players.map((p) => [p.id, p.displayName])), [players]);

  return (
    <>
      {room && (
        <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 24px', fontSize: 13, padding: 12, border: '1px solid #e5e7eb', borderRadius: 8 }}>
          <div><strong>Room:</strong> {room.id}</div>
          <div><strong>Game:</strong> {room.gameType}</div>
          <div><strong>Status:</strong> {room.status}</div>
          <div><strong>Players:</strong> {players.map((p) => p.displayName).join(', ')}</div>
        </div>
      )}

      <div style={{ marginTop: 24 }}>
        <h3 style={{ margin: '0 0 8px' }}>Events — {events.length}</h3>
        {events.length === 0 ? (
          <p style={{ color: '#888', fontSize: 13 }}>No events yet.</p>
        ) : (
          <div style={{ fontFamily: 'monospace', fontSize: 12, overflowY: 'auto', maxHeight: 540, border: '1px solid #ddd', borderRadius: 8 }}>
            {events.map((evt, i) => (
              <div
                key={evt.id}
                style={{
                  padding: '6px 12px',
                  borderBottom: i < events.length - 1 ? '1px solid #f0f0f0' : undefined,
                  background: i % 2 === 0 ? '#fff' : '#fafafa'
                }}
              >
                <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span style={{ color: '#999', minWidth: 30, textAlign: 'right' }}>#{evt.seq}</span>
                  <span style={{ color: '#555' }}>{formatTs(evt.createdAt)}</span>
                  <span style={{ fontWeight: 600, color: '#1d4ed8' }}>{evt.kind}</span>
                  {evt.fromPlayerId && (
                    <span style={{ color: '#666' }}>
                      from: {playerNames.get(evt.fromPlayerId) ?? evt.fromPlayerId}
                    </span>
                  )}
                </div>
                {evt.publicPayload !== null && evt.publicPayload !== undefined && (
                  <pre style={{ margin: '4px 0 0 42px', color: '#444', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                    {JSON.stringify(evt.publicPayload, null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ marginTop: 24 }}>
        <h3 style={{ margin: '0 0 8px' }}>State snapshots — {stateHistory.length}</h3>
        {stateHistory.length === 0 ? (
          <p style={{ color: '#888', fontSize: 13 }}>No state history yet.</p>
        ) : (
          <div style={{ fontFamily: 'monospace', fontSize: 12, overflowY: 'auto', maxHeight: 400, border: '1px solid #ddd', borderRadius: 8 }}>
            {stateHistory.map((snap, i) => (
              <div
                key={snap.seq}
                style={{
                  padding: '6px 12px',
                  borderBottom: i < stateHistory.length - 1 ? '1px solid #f0f0f0' : undefined,
                  background: i % 2 === 0 ? '#fff' : '#fafafa'
                }}
              >
                <div style={{ color: '#999', marginBottom: 2 }}>seq #{snap.seq}</div>
                <pre style={{ margin: 0, color: '#444', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {JSON.stringify(snap.state, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ─── Suspending loader ────────────────────────────────────────────────────────

function ArchiveLoader({ roomId }: { roomId: string }) {
  const { getRoomStore, loadHostKeypairForRoom } = useSync();
  const roomStore = useMemo(() => getRoomStore(roomId as never), [getRoomStore, roomId]);

  const { data: connectedStore } = useSuspenseQuery({
    queryKey: ['room', roomId, 'archive-connect'],
    queryFn: () => connectRoomStore(roomStore, roomId, loadHostKeypairForRoom)
  });

  return <ConnectedArchive roomStore={connectedStore} />;
}

// ─── Error component ──────────────────────────────────────────────────────────

function ArchiveError({ error }: { error: unknown }) {
  const { roomId } = Route.useParams();
  return (
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      <ArchiveHeader roomId={roomId} />
      <div style={{ marginTop: 16, padding: 12, background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 8, color: '#7f1d1d' }}>
        <strong>Failed to connect to room.</strong>
        <p style={{ margin: '4px 0 0', fontSize: 13 }}>{String(error)}</p>
      </div>
    </div>
  );
}

// ─── Shared header ────────────────────────────────────────────────────────────

function ArchiveHeader({ roomId }: { roomId: string }) {
  const parsedRoomId = zRoomId.safeParse(roomId);
  const validRoomId = parsedRoomId.success ? parsedRoomId.data : null;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <h1 style={{ margin: 0 }}>Room Archive</h1>
      <div style={{ display: 'flex', gap: 12 }}>
        {validRoomId && (
          <Link to="/room/$roomId/play" params={{ roomId: validRoomId }}>← Back to room</Link>
        )}
        <Link to="/">Home</Link>
      </div>
    </div>
  );
}

// ─── Route component ──────────────────────────────────────────────────────────

export function RoomArchiveRoute() {
  const { roomId: roomIdParam } = Route.useParams();
  const parsedRoomId = zRoomId.safeParse(roomIdParam);

  if (!parsedRoomId.success) {
    return (
      <div style={{ maxWidth: 800, margin: '0 auto' }}>
        <ArchiveHeader roomId={roomIdParam} />
        <p style={{ color: '#b91c1c', marginTop: 16 }}>Invalid room ID.</p>
      </div>
    );
  }

  const roomId = parsedRoomId.data;

  return (
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      <ArchiveHeader roomId={roomId} />
      <Suspense fallback={<p style={{ color: '#888', marginTop: 16 }}>Connecting to room…</p>}>
        <ArchiveLoader roomId={roomId} />
      </Suspense>
    </div>
  );
}
