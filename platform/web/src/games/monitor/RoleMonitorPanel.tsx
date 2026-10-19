import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';

import { verifySubmissionSignature, verifyGameStatePublicSignature } from '@brute-force-games/shared-types';
import type {
  EventsPrivate,
  GameStatePrivate,
  LoadedGameHostKeypair,
  LoadedPlayerIdentity,
  LobbyChatSubmission,
  Room,
  Submission,
  UserGameRoleKind
} from '@brute-force-games/shared-types';

import type { Player, RoomEvent, RoomSessionRole, RoomStore } from '@brute-force-games/multiplayer-types';

import {
  decryptEventsPrivateForSimulatedRole,
  decryptGameStatePrivateForSimulatedRole,
  decryptLobbyChatSubmissionForSimulatedRole,
  decryptSubmissionForSimulatedRole,
  peekDecryptEventsPrivate,
  peekDecryptGameStatePrivate,
  peekDecryptLobbyChat,
  peekDecryptSubmission,
  type DecryptOutcome
} from './decryptForActiveRole';
import { RoleSelector } from './RoleSelector';
const HOST_ACK = 'host/accepted_submission' as const;

function truncate(s: string, max = 48): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function MonospaceBlock(props: { children: import('react').ReactNode }) {
  return (
    <pre
      style={{
        margin: '6px 0 0',
        padding: 8,
        background: '#f9fafb',
        border: '1px solid #e5e7eb',
        borderRadius: 6,
        fontSize: 11,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all'
      }}
    >
      {props.children}
    </pre>
  );
}

function DecryptedPane(props: { outcome: DecryptOutcome }) {
  const { outcome } = props;
  if (outcome.kind === 'decrypted') {
    return (
      <MonospaceBlock>
        {typeof outcome.value === 'string' ? outcome.value : JSON.stringify(outcome.value, null, 2)}
      </MonospaceBlock>
    );
  }
  return (
    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
      🔒 encrypted ({outcome.reason})
    </div>
  );
}

function PeekPanel(props: {
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        marginTop: 8,
        padding: 8,
        border: '2px solid #facc15',
        borderRadius: 8,
        background: '#fffbeb'
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 600, color: '#92400e', marginBottom: 4 }}>
        Ground truth (local keys — outside simulated role)
      </div>
      {props.children}
    </div>
  );
}

