import { formatInTimeZone } from 'date-fns-tz';

import type { ClubStatement } from '@/app-layer/usecases/club-fees';
import { bpsToPercent, FEE_TIME_ZONE } from '@/lib/billing/club-fee';
import { translateFor } from '@/lib/i18n/server-messages';

/**
 * A club's monthly statement as a CSV file (#372), for the owner to invoice
 * from and for the club to check against.
 *
 * ═══ THE FORMAT, AND WHY ═══
 *
 *   - UTF-8 WITH A BOM. Excel opens a CSV in the system's legacy code page
 *     unless the file starts with U+FEFF; without it "Корт 1" arrives as
 *     "РљРѕСЂС‚ 1". Numbers, LibreOffice and Google Sheets ignore the mark.
 *   - SEMICOLONS. Excel splits a CSV on the list separator of the machine's
 *     regional settings, and in Bulgarian (bg-BG) that is ";", because "," is
 *     the decimal separator. A comma-separated file opens there as one column.
 *     Semicolons open as columns in Bulgarian Excel, and LibreOffice and Google
 *     Sheets detect them.
 *   - DECIMAL COMMAS, no thousands separator: "1234,50". With ";" as the field
 *     separator a comma inside a number is unambiguous, and it is what a
 *     Bulgarian Excel parses as a number.
 *   - Dates as dd.MM.yyyy and times as HH:mm, at the club (Europe/Sofia).
 *   - CRLF line ends (RFC 4180), and Bulgarian headers: the statement is the
 *     basis of a Bulgarian invoice, whatever language the reader's UI is in.
 *
 * ═══ FORMULA INJECTION ═══
 *
 * Venue and court names are typed by clubs. A cell that starts with "=", "+",
 * "-", "@", a tab or a carriage return is run as a formula by Excel and
 * LibreOffice (`=HYPERLINK(…)`, `=cmd|…`), so such a TEXT cell is prefixed
 * with an apostrophe, which spreadsheets treat as "this is text" (OWASP's
 * advice). Numeric cells are written by this file from integers and are not
 * escaped: a reversal's "-12,50" must stay a number.
 */

const SEPARATOR = ';';
const EOL = '\r\n';
const BOM = '﻿';

/** Starts a formula in Excel, LibreOffice or Google Sheets. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** A cell a person typed. Defused, then quoted if it needs to be. */
export function textCell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return quote(safe);
}

/** Quote a cell holding the separator, a quote, a line break or edge spaces. */
function quote(value: string): string {
  return /[";\r\n]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Integer cents as "1234,50" / "-12,05". Integer arithmetic only. */
export function centsCell(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

/** Basis points as a percentage with a decimal comma: 1250 → "12,50". */
export function percentCell(bps: number): string {
  return bpsToPercent(bps).replace('.', ',');
}

/** The file's name: ASCII only, so every browser keeps it. */
export function statementFilename(clubSlug: string, month: string): string {
  const safe = clubSlug.replace(/[^a-z0-9-]/gi, '-').slice(0, 60);
  return `playerz-${safe}-${month}.csv`;
}

/** The CSV text of a statement, BOM first. */
export async function statementCsv(statement: ClubStatement): Promise<string> {
  const t = (key: string, values: Record<string, string> = {}) =>
    translateFor('bg', `billing.csv.${key}`, values);
  const currency = statement.currency;

  const [
    date,
    time,
    venue,
    court,
    kind,
    price,
    rate,
    free,
    fee,
    booking,
    charge,
    reversal,
    yes,
    no,
  ] = await Promise.all([
    t('date'),
    t('time'),
    t('venue'),
    t('court'),
    t('kind'),
    t('price', { currency }),
    t('rate'),
    t('freePeriod'),
    t('fee', { currency }),
    t('booking'),
    t('charge'),
    t('reversal'),
    t('yes'),
    t('no'),
  ]);

  const header = [date, time, venue, court, kind, price, rate, free, fee, booking].map(textCell);

  const rows = statement.lines.map((l) =>
    [
      formatInTimeZone(l.startsAt, FEE_TIME_ZONE, 'dd.MM.yyyy'),
      formatInTimeZone(l.startsAt, FEE_TIME_ZONE, 'HH:mm'),
      textCell(l.venueName),
      textCell(l.courtName),
      textCell(l.kind === 'CHARGE' ? charge : reversal),
      centsCell(l.priceCents),
      percentCell(l.feeBps),
      textCell(l.freePeriod ? yes : no),
      centsCell(l.feeCents),
      textCell(l.bookingId),
    ].join(SEPARATOR),
  );

  return BOM + [header.join(SEPARATOR), ...rows].join(EOL) + EOL;
}
