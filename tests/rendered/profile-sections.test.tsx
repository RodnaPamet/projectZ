import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

import type { MeDto } from '@/app/api/v1/_lib/dto';
import { nameErrorKey, PersonalDataSection } from '@/components/profile/PersonalDataSection';
import { picksToSports, SportLevelsSection } from '@/components/profile/SportLevelsSection';
import { TooltipProvider } from '@/components/ui/tooltip';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { ApiClientError } from '@/lib/data/errors';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';
import { PROFILE_SPORTS, SPORT_LEVELS } from '@/lib/profile/limits';

import { messages, withIntl } from '../helpers/intl';
import { fail, installFakeFetch, ok, tick, type FakeAnswer } from '../unit/data/fake-v1';

/**
 * /me/profile's #359 sections, against the REAL Bulgarian catalogue and a fake
 * v1: the name (N01) and the sports with a 1–7 level each (Q37).
 */

const p = messages.profile;

const me = (over: Partial<MeDto> = {}): MeDto => ({
  id: 'usr_player',
  name: null,
  email: 'new@playerz.test',
  avatarUrl: null,
  locale: 'bg',
  sports: [],
  accountKind: 'PLAYER',
  landing: { reason: 'player', club: null },
  ...over,
});

function mount(ui: React.ReactElement) {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map() }}>
          {/* The app root provides the TooltipProvider the Sheet's close button needs. */}
          <TooltipProvider>
            <ViewerScope viewerId="usr_player">{ui}</ViewerScope>
          </TooltipProvider>
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  __resetSessionExpiryForTests();
  __resetViewerForTests();
});

describe('the catalogue has words for every level', () => {
  it.each(SPORT_LEVELS)('level %i in bg and en', (n) => {
    const key = String(n) as keyof typeof p.sports.level;
    expect(p.sports.level[key]).toBeTruthy();
  });
  it('runs from "току-що започвам" to "състезател"', () => {
    expect(p.sports.level['1']).toBe('Току-що започвам');
    expect(p.sports.level['7']).toBe('Състезател');
  });
});

