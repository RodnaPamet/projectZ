import { phoneStanding } from '@/app-layer/usecases/phone-verification';
import { playerChrome } from '@/components/layout/player-chrome';
import { KIND_CHOOSER_PATH } from '@/lib/auth/landing';
import { phoneRequired } from '@/lib/sms/phone-verifier';

/**
 * Who is looking at a page that books something, as far as booking goes:
 *
 *   signed-out  signs in first, and comes back to what was picked
 *   undecided   an account that has not answered "Играч или треньор?" (#360)
 *               answers it first: the API refuses it until then (#416)
 *   no-phone    a player with no confirmed phone number, once the rule is on
 *               (#500), confirms one first
 *   player      books (a coach books as a player does: decision 3, #377)
 *   club        a club account does not book, and is told so
 *
 * A hint for the page, so that «Резервирай» leads to the step that is owed
 * instead of into a sheet that can only refuse. The API decides again when
 * the booking is made.
 */
export type BookingViewer = 'signed-out' | 'undecided' | 'no-phone' | 'player' | 'club';

export async function bookingViewer() {
  const { me, kind, landing } = await playerChrome();
  const who: BookingViewer =
    landing?.href === KIND_CHOOSER_PATH ? 'undecided' : kind === 'coach' ? 'player' : kind;
  // One read, and only for a player while the rule is on.
  const viewer: BookingViewer =
    who === 'player' && me && phoneRequired() && !(await phoneStanding(me.userId))?.verified
      ? 'no-phone'
      : who;
  return { me, kind, viewer };
}
