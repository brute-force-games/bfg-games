import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { generateRoomSeed, zGameType } from '@brute-force-games/shared-types';

import { parseInviteInput } from '../utils/invite';
import { useRoomsIndex, useSync } from '../sync/SyncContext';

export const Route = createFileRoute('/')({ component: IndexRoute });

const DEFAULT_GAME_TYPE = zGameType.parse('tictactoe');

function IndexRoute() {
  const navigate = useNavigate();
  const [joinInput, setJoinInput] = useState('');
  const roomsIndex = useRoomsIndex();
  const { createHostedRoom } = useSync();
  const [creating, setCreating] = useState(false);

  const parsed = useMemo(() => parseInviteInput(joinInput), [joinInput]);

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>Acronym Game</h1>
        <div style={{ display: 'flex', gap: 12 }}>
          <Link to="/review">Review</Link>
          <Link to="/settings">Settings</Link>
        </div>
      </div>

      <div style={{ marginTop: 16, padding: 16, border: '1px solid #ddd', borderRadius: 12 }}>
        <h2 style={{ marginTop: 0 }}>New Game</h2>
        <p style={{ marginTop: 0, color: '#555' }}>
          Creates a new room locally (Phase 2). Later phases will create rooms via the server.
        </p>
        <button
          type="button"
          disabled={creating}
          onClick={() => {
            setCreating(true);
            void (async () => {
              try {
                const { roomId, invite } = await createHostedRoom({
                  defaultGameType: DEFAULT_GAME_TYPE,
                  seed: generateRoomSeed()
                });
                void navigate({ to: '/room/$roomId/play', params: { roomId }, search: { invite } });
              } finally {
                setCreating(false);
              }
            })();
          }}
        >
          {creating ? 'Creating…' : 'New Game'}
        </button>
      </div>

      <div style={{ marginTop: 16, padding: 16, border: '1px solid #ddd', borderRadius: 12 }}>
        <h2 style={{ marginTop: 0 }}>Rooms</h2>
        {roomsIndex.length === 0 ? (
          <p style={{ marginTop: 0, color: '#555' }}>No rooms yet. Create a new game or join one.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {roomsIndex.map((r) => (
              <div
                key={r.roomId}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  gap: 12,
                  padding: 10,
                  borderRadius: 12,
                  border: '1px solid #eee',
                  background: '#fff'
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, color: '#333' }}>
                    {r.roomId}
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 13, color: '#666', marginTop: 4 }}>
                    <span>
                      role <strong style={{ color: '#333' }}>{r.selfRole}</strong>
                    </span>
                    <span>
                      status <strong style={{ color: '#333' }}>{r.roomStatus}</strong>
                    </span>
                    <span>
                      game <strong style={{ color: '#333' }}>{r.gameType}</strong>
                    </span>
                    <span>
                      {r.connected ? (
                        <strong style={{ color: '#14532d' }}>connected</strong>
                      ) : (
                        <span style={{ color: '#777' }}>disconnected</span>
                      )}
                    </span>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 8, flex: '0 0 auto' }}>
                  <Link to="/room/$roomId/play" params={{ roomId: r.roomId }}>
                    <button type="button">Open</button>
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ marginTop: 16, padding: 16, border: '1px solid #ddd', borderRadius: 12 }}>
        <h2 style={{ marginTop: 0 }}>Join</h2>
        <p style={{ marginTop: 0, color: '#555' }}>Paste an invite link (recommended) or a room id.</p>

        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={joinInput}
            onChange={(e) => setJoinInput(e.target.value)}
            placeholder="https://…/room/room_xxx/play?invite=ABC123"
            style={{ flex: 1, padding: 10, borderRadius: 10, border: '1px solid #ccc' }}
          />
          <button
            type="button"
            disabled={!parsed || parsed.kind === 'inviteCode'}
            onClick={() => {
              if (!parsed) return;
              if (parsed.kind === 'roomLink') {
                void navigate({
                  to: '/room/$roomId/play',
                  params: { roomId: parsed.roomId },
                  search: { invite: parsed.invite }
                });
              } else if (parsed.kind === 'roomId') {
                void navigate({ to: '/room/$roomId/play', params: { roomId: parsed.roomId } });
              }
            }}
          >
            Join
          </button>
        </div>

        {parsed?.kind === 'inviteCode' ? (
          <p style={{ marginTop: 10, color: '#8a3' }}>
            You entered an invite code ({parsed.invite}). For Phase 2 we still need a full invite link (with room id) or a
            `room_…` id.
          </p>
        ) : null}
      </div>
    </div>
  );
}

