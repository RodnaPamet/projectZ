import { redirect } from 'next/navigation';

import { chromeIdentity, PlayerChrome } from '@/components/layout/player-chrome';
import { SIGNED_IN_HOME } from '@/components/layout/nav-items';

/**
 * The home page's layout: signed in, `/` is Играй (#362).
 *
 * The landing page (#369) sells playerz to players who have not found it yet
 * and to clubs, and ends in a contact form for clubs. A signed-in account is
 * past all of that, so it is sent to Играй, the venue index, which its
 * AppShell frame wears like every other page. The check is the chrome's own
 * request-cached identity read, the one every frame is drawn from.
 *
 * ═══ HERE, AND NOT IN THE PAGE ═══
 *
 * The page sits under `loading.tsx`, so the response starts streaming (200)
 * before the page runs, and a redirect from inside it would be a client-side
 * one after the landing's skeleton had painted. A layout runs above its
 * segment's loading boundary: a signed-in document request for `/` is a plain
 * 307 with nothing drawn first, and a client navigation follows it before
 * anything paints. Links inside the shells point at Играй directly
 * (`SIGNED_IN_HOME`), so the hop is only ever the typed address or a bookmark.
 *
 * Signed out, it wears the public chrome around the landing, with the footer
 * and its language switch, so the page's skeleton is drawn under the real
 * header rather than a stand-in for it.
 */
export default async function HomeLayout({ children }: { children: React.ReactNode }) {
  if (await chromeIdentity()) redirect(SIGNED_IN_HOME);
  return <PlayerChrome footer>{children}</PlayerChrome>;
}
