import { zTicTacToeConfig, type TicTacToeConfig } from '@brute-force-games/shared-types';

export function TicTacToeConfigUI(props: {
  config: TicTacToeConfig;
  onChange: (next: TicTacToeConfig) => void;
  isHost: boolean;
}) {
  const { config, onChange, isHost } = props;
  const cfg = zTicTacToeConfig.safeParse(config).data ?? { symbolPair: 'xo', ui: 'godot' };
  const symbols =
    cfg.symbolPair === 'lion_lamb'
      ? ({ X: 'Lion', O: 'Lamb' } as const)
      : cfg.symbolPair === 'red_blue'
        ? ({ X: 'Red', O: 'Blue' } as const)
        : ({ X: 'X', O: 'O' } as const);

  return (
    <div style={{ padding: 12, borderRadius: 12, border: '1px solid #ddd', background: '#fff' }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Variant</div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{ width: 120, color: '#555' }}>UI</span>
        <select
          value={cfg.ui}
          disabled={!isHost}
          onChange={(e) => {
            const next = zTicTacToeConfig.parse({ ...cfg, ui: e.target.value });
            onChange(next);
          }}
        >
          <option value="godot">Godot (iframe)</option>
          <option value="react">React</option>
        </select>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 120, color: '#555' }}>Symbols</span>
        <select
          value={cfg.symbolPair}
          disabled={!isHost}
          onChange={(e) => {
            const next = zTicTacToeConfig.parse({ ...cfg, symbolPair: e.target.value });
            onChange(next);
          }}
        >
          <option value="xo">X &amp; O</option>
          <option value="lion_lamb">Lion vs Lamb</option>
          <option value="red_blue">Red vs Blue</option>
        </select>
      </label>
      <div style={{ marginTop: 8, color: '#666', fontSize: 13 }}>
        Preview: <strong>{symbols.X}</strong> vs <strong>{symbols.O}</strong>
      </div>
    </div>
  );
}

