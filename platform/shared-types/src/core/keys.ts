import { z } from 'zod';

// Raw 32-byte key encoded as base64url (no padding) — fits Ed25519 + X25519
// public keys, AES-GCM 256-bit derived nonces, etc.
const zKey32B64Url = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

// Ed25519 signing public key (raw 32 bytes, base64url)
export const zSigningPubKeyBytes = zKey32B64Url.brand<'SigningPubKeyBytes'>();
export type SigningPubKeyBytes = z.infer<typeof zSigningPubKeyBytes>;

// X25519 player encryption public key (raw 32 bytes, base64url)
export const zPlayerEncPubKeyBytes = zKey32B64Url.brand<'PlayerEncPubKeyBytes'>();
export type PlayerEncPubKeyBytes = z.infer<typeof zPlayerEncPubKeyBytes>;

// X25519 host-per-room encryption public key (raw 32 bytes, base64url)
export const zGameEncPubKeyBytes = zKey32B64Url.brand<'GameEncPubKeyBytes'>();
export type GameEncPubKeyBytes = z.infer<typeof zGameEncPubKeyBytes>;

// JWK base64url field (variable length; OKP `x` and `d` are 32 bytes → 43 chars)
const zJwkB64UrlField = z.string().regex(/^[A-Za-z0-9_-]+$/).min(1);

// Ed25519 private key in JWK form. Matches `subtle.exportKey('jwk', edPrivCryptoKey)`.
export const zEd25519PrivJwk = z
  .object({
    kty: z.literal('OKP'),
    crv: z.literal('Ed25519'),
    x: zJwkB64UrlField,
    d: zJwkB64UrlField
  })
  .brand<'Ed25519PrivJwk'>();
export type Ed25519PrivJwk = z.infer<typeof zEd25519PrivJwk>;

// X25519 private key in JWK form. Matches `subtle.exportKey('jwk', xPrivCryptoKey)`.
export const zX25519PrivJwk = z
  .object({
    kty: z.literal('OKP'),
    crv: z.literal('X25519'),
    x: zJwkB64UrlField,
    d: zJwkB64UrlField
  })
  .brand<'X25519PrivJwk'>();
export type X25519PrivJwk = z.infer<typeof zX25519PrivJwk>;

// Crypto operation values
export const zChallengeNonce = zKey32B64Url.brand<'ChallengeNonce'>();
export type ChallengeNonce = z.infer<typeof zChallengeNonce>;

// Ed25519 signature: 64 raw bytes → 86 base64url chars
export const zSignature = z
  .string()
  .regex(/^[A-Za-z0-9_-]{86}$/)
  .brand<'Signature'>();
export type Signature = z.infer<typeof zSignature>;

export const zEncryptedPayload = z.string().min(1).brand<'EncryptedPayload'>();
export type EncryptedPayload = z.infer<typeof zEncryptedPayload>;

// AES-GCM 96-bit IV: 12 raw bytes → 16 base64url chars
export const zSecretMessageIv = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16}$/)
  .brand<'SecretMessageIv'>();
export type SecretMessageIv = z.infer<typeof zSecretMessageIv>;
