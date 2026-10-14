import { searchPlayers } from '@/app-layer/usecases/messaging-directory';
import { foldName } from '@/lib/text/name-fold';

import { prismaTestClient, resetDatabase, seedAccount } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * FINDING A PLAYER BY NAME, IN EITHER ALPHABET (#482, P75), against a real
 * database: the query is folded in TypeScript, the name by the database's
 * `playerz_name_fold`, and the two must agree letter for letter.
 */
const db = prismaTestClient();

const NAMES = [
  'Иван Петров',
  'ПЕТЪР ЩЕРЕВ',
  'Жоро Цветков',
  'Юлия Янева',
  'Христо Чавдаров',
  'Шишкова Мария',
  'Ёлка Ыванова Эрих',
  'Ѝван',
  'Ivan Ivanov',
  'Maria-Elena O’Brien',
  'Яна 2',
];

async function player(name: string, searchable = true) {
  const id = await seedAccount('PLAYER', db);
  await asAppSuperuser(db, (tx) => tx.user.update({ where: { id }, data: { name, searchable } }));
  return id;
}

beforeEach(() => resetDatabase(db));

it('the database folds every name exactly as the query is folded', async () => {
  const rows = await asAppSuperuser(db, (tx) =>
    tx.$queryRawUnsafe<Array<{ input: string; folded: string }>>(
      `SELECT input, playerz_name_fold(input) AS folded FROM unnest($1::text[]) AS input`,
      NAMES,
    ),
  );
  for (const { input, folded } of rows) expect(folded).toBe(foldName(input));
  expect(foldName('Петър Щерев')).toBe('petar shterev');
  expect(foldName('Жоро Цветков')).toBe('zhoro tsvetkov');
  expect(foldName('Ivan')).toBe('ivan');
});

it('"Ivan" finds «Иван», «иван» finds "Ivan", and a prefix comes first', async () => {
  const viewer = await player('Гледащ Играч');
  const cyrillic = await player('Иван Петров');
  const latin = await player('Ivan Ivanov');
  const later = await player('Стоян Иванов');
  await player('Иван Скрит', false);

  const byLatin = await searchPlayers(viewer, 'Ivan');
  expect(byLatin.map((p) => p.userId).sort()).toEqual([cyrillic, latin, later].sort());
  // The two whose names start with it lead; "Стоян Иванов" only contains it.
  expect(
    byLatin
      .map((p) => p.userId)
      .slice(0, 2)
      .sort(),
  ).toEqual([cyrillic, latin].sort());
  expect(byLatin.at(-1)!.userId).toBe(later);

  const byCyrillic = await searchPlayers(viewer, 'иван');
  expect(byCyrillic.map((p) => p.userId).sort()).toEqual([cyrillic, latin, later].sort());

  // Somebody who is not searchable is never found, in either alphabet.
  expect((await searchPlayers(viewer, 'skrit')).length).toBe(0);
  expect((await searchPlayers(viewer, 'Скрит')).length).toBe(0);
});

it('a query with LIKE wildcards in it is taken literally', async () => {
  const viewer = await player('Гледащ Играч');
  await player('Иван Петров');
  expect(await searchPlayers(viewer, '%%')).toEqual([]);
  expect(await searchPlayers(viewer, 'i_an')).toEqual([]);
});

it('the search reads the trigram index, not every account', async () => {
  for (let i = 0; i < 30; i++) await player(`Играч Номер ${i}`);
  const plan = await asAppSuperuser(db, async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
    const rows = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
      `EXPLAIN SELECT id FROM app_user u
        WHERE playerz_name_fold(u."name") LIKE '%ivan%'
          AND u."searchable" = true AND u."deletedAt" IS NULL`,
    );
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  });
  expect(plan).toContain('app_user_name_fold_trgm_idx');
});