function SubmissionRow(props: {
  submission: Submission;
  room: Room;
  players: Player[];
  role: UserGameRoleKind;
  hostKeypair: LoadedGameHostKeypair | null;
}) {
  const { submission, room, players, role, hostKeypair } = props;
  const q = useQuery({
    queryKey: ['monitor', 'sub', submission.id, role, submission.toHostCiphertext],
    queryFn: () =>
      decryptSubmissionForSimulatedRole({
        submission,
        room,
        players,
        role,
        hostKeypair
      })
  });

  const [peekOpen, setPeekOpen] = useState(false);
  const peekQ = useQuery({
    queryKey: ['monitor', 'peek', 'sub', submission.id],
    queryFn: () =>
      peekDecryptSubmission({
        submission,
        room,
        players,
        hostKeypair
      }),
    enabled: peekOpen && q.data?.kind === 'opaque'
  });

  const [sigOk, setSigOk] = useState<boolean | null>(null);
  useEffect(() => {
    const from = players.find((p) => p.id === submission.fromPlayerId);
    if (!from) {
      setSigOk(false);
      return;
    }
    void verifySubmissionSignature(submission, room.hostEncPubKey, from.signingPubKey).then(setSigOk);
  }, [submission, players, room.hostEncPubKey]);

  const canPeek = hostKeypair !== null && q.data?.kind === 'opaque';

  return (
    <div style={{ padding: '10px 0', borderBottom: '1px solid #eee' }}>
      <div style={{ fontSize: 12, color: '#374151' }}>
        <strong>{submission.id}</strong> · from {submission.fromPlayerId} · {submission.kind} · nonce {submission.nonce}{' '}
        · sig {sigOk === null ? '…' : sigOk ? '✓' : '✗'}
      </div>
      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
        iv {truncate(submission.iv)} · ct {truncate(submission.toHostCiphertext)} (
        {submission.toHostCiphertext.length} b64 chars)
      </div>
      {q.isPending ? (
        <div style={{ fontSize: 12, color: '#888' }}>Decrypting…</div>
      ) : q.data ? (
        <>
          <DecryptedPane outcome={q.data} />
          {canPeek && (
            <div style={{ marginTop: 6 }}>
              <button type="button" style={{ fontSize: 12 }} onClick={() => setPeekOpen((v) => !v)}>
                {peekOpen ? '▼ hide peek' : '▸ peek (host key)'}
              </button>
              {peekOpen && peekQ.data && <PeekPanel>{peekQ.data.kind === 'decrypted' ? <DecryptedPane outcome={peekQ.data} /> : null}</PeekPanel>}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

export function RoleMonitorPanel(props: {
  roomStore: RoomStore;
  identity: LoadedPlayerIdentity;
  hostKeypair: LoadedGameHostKeypair | null;
  simulatedRole: UserGameRoleKind;
  onSimulatedRoleChange: (r: UserGameRoleKind) => void;
  roomId: string;
}) {
  const { roomStore, identity, hostKeypair, simulatedRole, onSimulatedRoleChange, roomId } = props;

  const [room, setRoom] = useState<Room | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [sessionRole, setSessionRole] = useState<RoomSessionRole>(() => roomStore.getSelfRoomRole());
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [events, setEvents] = useState<RoomEvent[]>([]);
  const [chatSubs, setChatSubs] = useState<LobbyChatSubmission[]>([]);
  const [chatEvents, setChatEvents] = useState(() => roomStore.getLobbyChatEvents());
  const [pub, setPub] = useState(() => roomStore.getGameStatePublicOrNull());
  const [hist, setHist] = useState(() => roomStore.getGameStateHistory());
  const [eventsPrivate, setEventsPrivate] = useState<EventsPrivate[]>([]);

  const playerIds = useMemo(() => players.map((p) => p.id), [players]);
  const [privateByPlayer, setPrivateByPlayer] = useState<Record<string, GameStatePrivate | null>>({});

  useEffect(() => {
    const unsubs = [
      roomStore.onRoomChanged(setRoom),
      roomStore.onPlayersChanged(setPlayers),
      roomStore.onSelfRoomRoleChanged(setSessionRole),
      roomStore.onSubmissionsChanged(setSubmissions),
      roomStore.onLobbyChatSubmissionsChanged(setChatSubs),
      roomStore.onLobbyChatEventsChanged(setChatEvents),
      roomStore.onGameStatePublicChanged(() => {
        setPub(roomStore.getGameStatePublicOrNull());
        setEvents(roomStore.getEvents());
      }),
      roomStore.onGameStateHistoryChanged(setHist),
      roomStore.onEventsPrivateChanged(setEventsPrivate)
    ];
    setRoom(roomStore.getRoom());
    setPlayers(roomStore.getPlayers());
    setSubmissions(roomStore.getSubmissions());
    setEvents(roomStore.getEvents());
    setPub(roomStore.getGameStatePublicOrNull());
    setEventsPrivate(roomStore.getEventsPrivate());
    return () => unsubs.forEach((u) => u());
  }, [roomStore]);

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    const next: Record<string, GameStatePrivate | null> = {};
    for (const id of playerIds) {
      next[id] = roomStore.getGameStatePrivateOrNull(id);
      unsubs.push(
        roomStore.onGameStatePrivateChanged(id, (row) => {
          setPrivateByPlayer((prev) => ({ ...prev, [id]: row }));
        })
      );
    }
    setPrivateByPlayer(next);
    return () => unsubs.forEach((u) => u());
  }, [roomStore, playerIds.join('|')]);

  const hostPk = players.find((p) => p.id === room?.hostPlayerId)?.signingPubKey ?? '';

  const canSimulateHostRoles = hostKeypair !== null;

  const observerBanner =
    simulatedRole === 'participant_observer' || simulatedRole === 'player' ? (
      <div style={{ fontSize: 12, color: '#374151', background: '#f0fdf4', padding: 8, borderRadius: 8 }}>
        <strong>participant_observer</strong> and <strong>player</strong> share the same keys and decrypt results.
      </div>
    ) : null;

  if (!room) {
    return <p style={{ color: '#888' }}>Loading room…</p>;
  }

  return (
    <div style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif', maxWidth: 960 }}>
      <RoleSelector
        active={simulatedRole}
        onChange={onSimulatedRoleChange}
        canSimulateHostRoles={canSimulateHostRoles}
      />
      {observerBanner}

      <div style={{ fontSize: 13, color: '#555', marginBottom: 16 }}>
        Transport session: <code>{sessionRole}</code> · self <code>{identity.playerId}</code> · host keys{' '}
        {hostKeypair ? 'loaded' : 'absent'}
      </div>

      <nav style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20, fontSize: 14 }}>
        <Link to="/room/$roomId/play" params={{ roomId }}>
          Play
        </Link>
        <Link to="/room/$roomId/host" params={{ roomId }}>
          Host
        </Link>
        <Link to="/room/$roomId/observe" params={{ roomId }}>
          Observe
        </Link>
        <Link to="/room/$roomId/spectate" params={{ roomId }}>
          Spectate
        </Link>
        <Link to="/room/$roomId/archive" params={{ roomId }}>
          Archive
        </Link>
      </nav>

      <section style={{ marginBottom: 24 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>Room</h3>
        <MonospaceBlock>{JSON.stringify(room, null, 2)}</MonospaceBlock>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>Players ({players.length})</h3>
        <MonospaceBlock>{JSON.stringify(players, null, 2)}</MonospaceBlock>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>Events ({events.length})</h3>
        <MonospaceBlock>{JSON.stringify(events, null, 2)}</MonospaceBlock>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>Public snapshot</h3>
        {pub ? (
          <>
            <PublicSnapSig hostSigningPubKey={hostPk} snap={pub} />
            <MonospaceBlock>{JSON.stringify(pub.state, null, 2)}</MonospaceBlock>
          </>
        ) : (
          <p style={{ color: '#888', fontSize: 13 }}>None</p>
        )}
      </section>

      <section style={{ marginBottom: 24 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>Private state (per player)</h3>
        {players.map((p) => (
          <PrivatePlayerBlock
            key={p.id}
            playerId={p.id}
            row={privateByPlayer[p.id] ?? null}
            room={room}
            players={players}
            role={simulatedRole}
            identity={identity}
          />
        ))}
      </section>

      <section style={{ marginBottom: 24 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>Submissions ({submissions.length})</h3>
        {[...submissions].reverse().map((s) => (
          <SubmissionRow
            key={s.id}
            submission={s}
            room={room}
            players={players}
            role={simulatedRole}
            hostKeypair={hostKeypair}
          />
        ))}
      </section>

      <section style={{ marginBottom: 24 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>Move trace (submission → ack)</h3>
        <MoveTraceList events={events} submissions={[...submissions].reverse()} />
      </section>

      <section style={{ marginBottom: 24 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>eventsPrivate ({eventsPrivate.length})</h3>
        {eventsPrivate.length === 0 ? (
          <p style={{ color: '#888', fontSize: 13 }}>No rows</p>
        ) : (
          eventsPrivate.map((row) => (
            <EventsPrivateRow
              key={row.id}
              row={row}
              room={room}
              players={players}
              events={events}
              role={simulatedRole}
              identity={identity}
            />
          ))
        )}
      </section>

      <section style={{ marginBottom: 24 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>Lobby chat submissions ({chatSubs.length})</h3>
        {[...chatSubs].reverse().map((c) => (
          <ChatSubRow
            key={c.id}
            sub={c}
            room={room}
            players={players}
            role={simulatedRole}
            hostKeypair={hostKeypair}
          />
        ))}
      </section>

      <section style={{ marginBottom: 24 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>Lobby chat events ({chatEvents.length})</h3>
        <MonospaceBlock>{JSON.stringify(chatEvents, null, 2)}</MonospaceBlock>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>State history ({hist.length})</h3>
        <MonospaceBlock>{JSON.stringify(hist, null, 2)}</MonospaceBlock>
      </section>
    </div>
  );
}

function MoveTraceList(props: { submissions: Submission[]; events: RoomEvent[] }) {
  const bySubId = useMemo(() => {
    const m = new Map<string, RoomEvent>();
    for (const e of props.events) {
      if (e.kind !== HOST_ACK) continue;
      const p = e.publicPayload as { submissionId?: string };
      if (p?.submissionId) m.set(p.submissionId, e);
    }
    return m;
  }, [props.events]);

  return (
    <div style={{ fontSize: 12 }}>
      {props.submissions.map((s) => {
        const ack = bySubId.get(s.id);
        return (
          <div key={s.id} style={{ padding: '8px 0', borderBottom: '1px solid #eee' }}>
            <div>
              <strong>{s.id}</strong> · {s.kind}
            </div>
            <div style={{ color: ack ? '#065f46' : '#b45309' }}>
              {ack ? `acked evt seq ${ack.seq}` : 'no host/accepted_submission yet'}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PrivatePlayerBlock(props: {
  playerId: string;
  row: GameStatePrivate | null;
  room: Room;
  players: Player[];
  role: UserGameRoleKind;
  identity: LoadedPlayerIdentity;
}) {
  const { row, room, players, role, identity, playerId } = props;
  const q = useQuery({
    queryKey: ['monitor', 'priv', playerId, row?.kind, role],
    queryFn: async () => {
      if (!row) return null;
      return decryptGameStatePrivateForSimulatedRole({
        row,
        room,
        players,
        role,
        identity
      });
    },
    enabled: row !== null
  });

  const [peekOpen, setPeekOpen] = useState(false);
  const peekQ = useQuery({
    queryKey: ['peekPriv', playerId],
    queryFn: () =>
      row
        ? peekDecryptGameStatePrivate({
            row,
            room,
            players,
            identity
          })
        : Promise.resolve(null),
    enabled: peekOpen && row !== null && q.data?.kind === 'opaque'
  });

  const canPeek = Boolean(
    row && row.kind === 'encrypted' && row.id === identity.playerId && q.data?.kind === 'opaque'
  );

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>Player {playerId}</div>
      {!row ? (
        <p style={{ fontSize: 12, color: '#888' }}>No row</p>
      ) : (
        <>
          <MonospaceBlock>{JSON.stringify(row, null, 2)}</MonospaceBlock>
          {q.isPending ? (
            <div style={{ fontSize: 12 }}>Decrypting…</div>
          ) : q.data ? (
            <>
              <DecryptedPane outcome={q.data} />
              {canPeek && (
                <button type="button" style={{ fontSize: 12, marginTop: 6 }} onClick={() => setPeekOpen((x) => !x)}>
                  {peekOpen ? '▼ hide peek' : '▸ peek'}
                </button>
              )}
              {peekOpen && peekQ.data?.kind === 'decrypted' ? (
                <PeekPanel>
                  <DecryptedPane outcome={peekQ.data} />
                </PeekPanel>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

function EventsPrivateRow(props: {
  row: EventsPrivate;
  room: Room;
  players: Player[];
  events: RoomEvent[];
  role: UserGameRoleKind;
  identity: LoadedPlayerIdentity;
}) {
  const evt = props.events.find((e) => e.id === props.row.evtId);
  const eventSeq = evt ? evt.seq : null;

  const q = useQuery({
    queryKey: ['monitor', 'epvt', props.row.id, props.role, eventSeq ?? 'none'],
    queryFn: () =>
      decryptEventsPrivateForSimulatedRole({
        row: props.row,
        room: props.room,
        players: props.players,
        role: props.role,
        identity: props.identity,
        eventSeq
      })
  });

  const [peekOpen, setPeekOpen] = useState(false);
  const peekQ = useQuery({
    queryKey: ['peekEpvt', props.row.id],
    queryFn: () =>
      peekDecryptEventsPrivate({
        row: props.row,
        room: props.room,
        players: props.players,
        identity: props.identity,
        eventSeq
      }),
    enabled: peekOpen && q.data?.kind === 'opaque'
  });

  const canPeek = props.row.playerId === props.identity.playerId && q.data?.kind === 'opaque';

  return (
    <div style={{ padding: '10px 0', borderBottom: '1px solid #eee' }}>
      <div style={{ fontSize: 12 }}>
        <strong>{props.row.id}</strong> · evt {props.row.evtId} · player {props.row.playerId}{' '}
        {evt ? `(seq ${evt.seq})` : '(event missing)'}
      </div>
      <MonospaceBlock>{JSON.stringify({ iv: props.row.iv, ciphertextToPlayer: truncate(props.row.ciphertextToPlayer) }, null, 2)}</MonospaceBlock>
      {q.data ? (
        <>
          <DecryptedPane outcome={q.data} />
          {canPeek && (
            <>
              <button type="button" style={{ fontSize: 12 }} onClick={() => setPeekOpen((x) => !x)}>
                {peekOpen ? '▼ hide peek' : '▸ peek'}
              </button>
              {peekOpen && peekQ.data?.kind === 'decrypted' ? (
                <PeekPanel>
                  <DecryptedPane outcome={peekQ.data} />
                </PeekPanel>
              ) : null}
            </>
          )}
        </>
      ) : null}
    </div>
  );
}

function ChatSubRow(props: {
  sub: LobbyChatSubmission;
  room: Room;
  players: Player[];
  role: UserGameRoleKind;
  hostKeypair: LoadedGameHostKeypair | null;
}) {
  const q = useQuery({
    queryKey: ['monitor', 'chat', props.sub.id, props.role],
    queryFn: () =>
      decryptLobbyChatSubmissionForSimulatedRole({
        submission: props.sub,
        room: props.room,
        players: props.players,
        role: props.role,
        hostKeypair: props.hostKeypair
      })
  });
  const [peekOpen, setPeekOpen] = useState(false);
  const peekQ = useQuery({
    queryKey: ['peekChat', props.sub.id],
    queryFn: () =>
      peekDecryptLobbyChat({
        submission: props.sub,
        room: props.room,
        players: props.players,
        hostKeypair: props.hostKeypair
      }),
    enabled: peekOpen && q.data?.kind === 'opaque'
  });
  const canPeek = props.hostKeypair !== null && q.data?.kind === 'opaque';

  return (
    <div style={{ padding: '10px 0', borderBottom: '1px solid #eee', fontSize: 12 }}>
      <strong>{props.sub.id}</strong> · from {props.sub.fromPlayerId}
      <MonospaceBlock>{JSON.stringify({ iv: props.sub.iv, ct: truncate(props.sub.toHostCiphertext) }, null, 2)}</MonospaceBlock>
      {q.data ? (
        <>
          <DecryptedPane outcome={q.data} />
          {canPeek && (
            <>
              <button type="button" onClick={() => setPeekOpen((x) => !x)}>
                {peekOpen ? '▼ hide peek' : '▸ peek'}
              </button>
              {peekOpen && peekQ.data?.kind === 'decrypted' ? (
                <PeekPanel>
                  <DecryptedPane outcome={peekQ.data} />
                </PeekPanel>
              ) : null}
            </>
          )}
        </>
      ) : null}
    </div>
  );
}

function PublicSnapSig(props: {
  hostSigningPubKey: string;
  snap: import('@brute-force-games/multiplayer-types').GameStatePublic;
}) {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    if (!props.hostSigningPubKey) {
      setOk(null);
      return;
    }
    void verifyGameStatePublicSignature(props.hostSigningPubKey, props.snap).then(setOk);
  }, [props.hostSigningPubKey, props.snap]);
  return (
    <div style={{ fontSize: 12, marginBottom: 6 }}>
      hostSignature verify: {ok === null ? '…' : ok ? '✓' : '✗'}
    </div>
  );
}
