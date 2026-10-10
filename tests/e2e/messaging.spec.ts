import { expect, signIn, test } from './fixtures';
import { createAccount, destroyPlayer } from './utils/booking-players-journey';

/**
 * Messaging, two-sided (#375), in the spirit of Agrent's
 * `exchange-two-sided.spec.ts`: two players, each in their own browser.
 *
 *   1. Ана finds Борис by name, sees his card, and writes. They have never
 *      played together, so it is a request: one message, then the composer
 *      goes and says why.
 *   2. Борис finds it in «Заявки», accepts, and replies.
 *   3. Ана's conversation, left open, shows the reply WITHOUT a reload: the
 *      screen re-reads every 5 seconds.
 *
 * The pages answer whatever MODULE_MESSAGING says (the flag only hides the
 * links), so this runs against the default server.
 */
test.describe('messaging between two players — desktop', () => {
  test('a request, accepted, and a reply that arrives on its own', async ({ browser }) => {
    const tag = Date.now().toString(36);
    const ana = await createAccount('msg-ana', { name: `Ана Тестова ${tag}`, kind: 'PLAYER' });
    const bob = await createAccount('msg-bob', { name: `Борис Тестов ${tag}`, kind: 'PLAYER' });
    const viewport = { width: 1280, height: 800 };
    const aCtx = await browser.newContext({ viewport, locale: 'bg-BG' });
    const bCtx = await browser.newContext({ viewport, locale: 'bg-BG' });
    try {
      const aPage = await aCtx.newPage();
      const bPage = await bCtx.newPage();
      await signIn(aPage, ana);
      await signIn(bPage, bob);
      // Inside <main>: while a streamed page lands, React keeps a hidden copy
      // of it under <body>, and a locator for the whole page finds both.
      const a = aPage.getByRole('main');
      const b = bPage.getByRole('main');

      // ── 1. Ана: search, card, write ──
      await aPage.goto('/messages/new');
      await a.getByTestId('player-search-input').fill(`Борис Тестов ${tag}`);
      await a.getByTestId('player-search-row').first().click();
      const card = a.getByTestId('player-card');
      await expect(card).toContainText(`Борис Тестов ${tag}`);
      await card.getByTestId('player-card-write').click();
      await expect(aPage).toHaveURL(/\/messages\/c[a-z0-9]+$/);
      await expect(a.getByTestId('conversation-notice-firstIsRequest')).toBeVisible();

      await a.getByTestId('conversation-input').fill('Здравейте! Играете ли падел?');
      await a.getByTestId('conversation-send').click();
      await expect(a.getByTestId('conversation-messages')).toContainText(
        'Здравейте! Играете ли падел?',
      );
      // One message until it is accepted.
      await expect(a.getByTestId('conversation-notice-pending')).toBeVisible({ timeout: 15_000 });
      await expect(a.getByTestId('conversation-composer')).toHaveCount(0);

      // ── 2. Борис: «Заявки», accept, reply ──
      await bPage.goto('/messages?tab=requests');
      const row = b.getByTestId('inbox-row').filter({ hasText: `Ана Тестова ${tag}` });
      await expect(row).toBeVisible();
      await row.click();
      await expect(b.getByTestId('conversation-notice-request')).toBeVisible();
      await b.getByTestId('conversation-accept').click();
      await expect(b.getByTestId('conversation-notice-request')).toHaveCount(0);
      await b.getByTestId('conversation-input').fill('Да, в четвъртък вечер.');
      await b.getByTestId('conversation-send').click();

      // ── 3. Ана sees it without reloading, and may write again ──
      await expect(a.getByTestId('conversation-messages')).toContainText('Да, в четвъртък вечер.', {
        timeout: 15_000,
      });
      await expect(a.getByTestId('conversation-composer')).toBeVisible();
    } finally {
      await aCtx.close();
      await bCtx.close();
      await destroyPlayer(ana.userId);
      await destroyPlayer(bob.userId);
    }
  });
});