describe('Лични данни', () => {
  it('a new account: no name yet, says so, and asks for one (N01)', () => {
    installFakeFetch(() => ok(me()));
    mount(<PersonalDataSection seed={me()} />);
    expect(screen.getByTestId('profile-name')).toHaveTextContent(p.personal.noName);
    expect(screen.getByTestId('profile-name-prompt')).toHaveTextContent(p.personal.prompt);
    // The email is the identity header's (#362), not repeated here.
    expect(screen.queryByText('new@playerz.test')).not.toBeInTheDocument();
  });

  it('sets the name: PATCH /api/v1/me with the trimmed name, shown at once, then the hook runs', async () => {
    const held = deferred<FakeAnswer>();
    const onNameSaved = jest.fn();
    const calls = installFakeFetch((c) => (c.method === 'PATCH' ? held.promise : ok(me())));
    mount(<PersonalDataSection seed={me()} onNameSaved={onNameSaved} />);

    fireEvent.click(screen.getByRole('button', { name: p.personal.add }));
    const input = await screen.findByLabelText(p.personal.name);
    fireEvent.change(input, { target: { value: '  Иван   Петров ' } });
    fireEvent.click(screen.getByRole('button', { name: p.personal.save }));

    await waitFor(() =>
      expect(screen.getByTestId('profile-name')).toHaveTextContent('Иван Петров'),
    );
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe('/api/v1/me');
    expect(patch.body).toEqual({ name: 'Иван Петров' });
    expect(patch.headers['x-playerz-viewer']).toBe('usr_player');
    expect(screen.queryByTestId('profile-name-prompt')).not.toBeInTheDocument();

    await act(async () => {
      held.resolve(ok(me({ name: 'Иван Петров' })));
      await tick();
    });
    await waitFor(() => expect(onNameSaved).toHaveBeenCalledTimes(1));
  });

  it('too short is caught before sending anything', async () => {
    const calls = installFakeFetch(() => ok(me()));
    mount(<PersonalDataSection seed={me()} />);
    fireEvent.click(screen.getByRole('button', { name: p.personal.add }));
    fireEvent.change(await screen.findByLabelText(p.personal.name), { target: { value: ' И ' } });
    fireEvent.click(screen.getByRole('button', { name: p.personal.save }));

    expect(await screen.findByText(/поне 2 знака/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('a name the server refuses rolls back, and the sheet comes back with why', async () => {
    installFakeFetch((c) =>
      c.method === 'PATCH'
        ? {
            status: 400,
            body: { error: { code: 'BAD_REQUEST', message: 'x', details: { field: 'name' } } },
          }
        : ok(me({ name: 'Старо' })),
    );
    mount(<PersonalDataSection seed={me({ name: 'Старо' })} />);
    fireEvent.click(screen.getByRole('button', { name: p.personal.edit }));
    fireEvent.change(await screen.findByLabelText(p.personal.name), {
      target: { value: 'Иван <3' },
    });
    fireEvent.click(screen.getByRole('button', { name: p.personal.save }));

    expect(await screen.findByText(p.personal.error.INVALID)).toBeInTheDocument();
    expect(screen.getByLabelText(p.personal.name)).toHaveValue('Иван <3');
    expect(screen.getByTestId('profile-name')).toHaveTextContent('Старо');
  });

  it('nameErrorKey', () => {
    const e = (code: string, field?: string) =>
      new ApiClientError({
        status: 400,
        code,
        message: code,
        details: field ? { field } : undefined,
      });
    expect(nameErrorKey(e('BAD_REQUEST', 'name'))).toBe('INVALID');
    expect(nameErrorKey(e('BAD_REQUEST', 'sports'))).toBe('FAILED');
    expect(nameErrorKey(new Error('offline'))).toBe('FAILED');
  });
});

describe('Спортове и ниво', () => {
  it('none yet: says so, and offers to pick', () => {
    installFakeFetch(() => ok(me()));
    mount(<SportLevelsSection seed={me()} />);
    expect(screen.getByText(p.sports.none)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: p.sports.pick })).toBeInTheDocument();
  });

  it('lists each sport with its level in a number and in words', () => {
    const seed = me({ sports: [{ sport: 'PADEL', level: 4 }] });
    installFakeFetch(() => ok(seed));
    mount(<SportLevelsSection seed={seed} />);
    const row = screen.getByTestId('profile-sport-PADEL');
    expect(row).toHaveTextContent('Падел');
    expect(row).toHaveTextContent('Ниво 4');
    expect(row).toHaveTextContent(p.sports.level['4']);
  });

  it('pick a sport, set its level, see what it means, save: the whole list is PATCHed', async () => {
    const seed = me({ sports: [{ sport: 'TENNIS', level: 2 }] });
    const calls = installFakeFetch((c) =>
      c.method === 'PATCH'
        ? ok(
            me({
              sports: [
                { sport: 'TENNIS', level: 2 },
                { sport: 'PADEL', level: 6 },
              ],
            }),
          )
        : ok(seed),
    );
    mount(<SportLevelsSection seed={seed} />);

    fireEvent.click(screen.getByRole('button', { name: p.sports.edit }));
    const padel = await screen.findByTestId('profile-sport-pick-PADEL');
    fireEvent.click(within(padel).getByRole('checkbox'));
    // A newly ticked sport starts in the middle, and says what that means.
    expect(within(padel).getByRole('radio', { name: '3' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(padel).getByRole('radio', { name: '6' }));
    expect(screen.getByTestId('profile-sport-pick-PADEL-meaning')).toHaveTextContent(
      p.sports.level['6'],
    );
    fireEvent.click(screen.getByRole('button', { name: p.sports.save }));

    await waitFor(() => expect(screen.getByTestId('profile-sport-PADEL')).toBeInTheDocument());
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.body).toEqual({
      sports: [
        { sport: 'TENNIS', level: 2 },
        { sport: 'PADEL', level: 6 },
      ],
    });
  });

  it('unticking removes the sport from what is sent', async () => {
    const seed = me({ sports: [{ sport: 'TENNIS', level: 2 }] });
    const calls = installFakeFetch((c) => (c.method === 'PATCH' ? ok(me()) : ok(seed)));
    mount(<SportLevelsSection seed={seed} />);
    fireEvent.click(screen.getByRole('button', { name: p.sports.edit }));
    fireEvent.click(
      within(await screen.findByTestId('profile-sport-pick-TENNIS')).getByRole('checkbox'),
    );
    fireEvent.click(screen.getByRole('button', { name: p.sports.save }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ sports: [] });
  });

  it('a failed save puts the old list back and says so', async () => {
    const seed = me({ sports: [{ sport: 'TENNIS', level: 2 }] });
    installFakeFetch((c) => (c.method === 'PATCH' ? fail(500, 'INTERNAL') : ok(seed)));
    mount(<SportLevelsSection seed={seed} />);
    fireEvent.click(screen.getByRole('button', { name: p.sports.edit }));
    fireEvent.click(
      within(await screen.findByTestId('profile-sport-pick-TENNIS')).getByRole('checkbox'),
    );
    fireEvent.click(screen.getByRole('button', { name: p.sports.save }));

    expect(await screen.findByTestId('profile-sports-failed')).toHaveTextContent(p.sports.failed);
    expect(screen.getByTestId('profile-sport-TENNIS')).toBeInTheDocument();
  });

  it('offers every sport in the catalogue, each with levels 1 to 7', async () => {
    installFakeFetch(() => ok(me()));
    mount(<SportLevelsSection seed={me()} />);
    fireEvent.click(screen.getByRole('button', { name: p.sports.pick }));
    for (const s of PROFILE_SPORTS) {
      expect(await screen.findByTestId(`profile-sport-pick-${s}`)).toBeInTheDocument();
    }
    fireEvent.click(within(screen.getByTestId('profile-sport-pick-CHESS')).getByRole('checkbox'));
    expect(
      within(screen.getByTestId('profile-sport-pick-CHESS'))
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  });

  it('picksToSports keeps the catalogue order', () => {
    expect(picksToSports({ PADEL: 6, TENNIS: 1 })).toEqual([
      { sport: 'TENNIS', level: 1 },
      { sport: 'PADEL', level: 6 },
    ]);
  });

  it('offers squash with its 1–7 level, and no karting (P51)', async () => {
    // Karting is booked as a whole track and playerz keeps no lap times, so a
    // self-declared level would seed nothing: the sheet does not offer it, as
    // `PATCH /me` does not accept it.
    const calls = installFakeFetch((c) =>
      c.method === 'PATCH' ? ok(me({ sports: [{ sport: 'SQUASH', level: 5 }] })) : ok(me()),
    );
    mount(<SportLevelsSection seed={me()} />);
    fireEvent.click(screen.getByRole('button', { name: p.sports.pick }));

    const squash = await screen.findByTestId('profile-sport-pick-SQUASH');
    expect(squash).toHaveTextContent('Скуош');
    expect(screen.queryByTestId('profile-sport-pick-KARTING')).toBeNull();
    expect(screen.getByRole('dialog')).not.toHaveTextContent(messages.sports.KARTING);

    fireEvent.click(within(squash).getByRole('checkbox'));
    expect(
      within(squash)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    fireEvent.click(within(squash).getByRole('radio', { name: '5' }));
    fireEvent.click(screen.getByRole('button', { name: p.sports.save }));

    await waitFor(() =>
      expect(screen.getByTestId('profile-sport-SQUASH')).toHaveTextContent('Скуош'),
    );
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      sports: [{ sport: 'SQUASH', level: 5 }],
    });
  });
});
