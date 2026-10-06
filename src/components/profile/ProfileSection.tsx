import type { ReactNode } from 'react';

import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';

/**
 * A titled group of rows on /me/profile: the vendored `Heading` over a flat
 * `Card` whose rows the card divides. The same shape as the shell's own
 * sections (#362's `ProfileView`), so the sections #359 adds sit in the page
 * as if they had always been there.
 */
export function ProfileSection({
  title,
  children,
  testId,
}: {
  title: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="gap-tight flex flex-col" data-testid={testId}>
      <Heading level={2} tone="muted" className="text-sm">
        {title}
      </Heading>
      <Card elevation="flat" density="none" className="divide-border-subtle divide-y">
        {children}
      </Card>
    </section>
  );
}

/** One row of a section: at least 56 px, the label left, the value or action right. */
export const PROFILE_ROW = 'flex min-h-14 items-center justify-between gap-3 px-4 py-2';
