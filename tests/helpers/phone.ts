import type { PrismaClient } from '@prisma/client';

import { phoneFingerprint } from '@/lib/account/phone-fingerprint';
import { encryptField } from '@/lib/security/encryption';

import { asAppSuperuser } from './rls';

/**
 * Give an account a confirmed phone number (#500), as the phone step leaves
 * it: the number encrypted, its keyed fingerprint, and the moment.
 *
 * For tests that are about something else and only need the account to be
 * past the gate, or to hold a particular number.
 */
export async function confirmPhoneFor(
  db: PrismaClient,
  userId: string,
  e164: string = `+3598${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
): Promise<string> {
  await asAppSuperuser(db, (tx) =>
    tx.user.update({
      where: { id: userId },
      data: {
        phone: encryptField(e164),
        phoneHash: phoneFingerprint(e164),
        phoneVerifiedAt: new Date(),
      },
    }),
  );
  return e164;
}
