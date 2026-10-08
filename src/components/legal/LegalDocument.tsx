import { Fragment, type ReactNode } from 'react';

import { Lexer, type Token, type Tokens } from 'marked';

import { Heading, TextLink } from '@/components/ui/typography';

/**
 * A legal text (#370), rendered on the server from its Markdown.
 *
 * ═══ TOKENS TO ELEMENTS, NEVER HTML ═══
 *
 * `marked` only LEXES here. Each token becomes a React element in the design
 * system's type (the vendored `Heading` and `TextLink`, token colours), so
 * nothing is injected as HTML and nothing reaches the browser but the page.
 * Raw HTML in a text is dropped, not rendered: the lawyer's DOCX converts
 * without it (`pandoc -t gfm-raw_html`, docs/legal-pages.md), and a stray tag
 * should be visible as missing, not run. A link that is not http(s), mailto,
 * tel, a path or an anchor is shown as its text.
 *
 * The first `# heading` is the page's title (`legalTitle`); everything is
 * shown as written, numbering and all.
 */

const SAFE_HREF = /^(https?:\/\/|mailto:|tel:|\/(?!\/)|#)/i;

/** The text's first `# heading`, as plain text: the page's title. */
export function legalTitle(markdown: string): string | null {
  const first = Lexer.lex(markdown).find((t) => t.type !== 'space');
  return first?.type === 'heading' && (first as Tokens.Heading).depth === 1
    ? (first as Tokens.Heading).text.trim()
    : null;
}

function inline(tokens: Token[] | undefined): ReactNode {
  if (!tokens) return null;
  return tokens.map((t, i) => <Fragment key={i}>{inlineToken(t)}</Fragment>);
}

function inlineToken(token: Token): ReactNode {
  switch (token.type) {
    case 'text': {
      const t = token as Tokens.Text;
      return t.tokens ? inline(t.tokens) : t.text;
    }
    case 'escape':
      return (token as Tokens.Escape).text;
    case 'strong':
      return (
        <strong className="text-content-emphasis font-semibold">
          {inline((token as Tokens.Strong).tokens)}
        </strong>
      );
    case 'em':
      return <em>{inline((token as Tokens.Em).tokens)}</em>;
    case 'del':
      return <del>{inline((token as Tokens.Del).tokens)}</del>;
    case 'codespan':
      return (
        <code className="bg-bg-muted rounded px-1 text-[0.9em]">
          {(token as Tokens.Codespan).text}
        </code>
      );
    case 'br':
      return <br />;
    case 'link': {
      const l = token as Tokens.Link;
      if (!SAFE_HREF.test(l.href)) return inline(l.tokens);
      const external = /^https?:\/\//i.test(l.href);
      return (
        <TextLink
          tone="link"
          href={l.href}
          className="inline underline-offset-2"
          {...(external ? { rel: 'noopener noreferrer' } : {})}
        >
          {inline(l.tokens)}
        </TextLink>
      );
    }
    // Raw HTML, images and anything unknown: dropped (see the header).
    default:
      return null;
  }
}

/**
 * A section's element: the text's own depth, so the outline is the lawyer's;
 * the type scale has two section sizes, so `###` and deeper share the smaller.
 */
const SECTION_TAG = { 2: 'h2', 3: 'h3', 4: 'h4', 5: 'h5', 6: 'h6' } as const;

function block(token: Token, key: number, titleTaken: { done: boolean }): ReactNode {
  switch (token.type) {
    case 'heading': {
      const h = token as Tokens.Heading;
      if (h.depth === 1 && !titleTaken.done) {
        titleTaken.done = true;
        return (
          <Heading key={key} level={1}>
            {inline(h.tokens)}
          </Heading>
        );
      }
      const level = h.depth <= 2 ? 2 : 3;
      const as = SECTION_TAG[Math.min(Math.max(h.depth, 2), 6) as keyof typeof SECTION_TAG];
      return (
        <Heading key={key} level={level} as={as} className="mt-4">
          {inline(h.tokens)}
        </Heading>
      );
    }
    case 'paragraph':
      return (
        <p key={key} className="text-content-default leading-relaxed">
          {inline((token as Tokens.Paragraph).tokens)}
        </p>
      );
    case 'list': {
      const l = token as Tokens.List;
      const items = l.items.map((item, i) => (
        <li key={i} className="pl-1">
          {item.tokens.map((t, j) =>
            // A tight item's text is inline; a loose one holds paragraphs.
            t.type === 'text' ? (
              <Fragment key={j}>{inlineToken(t)}</Fragment>
            ) : (
              block(t, j, titleTaken)
            ),
          )}
        </li>
      ));
      return l.ordered ? (
        <ol
          key={key}
          start={typeof l.start === 'number' ? l.start : undefined}
          className="text-content-default flex list-decimal flex-col gap-1 pl-6 leading-relaxed"
        >
          {items}
        </ol>
      ) : (
        <ul
          key={key}
          className="text-content-default flex list-disc flex-col gap-1 pl-6 leading-relaxed"
        >
          {items}
        </ul>
      );
    }
    case 'blockquote':
      return (
        <blockquote
          key={key}
          className="border-border-default text-content-muted flex flex-col gap-2 border-l-2 pl-4"
        >
          {(token as Tokens.Blockquote).tokens.map((t, i) => block(t, i, titleTaken))}
        </blockquote>
      );
    case 'table': {
      const t = token as Tokens.Table;
      return (
        <div key={key} className="overflow-x-auto">
          <table className="text-content-default w-full border-collapse text-sm">
            <thead>
              <tr>
                {t.header.map((cell, i) => (
                  <th
                    key={i}
                    className="border-border-subtle text-content-emphasis border p-2 text-left font-semibold"
                  >
                    {inline(cell.tokens)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className="border-border-subtle border p-2 align-top">
                      {inline(cell.tokens)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'hr':
      return <hr key={key} className="border-border-subtle" />;
    case 'code':
      return (
        <pre key={key} className="bg-bg-muted overflow-x-auto rounded-md p-3 text-sm">
          <code>{(token as Tokens.Code).text}</code>
        </pre>
      );
    case 'text': {
      // Text at block level (inside a loose list item): a paragraph's worth.
      const tx = token as Tokens.Text;
      return (
        <p key={key} className="text-content-default leading-relaxed">
          {tx.tokens ? inline(tx.tokens) : tx.text}
        </p>
      );
    }
    // Spaces, link definitions, raw HTML: nothing to draw.
    default:
      return null;
  }
}

export function LegalDocument({ markdown }: { markdown: string }) {
  const tokens = Lexer.lex(markdown, { gfm: true });
  const titleTaken = { done: false };
  return (
    <div className="flex flex-col gap-4" data-testid="legal-document">
      {tokens.map((t, i) => block(t, i, titleTaken))}
    </div>
  );
}
