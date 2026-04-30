import { z } from 'zod';

/**
 * Zod-first branding helpers.
 * We infer branded TS types via `z.infer<typeof schema>` everywhere.
 */
export function brandString<B extends string>(brand: B) {
  return z.string().brand<B>();
}

