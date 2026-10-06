'use client';

import type { MeDto } from '@/app/api/v1/_lib/dto';
import { KEYS, V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { useV1SWR } from '@/lib/data/use-v1-swr';

/** What `PATCH /api/v1/me` takes: either field, or both. */
export interface AccountPatch {
  name?: string;
  sports?: Array<{ sport: string; level: number }>;
}

/**
 * The account behind the profile sections (#359): `GET /api/v1/me`, seeded
 * from the server, and `PATCH` of the same URL to change it.
 *
 * Both sections call this with the same seed, so they read ONE cache entry:
 * a name saved in one is in the other at once. The write is optimistic: the
 * new value shows when Save is pressed, and a refusal puts the old one back
 * (SWR's rollback) for the section to say why. A success re-reads the account,
 * so what stays on screen is what the server stored (a trimmed name, the
 * sports in their order).
 */
export function useAccount(seed: MeDto) {
  const key = KEYS.account();
  const { data } = useV1SWR<MeDto>(key, { fallbackData: seed });

  const save = useV1Mutation<AccountPatch, MeDto, MeDto>({
    url: () => V1.updateAccount(),
    method: 'PATCH',
    body: (patch) => patch,
    target: { key },
    update: (current, patch) => ({
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.sports !== undefined ? { sports: patch.sports as MeDto['sports'] } : {}),
    }),
    fallback: seed,
  });

  return { account: data ?? seed, save };
}
