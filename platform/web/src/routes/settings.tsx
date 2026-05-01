import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { type AvatarColor } from '@brute-force-games/shared-types';

import { useSync } from '../sync/SyncContext';

export const Route = createFileRoute('/settings')({ component: SettingsRoute });

function SettingsRoute() {
  const { preferences, updatePreferences } = useSync();
  const [displayName, setDisplayName] = useState(preferences.displayName);
  const [avatarColor, setAvatarColor] = useState(preferences.avatarColor);

  useEffect(() => {
    setDisplayName(preferences.displayName);
    setAvatarColor(preferences.avatarColor);
  }, [preferences.avatarColor, preferences.displayName]);

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>Settings</h1>
        <Link to="/">Home</Link>
      </div>

      <div style={{ marginTop: 16, padding: 16, border: '1px solid #ddd', borderRadius: 12 }}>
        <label style={{ display: 'block', marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Display name</div>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ccc' }}
          />
        </label>

        <label style={{ display: 'block' }}>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Avatar color</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input type="color" value={avatarColor} onChange={(e) => setAvatarColor(e.target.value as AvatarColor)} />
            <div style={{ width: 28, height: 28, borderRadius: 999, background: avatarColor }} />
            <div style={{ color: '#555' }}>{displayName}</div>
          </div>
        </label>

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button
            type="button"
            onClick={() => {
              const name = displayName.trim();
              if (!name) return;
              updatePreferences({ displayName: name, avatarColor });
            }}
            disabled={!displayName.trim()}
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setDisplayName(preferences.displayName);
              setAvatarColor(preferences.avatarColor);
            }}
          >
            Reset
          </button>
        </div>

        <p style={{ marginTop: 12, color: '#555' }}>
          Saved values are written to local preferences and immediately republished into your `players` row for this room.
        </p>
      </div>
    </div>
  );
}

