import { inviteStaffAction } from '@/app/(app)/t/[slug]/admin/staff/actions';
import { INVITE_ROLES } from '@/app/(app)/t/[slug]/admin/staff/roles';

import { signInAs } from '../helpers/auth';
import { prismaTestClient, resetDatabase, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * WHAT THE STAFF PAGE MAY INVITE TO (#278).
 *
 * The invite form defaulted to COACH, and since #272 nothing can accept a
 * COACH invite: a coach is its own kind of account (#263) that nothing creates
 * until #269. A PLAYER invite is refused by kind when a club account accepts
 * it, and players join by booking anyway. So the page offers MANAGER and STAFF,
 * and the ACTION refuses the rest — the form is a courtesy, the action is a
 * POST endpoint reachable without it.
 *
 * Driven through the real Server Action with a real session cookie, as
 * account-kinds.test.ts drives the staff actions.
 */

let sessionCookie: string | null = null;

jest.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () =>
      sessionCookie
        ? [
            { name: 'next-auth.session-token', value: sessionCookie },
            { name: '__Secure-next-auth.session-token', value: sessionCookie },
          ]
        : [],
  }),
  headers: async () => new Headers(),
}));

// `revalidatePath` needs a Next request store the actions do not have here.
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }));

// Delivery is not what is under test; the row is.
const sendMail = jest.fn();
jest.mock('@/lib/email/mailer', () => ({
  sendMail: (...args: unknown[]) => sendMail(...args),
}));

const db = prismaTestClient();

const invitesAt = (tenantId: string) =>
  asAppSuperuser(db, (tx) =>
    tx.invite.findMany({ where: { tenantId }, select: { email: true, role: true } }),
  );

function inviteForm(email: string, role: string) {
  const form = new FormData();
  form.set('email', email);
  form.set('role', role);
  return form;
}

beforeEach(async () => {
  await resetDatabase(db);
  sessionCookie = null;
  sendMail.mockReset().mockResolvedValue(undefined);
});

describe('the staff page invites to MANAGER or STAFF only', () => {
  it('offers exactly MANAGER and STAFF', () => {
    expect([...INVITE_ROLES]).toEqual(['MANAGER', 'STAFF']);
  });

  it.each(['COACH', 'PLAYER', 'OWNER'])(
    'REFUSES a hand-made POST for %s, and nothing is created or mailed',
    async (role) => {
      const club = await seedTenant({ name: `Invites ${role}` }, db);
      sessionCookie = (await signInAs(db, { userId: club.userId, memberships: [] })).bearer;

      await expect(
        inviteStaffAction(club.tenantSlug, null, inviteForm(`${role.toLowerCase()}@x.test`, role)),
      ).resolves.toEqual({ ok: false, error: 'BAD_ROLE' });

      expect(await invitesAt(club.tenantId)).toEqual([]);
      expect(sendMail).not.toHaveBeenCalled();
    },
  );

  it.each(['STAFF', 'MANAGER'])('sends a %s invite', async (role) => {
    const club = await seedTenant({ name: `Invites ok ${role}` }, db);
    sessionCookie = (await signInAs(db, { userId: club.userId, memberships: [] })).bearer;

    await expect(
      inviteStaffAction(club.tenantSlug, null, inviteForm('new@x.test', role)),
    ).resolves.toEqual({ ok: true });

    expect(await invitesAt(club.tenantId)).toEqual([{ email: 'new@x.test', role }]);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});
