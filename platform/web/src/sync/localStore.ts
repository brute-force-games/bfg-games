import {
  generatePlayerIdentity,
  generateFriendlyName,
  deriveColorHex,
  seedFromPlayerId,
  zPreferencesV1,
  type LocalStore,
  type PlayerId,
  type PlayerIdentity,
  type PreferencesV1,
  zPlayerIdentity
} from '@brute-force-games/shared-types';

const IDENTITY_KEY = 'bfg.identity.v1';
const PREFERENCES_KEY = 'bfg.preferences.v1';
const SUBMISSION_NONCE_KEY_PREFIX = 'bfg.submission-nonce.v1.';

export class WebLocalStore implements LocalStore {
  getIdentity(): PlayerIdentity | null {
    const raw = localStorage.getItem(IDENTITY_KEY);
    if (!raw) return null;
    const parsed = zPlayerIdentity.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  }

  saveIdentity(identity: PlayerIdentity): void {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  }

  getPreferences(): unknown {
    const raw = localStorage.getItem(PREFERENCES_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  savePreferences(prefs: unknown): void {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(prefs));
  }

  getPreferencesV1OrNull(): PreferencesV1 | null {
    const raw = this.getPreferences();
    const parsed = zPreferencesV1.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  resetPreferences(): void {
    localStorage.removeItem(PREFERENCES_KEY);
  }

  ensurePreferencesV1(playerId: string): PreferencesV1 {
    const seed = seedFromPlayerId(playerId);
    const existing = this.getPreferencesV1OrNull();

    if (existing) return existing;

    // Migration/reset behavior (v1): if it's missing or invalid, replace it.
    const fresh: PreferencesV1 = {
      version: 1,
      displayName: generateFriendlyName(seed),
      avatarColor: deriveColorHex(seed)
    };

    this.savePreferences(fresh);
    return fresh;
  }

  savePreferencesV1(prefs: Omit<PreferencesV1, 'version'> & { version?: 1 }): PreferencesV1 {
    const parsed = zPreferencesV1.parse({
      version: 1,
      displayName: prefs.displayName,
      avatarColor: prefs.avatarColor
    });
    this.savePreferences(parsed);
    return parsed;
  }

  async ensureIdentity(): Promise<PlayerIdentity> {
    const existing = this.getIdentity();
    if (existing) return existing;
    const fresh = await generatePlayerIdentity();
    this.saveIdentity(fresh);
    return fresh;
  }

  // Returns a persistent submission-nonce provider for `playerId`. Each call
  // increments the stored value and writes it back, so the next page load
  // resumes from the last issued nonce — preventing the host from rejecting
  // post-reload submissions as replays.
  makeSubmissionNonceProvider(playerId: PlayerId): () => number {
    const key = `${SUBMISSION_NONCE_KEY_PREFIX}${playerId}`;
    return () => {
      const raw = localStorage.getItem(key);
      const current = raw ? Number.parseInt(raw, 10) : 0;
      const next = Number.isFinite(current) ? current + 1 : 1;
      localStorage.setItem(key, String(next));
      return next;
    };
  }
}
