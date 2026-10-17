import bg from '../../../messages/bg.json';
import { CLIENT_NAMESPACES, pickMessages } from '@/lib/i18n/client-messages';

/**
 * pickMessages (#599): the browser's share of the catalogue, by dotted path.
 * Which paths each section needs is i18n-client-messages' business; this is
 * the picking itself.
 */
describe('pickMessages', () => {
  const messages = {
    common: { save: 'Запази', cancel: 'Отказ' },
    admin: {
      calendar: { title: 'Календар', day: { next: 'Напред' } },
      courts: { title: 'Кортове' },
      staff: { title: 'Екип' },
    },
    emails: { subject: 'Тема' },
  };

  it('keeps the subtrees at the paths, nested as they were, and nothing else', () => {
    expect(pickMessages(messages, ['common', 'admin.calendar', 'admin.courts'])).toEqual({
      common: { save: 'Запази', cancel: 'Отказ' },
      admin: {
        calendar: { title: 'Календар', day: { next: 'Напред' } },
        courts: { title: 'Кортове' },
      },
    });
  });

  it('skips a path the catalogue lacks, and one under a path already taken', () => {
    expect(pickMessages(messages, ['admin.nothing', 'admin', 'admin.calendar'])).toEqual({
      admin: messages.admin,
    });
  });

  it('never writes to the catalogue it picks from', () => {
    const before = JSON.stringify(messages);
    const picked = pickMessages(messages, ['admin.calendar', 'admin.courts']) as Record<
      string,
      Record<string, unknown>
    >;
    picked.admin!.extra = 'x';
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("sends the club admin far less than the whole catalogue (the diary's payload, #402)", () => {
    const size = (o: unknown) => JSON.stringify(o).length;
    const admin = size(pickMessages(bg, CLIENT_NAMESPACES.clubAdmin));
    expect(admin).toBeLessThan(size(bg) / 2);
    expect(admin).toBeGreaterThan(0);
  });
});
