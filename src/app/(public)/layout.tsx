import { PlayerChrome } from '@/components/layout/player-chrome';

/**
 * The public pages' chrome (T20): the site header and, below `md`, the bottom
 * tab bar, mounted once for /venues, /login and /invite/* so a navigation
 * between them re-renders the page, not the header. The tab bar hides itself
 * on /login and /invite/*, where a page has one job.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <PlayerChrome>{children}</PlayerChrome>;
}
