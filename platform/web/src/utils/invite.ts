export type ParsedInvite =
  | { kind: 'roomLink'; roomId: string; invite?: string }
  | { kind: 'roomId'; roomId: string }
  | { kind: 'inviteCode'; invite: string };

function base64Url(bytes: Uint8Array): string {
  // Browser-safe base64url without padding.
  const binary = String.fromCharCode(...bytes);
  const b64 = btoa(binary);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function makeRoomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  // Keep it short but still random; ids.ts only checks prefix format in Phase 2.
  return `room_${base64Url(bytes)}`;
}

export function generateInviteCode(): string {
  // Simple 6-char base32-ish alphabet, excludes ambiguous chars.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export function parseInviteInput(inputRaw: string): ParsedInvite | null {
  const input = inputRaw.trim();
  if (!input) return null;

  // Full URL?
  try {
    const url = new URL(input);
    const m = url.pathname.match(/\/room\/([^/]+)\/play\/?$/);
    if (m) {
      const roomIdPart = m[1];
      if (!roomIdPart) return null;
      const roomId = decodeURIComponent(roomIdPart);
      const invite = url.searchParams.get('invite') ?? undefined;
      return { kind: 'roomLink', roomId, ...(invite !== undefined ? { invite } : {}) };
    }
  } catch {
    // not a URL
  }

  // Room id direct?
  if (/^room_[A-Za-z0-9_-]+$/.test(input)) return { kind: 'roomId', roomId: input };

  // Invite code only?
  if (/^[A-Z2-9]{4,10}$/.test(input.toUpperCase())) return { kind: 'inviteCode', invite: input.toUpperCase() };

  return null;
}

