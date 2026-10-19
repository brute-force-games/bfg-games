import type { UserGameRoleKind } from '@brute-force-games/shared-types';

const ALL_ROLES: UserGameRoleKind[] = [
  'anonymous_spectator',
  'host_moderator',
  'host_player',
  'player',
  'participant_observer'
];

export function RoleSelector(props: {
  active: UserGameRoleKind;
  onChange: (r: UserGameRoleKind) => void;
  /** When false, host tabs are not selectable (no host key on device). */
  canSimulateHostRoles: boolean;
}) {
  const allowed = ALL_ROLES.filter((r) =>
    props.canSimulateHostRoles ? true : r !== 'host_moderator' && r !== 'host_player'
  );

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 16 }}>
      <span style={{ fontSize: 13, color: '#555', marginRight: 8 }}>Simulated role</span>
      {allowed.map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => props.onChange(r)}
          style={{
            fontSize: 12,
            padding: '6px 10px',
            borderRadius: 8,
            border: `1px solid ${props.active === r ? '#2563eb' : '#d1d5db'}`,
            background: props.active === r ? '#eff6ff' : '#fff',
            cursor: 'pointer'
          }}
        >
          {r}
        </button>
      ))}
    </div>
  );
}
