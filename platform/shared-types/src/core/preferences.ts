import { z } from 'zod';

export const zPreferencesV1 = z.object({
  version: z.literal(1),
  displayName: z.string().min(1),
  avatarColor: z.string().regex(/^#[0-9a-fA-F]{6}$/)
});
export type PreferencesV1 = z.infer<typeof zPreferencesV1>;

export const zAnyPreferences = z.union([zPreferencesV1]);
export type AnyPreferences = z.infer<typeof zAnyPreferences>;

