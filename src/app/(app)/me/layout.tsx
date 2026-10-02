import { PlayerChrome } from '@/components/layout/player-chrome';

/**
 * A signed-in player's own pages (/me/*) wear the player chrome (T20): the
 * site header and, below `md`, the bottom tab bar. Each page still checks its
 * own session; the chrome only reads who is asking, to say so.
 */
export default function MeLayout({ children }: { children: React.ReactNode }) {
  return <PlayerChrome>{children}</PlayerChrome>;
}
