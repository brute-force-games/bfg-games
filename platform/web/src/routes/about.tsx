import { createFileRoute, Link } from '@tanstack/react-router';

export const Route = createFileRoute('/about')({ component: AboutRoute });

const isDev = import.meta.env.DEV;
const gitSha = __APP_GIT_SHA__;
const buildTime = __APP_BUILD_TIME__;

const versionString = isDev
  ? `dev · ${gitSha}`
  : gitSha;

export function AboutRoute() {
  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>About</h1>
        <Link to="/">Home</Link>
      </div>

      <div style={{ marginTop: 16, padding: 16, border: '1px solid #ddd', borderRadius: 12 }}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Build info</h2>
        <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
          <tbody>
            <tr>
              <td style={{ paddingRight: 24, paddingBottom: 6, color: '#555', whiteSpace: 'nowrap' }}>Version</td>
              <td style={{ paddingBottom: 6, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                {versionString}
              </td>
            </tr>
            <tr>
              <td style={{ paddingRight: 24, paddingBottom: 6, color: '#555' }}>Git commit</td>
              <td style={{ paddingBottom: 6, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                {gitSha}
              </td>
            </tr>
            <tr>
              <td style={{ paddingRight: 24, paddingBottom: 6, color: '#555' }}>Build time</td>
              <td style={{ paddingBottom: 6, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                {new Date(buildTime).toLocaleString()} ({buildTime})
              </td>
            </tr>
            <tr>
              <td style={{ paddingRight: 24, color: '#555' }}>Environment</td>
              <td style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                {isDev ? 'development (dev server)' : 'production'}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
