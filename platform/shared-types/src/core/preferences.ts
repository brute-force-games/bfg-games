import { z } from 'zod';
import { zAvatarColor, zDisplayName } from './schemas';

export const zPreferencesV1 = z.object({
  version: z.literal(1),
  displayName: zDisplayName,
  avatarColor: zAvatarColor
});
export type PreferencesV1 = z.infer<typeof zPreferencesV1>;

export const zAnyPreferences = z.union([zPreferencesV1]);
export type AnyPreferences = z.infer<typeof zAnyPreferences>;

