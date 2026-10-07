'use client';

import {
  startTransition,
  useActionState,
  useCallback,
  useId,
  useMemo,
  useOptimistic,
  useState,
} from 'react';
import dynamic from 'next/dynamic';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { StatusBadge } from '@/components/ui/status-badge';
import { createColumns, DataTable } from '@/components/ui/table/data-table';

import { setPlayerTagsAction } from './actions';

/**
 * The management sheet loads on the first row opened, not with the route — the
 * same trade the courts and pricing boards made (T23, T24): most visits search
 * and read the list, and the sheet carries vaul, the ToggleGroup's motion and
 * both forms.
 */
const PlayerSheet = dynamic(() => import('./PlayerSheet'));

/**
 * The club's players.
 *
 * ═══ WHAT A CLUB MAY CHANGE, AND WHAT IT MAY NOT ═══
 *
 * Name and email are not editable here, and there is no control for them. A
 * `User` is global — one person across every club they play at, with no
 * tenantId and no row security — so a club editing a name would be editing it
 * everywhere, including at clubs that person has never visited.
 *
 * What belongs to the club is the STANDING: tags, and credit.
 *
 * ═══ ON THE PRIMITIVES (T25) ═══
 *
 * The list was a hand-rolled `<ul>` with a Manage toggle that unfolded both
 * forms inside the row. It is the vendored DataTable now: a table from `md`,
 * and below it the table's own cards, one per player, so the page never
 * scrolls sideways at 393 px. The player's name is a button in both, and opens
 * them in a Sheet holding the two forms.
 *
 * ═══ TAGS ARE OPTIMISTIC, MONEY IS NOT ═══
 *
 * A tag save closes the sheet and the row shows the new tags at once
 * (`useOptimistic`); the revalidated page the action carries back replaces
 * them in the same transition, so a refusal or a throw rolls the row back by
 * itself and a notice names the player. A credit adjustment waits for the
 * ledger: a balance shown before SERIALIZABLE has agreed to it would be a
 * number the club might act on and the ledger might refuse.
 */

export interface PlayerRow {
  playerUserId: string;
  name: string | null;
  email: string;
  tags: string[];
  noShowCount: number;
  lastPlayedAt: string | null;
  membershipLevel: string | null;
  creditCents: number;
  /**
   * The block on online booking (#354): no-shows that count towards it, whether
   * it is in force, and when staff last lifted one. Computed by the page.
   */
  noShowBlock: { recentNoShows: number; blocked: boolean; lastLiftedAt: string | null };
}

/**
 * ═══ OPENING A ROW ═══
 *
 * The name is a real button, and the row has no `onRowClick`: from md a
 * clickable `<tr>` has no keyboard path at all. (Below md a clickable card was
 * also `role="button"` straight inside `role="list"`, which axe refused as
 * critical at 393 px on this page; upstream #3129 wraps it in a listitem now.)
 * A button in the name cell is reachable by Tab and Enter in both renderings,
 * and leaves each card a plain list item. It is the vendored `Button`, ghost
 * (no tile at rest, as a name in a list should read), in the headings' colour:
 * 44 px on a coarse pointer and the focus halo come with it, where a styled
 * <button> had to restate both (#362).
 */

/**
 * ═══ THIRTY AT A TIME ═══
 *
 * The list renders the first 30 matches and a "show more" button, not all of
 * them. Measured with perf:nav on the perf seed's 121-player club, the whole
 * list as a DataTable made the phone (CPU x4) `pricing → players` step 431 →
 * 555 ms cold and 110 → 194 ms warm: below md the table renders every row once
 * as a desktop table (`useIsBelowMd` is false until its effect) and again as cards.
 * Thirty at a time measured 483 ms cold and 108 ms warm; what remains of the
 * cold step is the table's ~30 KB of JS arriving with the route.
 * Search still runs over every player the page loaded, so nobody is out of
 * reach; the button is in both renderings, unlike the DataTable's pagination
 * footer, which the cards do not draw.
 */
const PAGE = 30;

const NO_TAG_OVERRIDES: Readonly<Record<string, readonly string[]>> = {};

/** The same cleaning `setPlayerTags` applies, so the optimistic row matches what lands. */
function cleanTags(raw: FormDataEntryValue | null): string[] {
  const tags = typeof raw === 'string' ? raw.split(',') : [];
  return [...new Set(tags.map((t) => t.trim()).filter(Boolean))].sort();
}

