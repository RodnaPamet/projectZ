import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CoachesBoard, type ClubCoachRow } from '@/app/(app)/t/[slug]/admin/coaches/CoachesBoard';
import { TooltipProvider } from '@/components/ui/tooltip';

import { messages, withIntl } from '../helpers/intl';

/**
 * «Треньори» in the club admin (#546), against the real Bulgarian catalogue,
 * with the server actions stubbed: what the club is shown about a coach, and
 * what each button asks the server to do.
 */

const answer = jest.fn();
const endLink = jest.fn();
const invite = jest.fn();
jest.mock('@/app/(app)/t/[slug]/admin/coaches/actions', () => ({
  answerCoachRequestAction: (...a: unknown[]) => answer(...a),
  endCoachLinkAction: (...a: unknown[]) => endLink(...a),
  inviteCoachAction: (...a: unknown[]) => invite(...a),
}));

const t = (messages as unknown as { admin: { coaches: unknown } }).admin.coaches as {
  notApproved: string;
  notSet: string;
  missing: string;
  requests: { none: string };
  active: { none: string };
  action: Record<string, string>;
  invite: Record<string, string>;
  error: Record<string, string>;
};

const coach = (over: Partial<ClubCoachRow> = {}): ClubCoachRow => ({
  id: 'l1',
  status: 'ACTIVE',
  venueName: 'Алфа Кортове',
  name: 'Иван Петров',
  approved: true,
  bio: 'Треньор по тенис от 2010 г.',
  qualifications: 'Лиценз ББФТ',
  sports: [
    { sport: 'TENNIS', levelMin: 1, levelMax: 5 },
    { sport: 'PADEL', levelMin: 4, levelMax: 4 },
  ],
  hourlyRateCents: 4000,
  groupRateCents: 6000,
  currency: 'EUR',
  lessonMinutes: [60, 90],
  cancelCutoffHours: 12,
  hours: [
    { dayOfWeek: 0, open: '10:00', close: '14:00' },
    { dayOfWeek: 1, open: '09:00', close: '12:00' },
    { dayOfWeek: 1, open: '17:00', close: '20:00' },
  ],
  missing: [],
  ...over,
});

const mount = (coaches: ClubCoachRow[]) =>
  render(
    withIntl(
      <TooltipProvider>
        <CoachesBoard slug="alfa" coaches={coaches} />
      </TooltipProvider>,
    ),
  );

beforeEach(() => {
  answer.mockReset().mockResolvedValue({ ok: true });
  endLink.mockReset().mockResolvedValue({ ok: true });
  invite.mockReset().mockResolvedValue({ ok: true });
});

describe('what the club is shown', () => {
  it('with nobody yet: no requests, and how coaches come to be here', () => {
    mount([]);
    expect(screen.getByTestId('club-coach-requests')).toHaveTextContent(t.requests.none);
    expect(screen.getByTestId('club-coaches-active')).toHaveTextContent(t.active.none);
  });

  it('a coach teaching here: the card the platform approved, and the terms the coach set', () => {
    mount([coach()]);
    const card = within(screen.getByTestId('club-coaches-active')).getByTestId('club-coach-card');
    expect(card).toHaveTextContent('Иван Петров');
    expect(card).toHaveTextContent('Алфа Кортове');
    expect(card).toHaveTextContent('Тенис: нива 1–5 · Падел: ниво 4');
    expect(card).toHaveTextContent('Треньор по тенис от 2010 г.');
    expect(within(card).getByTestId('club-coach-rates')).toHaveTextContent(
      '40,00 € на час; за група 60,00 € на час',
    );
    expect(card).toHaveTextContent('60, 90 мин; отказ до 12 ч преди урока');
    // The week is read Monday first, with Sunday last.
    expect(within(card).getByTestId('club-coach-hours')).toHaveTextContent(
      'Пн 09:00–12:00, 17:00–20:00 · Нд 10:00–14:00',
    );
    expect(within(card).queryByTestId('club-coach-missing')).toBeNull();
    // The terms are the coach's: shown, with nothing here to change them.
    expect(within(card).queryByRole('textbox')).toBeNull();
    expect(within(card).getByTestId('club-coach-end')).toBeEnabled();
  });

  it('a coach who has set nothing yet reads as not set, with a note that lessons cannot be booked', () => {
    mount([
      coach({
        hourlyRateCents: null,
        groupRateCents: null,
        lessonMinutes: [],
        hours: [],
        missing: ['rate', 'lengths', 'hours'],
      }),
    ]);
    const card = screen.getByTestId('club-coach-card');
    expect(within(card).getByTestId('club-coach-rates')).toHaveTextContent(t.notSet);
    expect(within(card).getByTestId('club-coach-hours')).toHaveTextContent(t.notSet);
    expect(within(card).getByTestId('club-coach-missing')).toHaveTextContent(t.missing);
  });

  it('no group rate: only the hourly one is said', () => {
    mount([coach({ groupRateCents: null })]);
    expect(screen.getByTestId('club-coach-rates')).toHaveTextContent('40,00 € на час');
    expect(screen.getByTestId('club-coach-rates')).not.toHaveTextContent('група');
  });

  it('an invited coach the platform has not approved: a name and a note, no text of theirs', () => {
    mount([coach({ approved: false, bio: null, qualifications: null, sports: [] })]);
    const card = screen.getByTestId('club-coach-card');
    expect(card).toHaveTextContent('Иван Петров');
    expect(card).toHaveTextContent(t.notApproved);
    expect(card).not.toHaveTextContent('Преподава');
    expect(card).not.toHaveTextContent('Представяне');
  });
});

