import { PlayerChrome } from '@/components/layout/player-chrome';

/**
 * The site's pages and their chrome (T20, #362): /venues, a venue, a club,
 * /login, /invite/* and the account's own pages, /me/*.
 *
 * `PlayerChrome` decides the frame on the server, once per request: a
 * signed-out visitor gets the public header, the footer with the language
 * switch (#368) and, below `md`, the bottom tab bar; a signed-in account gets
 * upstream's AppShell with its kind's sidebar. Mounted once here, so a
 * navigation between these pages re-renders the page, not the frame: a tap
 * between Играй and Резервации keeps the shell (and a collapsed rail) as it
 * was. That is why /me lives in this group rather than in `(app)`.
 *
 * The tab bar hides itself on /login and /invite/*, where a page has one job.
 * Every page here still checks its own session; the chrome only reads who is
 * asking, to draw their frame.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <PlayerChrome footer>{children}</PlayerChrome>;
}