export function PlayersBoard({
  slug,
  players,
  canAdjustCredit,
  canLiftNoShowBlock,
  noShowWindowDays,
}: {
  slug: string;
  players: readonly PlayerRow[];
  /** `players.credit_adjust` — OWNER and MANAGER only. A COACH sees no form. */
  canAdjustCredit: boolean;
  /** `bookings.view_all` — the desk. A COACH sees the block but cannot lift it. */
  canLiftNoShowBlock: boolean;
  noShowWindowDays: number;
}) {
  const t = useTranslations('admin.players');
  const format = useFormatter();
  const ids = useId();
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(PAGE);
  // The open player outlives the sheet's open flag, so the closing sheet still
  // shows them while it plays its exit. Mounted from the first open on.
  const [openId, setOpenId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const [tagOverrides, setOptimisticTags] = useOptimistic(
    NO_TAG_OVERRIDES,
    (s, next: { id: string; tags: readonly string[] }) => ({ ...s, [next.id]: next.tags }),
  );
  const [tagsFailedFor, saveTags, tagsPending] = useActionState(
    async (_prev: string | null, input: { player: PlayerRow; form: FormData }) => {
      const { player, form } = input;
      setOptimisticTags({ id: player.playerUserId, tags: cleanTags(form.get('tags')) });
      try {
        const result = await setPlayerTagsAction(slug, player.playerUserId, null, form);
        return result.ok ? null : (player.name ?? player.email);
      } catch {
        return player.name ?? player.email;
      }
    },
    null,
  );

  const rows = useMemo(
    () =>
      players.map((p) =>
        tagOverrides[p.playerUserId] ? { ...p, tags: [...tagOverrides[p.playerUserId]!] } : p,
      ),
    [players, tagOverrides],
  );

  const q = search.trim().toLowerCase();
  const visible = useMemo(
    () =>
      q
        ? rows.filter(
            (p) => p.email.toLowerCase().includes(q) || (p.name ?? '').toLowerCase().includes(q),
          )
        : rows,
    [rows, q],
  );

  const shown = useMemo(() => visible.slice(0, limit), [visible, limit]);

  const open = useCallback((id: string) => {
    setOpenId(id);
    setSheetOpen(true);
  }, []);

  // Memoised: a fresh column array each render makes the table rebuild its
  // column model on every keystroke in the search box.
  const columns = useMemo(() => {
    const money = (cents: number) =>
      format.number(cents / 100, { style: 'currency', currency: 'EUR' });
    return createColumns<PlayerRow>([
      {
        id: 'name',
        header: t('field.name'),
        cell: ({ row }) => {
          // The name IS the row's control, in the table and in the cards: see
          // OPENING A ROW below.
          return (
            <Button
              type="button"
              variant="ghost"
              className="text-content-emphasis"
              onClick={() => open(row.original.playerUserId)}
            >
              {row.original.name ?? row.original.email}
            </Button>
          );
        },
      },
      {
        id: 'email',
        header: t('field.email'),
        cell: ({ row }) => <span className="text-content-muted">{row.original.email}</span>,
      },
      {
        id: 'tags',
        header: t('field.tags'),
        cell: ({ row }) => (
          <span className="inline-flex flex-wrap justify-end gap-1 md:justify-start">
            {row.original.membershipLevel && (
              <StatusBadge variant="info">{row.original.membershipLevel}</StatusBadge>
            )}
            {row.original.tags.map((tag) => (
              <StatusBadge key={tag} variant="neutral">
                {tag}
              </StatusBadge>
            ))}
          </span>
        ),
      },
      {
        id: 'credit',
        header: t('field.credit'),
        cell: ({ row }) => <span className="tabular-nums">{money(row.original.creditCents)}</span>,
      },
      {
        id: 'noShows',
        header: t('field.noShows'),
        cell: ({ row }) => (
          <span className="inline-flex flex-wrap justify-end gap-1 md:justify-start">
            {row.original.noShowCount > 0 ? (
              <StatusBadge variant="warning">
                {t('noShows', { count: row.original.noShowCount })}
              </StatusBadge>
            ) : (
              <span className="text-content-muted tabular-nums">0</span>
            )}
            {row.original.noShowBlock.blocked && (
              <StatusBadge variant="error">{t('noShowBlock.badge')}</StatusBadge>
            )}
          </span>
        ),
      },
    ]);
  }, [t, format, open]);

  if (players.length === 0) {
    return (
      <div data-perf-ready>
        <EmptyState title={t('empty.title')} description={t('empty.description')} />
      </div>
    );
  }

  const current = openId ? rows.find((p) => p.playerUserId === openId) : undefined;

  return (
    <div className="gap-default grid">
      <div className="sm:max-w-xs">
        <FormField label={t('search')}>
          <Input
            id={`${ids}-search`}
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setLimit(PAGE);
            }}
            autoComplete="off"
          />
        </FormField>
      </div>

      {tagsFailedFor !== null && !tagsPending && (
        <InlineNotice variant="error">{t('tagsFailed', { name: tagsFailedFor })}</InlineNotice>
      )}

      {/* data-perf-ready: the perf harness's READY marker (docs/perf/README.md),
          on the DataTable's wrapper so it is there in both the table and the
          card rendering. */}
      <div data-perf-ready className="min-w-0">
        {visible.length === 0 ? (
          <EmptyState title={t('noMatch.title')} description={t('noMatch.description')} />
        ) : (
          <DataTable<PlayerRow>
            data={shown}
            columns={columns}
            getRowId={(p) => p.playerUserId}
            // Cards below md, explicitly: a five-column table does not fit 393 px.
            mobileFallback="card"
            selectionEnabled={false}
            data-testid="players-table"
          />
        )}
      </div>

      {visible.length > shown.length && (
        <div>
          <Button type="button" variant="secondary" onClick={() => setLimit((n) => n + PAGE)}>
            {t('showMore', { count: Math.min(PAGE, visible.length - shown.length) })}
          </Button>
        </div>
      )}

      {openId !== null && current && (
        <PlayerSheet
          slug={slug}
          player={current}
          canAdjustCredit={canAdjustCredit}
          canLiftNoShowBlock={canLiftNoShowBlock}
          noShowWindowDays={noShowWindowDays}
          open={sheetOpen}
          setOpen={setSheetOpen}
          onSaveTags={(form) => {
            setSheetOpen(false);
            startTransition(() => saveTags({ player: current, form }));
          }}
        />
      )}
    </div>
  );
}