describe('what each button asks for', () => {
  const REQUEST = coach({
    id: 'r1',
    status: 'REQUESTED',
    name: 'Мария Илиева',
    hourlyRateCents: null,
    lessonMinutes: [],
    hours: [],
  });

  it('a request shows the card without terms, and is accepted with one call', async () => {
    mount([REQUEST, coach()]);
    const card = within(screen.getByTestId('club-coach-requests')).getByTestId('club-coach-card');
    expect(card).toHaveTextContent('Мария Илиева');
    // Nothing about price or hours on a request: there are none to have.
    expect(within(card).queryByTestId('club-coach-rates')).toBeNull();
    await userEvent.click(within(card).getByTestId('club-coach-accept'));
    await waitFor(() => expect(answer).toHaveBeenCalledWith('alfa', 'r1', true));
    expect(endLink).not.toHaveBeenCalled();
  });

  it('declining says no with one call', async () => {
    mount([REQUEST]);
    await userEvent.click(screen.getByTestId('club-coach-decline'));
    await waitFor(() => expect(answer).toHaveBeenCalledWith('alfa', 'r1', false));
  });

  it('a refusal is said on the card it is about', async () => {
    answer.mockResolvedValue({ ok: false, error: 'SUSPENDED' });
    mount([REQUEST, coach()]);
    await userEvent.click(screen.getByTestId('club-coach-accept'));
    const card = within(screen.getByTestId('club-coach-requests')).getByTestId('club-coach-card');
    expect(await within(card).findByRole('alert')).toHaveTextContent(t.error.SUSPENDED!);
    expect(
      within(
        within(screen.getByTestId('club-coaches-active')).getByTestId('club-coach-card'),
      ).queryByRole('alert'),
    ).toBeNull();
  });

  it('ending a coach asks first, naming them and the venue, and then sends one call', async () => {
    mount([coach()]);
    await userEvent.click(screen.getByTestId('club-coach-end'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Да прекратим ли Иван Петров в Алфа Кортове?');
    expect(endLink).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: t.action.end! }));
    await waitFor(() => expect(endLink).toHaveBeenCalledWith('alfa', 'l1'));
  });
});

describe('inviting by email', () => {
  it('sends the address to the action and says it went', async () => {
    mount([]);
    const form = screen.getByTestId('club-coach-invite');
    await userEvent.type(within(form).getByLabelText(t.invite.label!), 'coach@example.bg');
    await userEvent.click(within(form).getByRole('button', { name: t.invite.send! }));
    expect(await within(form).findByText(t.invite.sent!)).toBeVisible();
    expect(invite).toHaveBeenCalledTimes(1);
    const [slug, , data] = invite.mock.calls[0] as [string, unknown, FormData];
    expect(slug).toBe('alfa');
    expect(data.get('email')).toBe('coach@example.bg');
  });

  it('says why when it could not', async () => {
    invite.mockResolvedValue({ ok: false, error: 'ALREADY_INVITED' });
    mount([]);
    const form = screen.getByTestId('club-coach-invite');
    await userEvent.type(within(form).getByLabelText(t.invite.label!), 'coach@example.bg');
    await userEvent.click(within(form).getByRole('button', { name: t.invite.send! }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(t.error.ALREADY_INVITED!);
  });
});
