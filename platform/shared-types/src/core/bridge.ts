import { z } from 'zod';

import { zGameType } from './schemas';

/**
 * Shared Godot <-> Web bridge envelope.
 *
 * Transport:
 * - parent -> iframe: iframe.contentWindow.postMessage(envelope, '*')
 * - iframe -> parent: window.parent.postMessage(envelope, '*')
 *
 * Payload:
 * - always JSON.stringify(value ?? null) on send
 * - always JSON.parse(payload) on receive
 *
 * This keeps the envelope primitive-only and avoids JS<->GDScript conversion
 * issues with nested objects/arrays.
 */
export const zBfgBridgeEnvelopeV1 = z.object({
  bfg: z.literal(true),
  v: z.literal(1),
  game: zGameType,
  type: z.string(),
  payload: z.string(),
  id: z.string().optional()
});
export type BfgBridgeEnvelopeV1 = z.infer<typeof zBfgBridgeEnvelopeV1>;

export function encodeBridgePayload(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function decodeBridgePayload(payload: string): unknown {
  return JSON.parse(payload);
}

