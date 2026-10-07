import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';

/**
 * Resolve a server component tree for a jsdom render.
 *
 * A page that composes ASYNC server components (`<PlayersSection />` awaiting
 * `getTranslations`) cannot be handed to the client renderer as is: React's
 * client suspends on an async component and the test sees an empty container.
 * This walks the element tree and calls each async function component with
 * its props, replacing it with what it returned, so what reaches `render` is
 * the tree the server would have streamed. Client components (plain functions)
 * are left for React to render, with their children resolved.
 *
 * Only `children` is walked. A server component passed in another prop would
 * stay unresolved; none of the pages tested this way do that.
 */
export async function resolveServerTree(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map((n) => resolveServerTree(n)));
  if (!isValidElement(node)) return node;

  const el = node as ReactElement<{ children?: ReactNode }>;
  if (typeof el.type === 'function' && el.type.constructor.name === 'AsyncFunction') {
    const rendered = await (el.type as (p: unknown) => Promise<ReactNode>)(el.props);
    return resolveServerTree(rendered);
  }
  if (el.props && 'children' in el.props) {
    return cloneElement(el, { children: await resolveServerTree(el.props.children) });
  }
  return el;
}
