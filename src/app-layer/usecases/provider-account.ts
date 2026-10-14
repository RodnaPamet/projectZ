import { inheritNoShowStanding } from '@/app-layer/usecases/no-show-carry';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import type { Locale } from '@/lib/i18n/locales';
import { ownAvatar } from '@/lib/media/avatar-url';
import { getMediaStorage } from '@/lib/media/storage';
import { logger } from '@/lib/observability/logger';

/**
 * THE ACCOUNT A PROVIDER SIGN-IN LANDS IN, FOR THE WEB AND THE APP ALIKE.
 *
 * The web's `signIn` callback (`src/auth.ts`) and the native token exchange
 * (`POST /api/v1/auth/token`, #444) both end here, once each has decided the
 * provider's word is good enough: an address is present, and for Google it is
 * proved. Two copies of this would drift in exactly the way that matters, a
 * person getting a second account because one path matched differently.
 *
 * Runs as app_superuser: no tenant is bound during sign-in, and an RLS-scoped
 * read of `app_user` would see nothing.
 */
export interface ProviderSignIn {
  provider: 'google' | 'facebook' | 'apple';
  /** Trimmed and lower-cased by the caller. */
  email: string;
  name: string | null;
  /** The provider's picture URL, copied into our storage, never kept as is. */
  picture: string | null;
  /** The language a NEW account starts in; an existing one keeps its own. */
  locale: Locale | null | undefined;
}

export async function resolveProviderAccount(input: ProviderSignIn): Promise<{ userId: string }> {
  const { email } = input;

  // Upsert, not find-then-create: two tabs racing a first sign-in would
  // otherwise both miss and one would die on the unique constraint.
  //
  // `update: {}` is deliberate. Re-running this on every sign-in would let
  // the provider overwrite a name or avatar the person has since changed in
  // the app, silently, on each login.
  //
  // A NEW account starts in the language its visitor chose signed out
  // (#431): on the web the footer switch writes the cookie, and without this
  // the account was created in Bulgarian and the middleware then flipped an
  // English visitor back on their first signed-in page. Only on create; an
  // existing account keeps what its profile says.
  const row = await runAsSuperuser((db) =>
    db.user.upsert({
      where: { email },
      create: {
        email,
        ...(input.locale ? { locale: input.locale } : {}),
        name: input.name,
        // Never the provider's URL (#458): the copy below fills it.
        avatarUrl: null,
        // The provider asserted it, and for Google the caller checked it.
        emailVerified: new Date(),
        // A first sign-in holds nothing and has decided nothing: the person is
        // asked "Играч или треньор?" before anything else (#360, Q13), and
        // `/start` sends an undecided account to that question. Stated rather
        // than left to the column default (PLAYER, which scripts and the
        // previous image still rely on), because it is a decision. A staff
        // invite or being made an owner still turns an EMPTY undecided account
        // into a CLUB account (`account-kind.ts`), as it did an empty player.
        accountKind: null,
      },
      update: {},
      select: { id: true, avatarUrl: true },
    }),
  );

  // ═══ THE PICTURE IS OURS (#458) ═══
  //
  // The provider's picture is fetched here, on the server, and a copy of it
  // kept in our media storage (`@/lib/media/avatars`): a provider's URL would
  // send every viewer's IP address to Google or Meta, and Facebook's expire.
  // The first sign-in copies it; a Facebook sign-in re-reads Facebook's, since
  // it may have changed; nothing replaces a picture from the other provider
  // (`copiesAvatar`). Saved only over the value read above, so two sign-ins
  // racing cannot write over each other.
  //
  // Contained: a picture is not worth failing a sign-in over, and one that was
  // not copied leaves the initials. `syncAvatarAtSignIn` never throws; loading
  // it can (the image library is native), so that is caught too. Loaded here,
  // so the routes that only read `authOptions` do not load the image library.
  try {
    const { syncAvatarAtSignIn } = await import('@/lib/media/avatars');
    await syncAvatarAtSignIn(
      {
        provider: input.provider,
        userId: row.id,
        stored: row.avatarUrl,
        picture: input.picture,
        save: async (avatarUrl) =>
          (
            await runAsSuperuser((db) =>
              db.user.updateMany({
                where: { id: row.id, avatarUrl: row.avatarUrl, deletedAt: null },
                data: { avatarUrl: ownAvatar(avatarUrl) },
              }),
            )
          ).count === 1,
      },
      getMediaStorage(),
    );
  } catch (error) {
    logger.warn('sign-in: the profile picture step failed', {
      component: 'auth',
      error: error instanceof Error ? error.name : 'unknown',
    });
  }

  // ═══ A DELETED ACCOUNT'S NO-SHOW STANDING WAITS FOR THIS ADDRESS ═══
  //
  // If an account with this address was deleted while it had no-shows that
  // still counted at a club, this account takes them over (#370 review, P53):
  // the club's block holds as it would have. Idempotent and one indexed
  // lookup, so it runs at every sign-in; a first sign-in after the deletion is
  // the one that finds something. Contained: a failure here is logged, and the
  // next sign-in tries again.
  try {
    await inheritNoShowStanding(row.id, email);
  } catch (error) {
    logger.warn('sign-in: a carried no-show standing was not taken over', {
      component: 'auth',
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { userId: row.id };
}
