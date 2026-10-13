import '@testing-library/jest-dom';
import { cleanup, configure } from '@testing-library/react';

configure({ asyncUtilTimeout: 3000 });

// Several primitives (Modal, PageHeader, …) call `useRouter()`. Outside a
// Next app there is no router context, and next/navigation throws
// "invariant expected app router to be mounted". Provide a stub so the
// primitives can be rendered in isolation.
jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    refresh: jest.fn(),
    prefetch: jest.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

// ═══ A RENDERED TEST NEVER LOADS THE DATABASE CLIENT (#532) ═══
//
// A client component may import a server action, and through it the use
// case, Prisma and `pg`. In the browser that import is a reference; in a
// jsdom test it is the real module. On Node 24 (CI) `pg` cannot even be
// loaded under jsdom ("TextEncoder is not defined"), while on a newer Node it
// loads quietly, so a suite passed on a laptop and failed to start in CI.
//
// So it fails the same way everywhere, and says what to do. A rendered test
// that needs a component which imports an action mocks the action's module
// (or whatever sits between the component and the database).
jest.mock('@/lib/db/prisma', () => {
  throw new Error(
    'A rendered (jsdom) test loaded the database client (src/lib/db/prisma.ts).\n\n' +
      'A component under test imports, through a server action or a helper, code that\n' +
      'opens the database. Mock that module in the test (jest.mock of the action or\n' +
      'the use case), or import the helper from a module that does not reach it.\n' +
      'On CI this is where "ReferenceError: TextEncoder is not defined" came from (#532).',
  );
});

// jsdom implements neither of these; Radix and the virtualized table both
// probe for them on mount.
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    }),
  });
}

if (!global.ResizeObserver) {
  // The constructor MUST declare its callback parameter. An anonymous class
  // with a default (zero-arg) constructor makes CodeQL resolve every
  // `new ResizeObserver(cb)` in src/ to *this* stub and report the callback
  // as a "superfluous trailing argument" — three false-positive alerts on
  // production files. Test scaffolding must not redefine the shape of a
  // real DOM API.
  global.ResizeObserver = class implements ResizeObserver {
    constructor(_callback: ResizeObserverCallback) {}
    observe(_target: Element, _options?: ResizeObserverOptions) {}
    unobserve(_target: Element) {}
    disconnect() {}
  };
}

// jsdom has no Pointer Capture API. `vaul` (the drawer behind Modal /
// Sheet / ConfirmDialog) calls setPointerCapture on press, which throws
// "not a function" and swallows the click before onConfirm ever fires.
for (const method of ['setPointerCapture', 'releasePointerCapture'] as const) {
  if (!Element.prototype[method]) {
    Element.prototype[method] = function noop() {};
  }
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = function hasPointerCapture() {
    return false;
  };
}

// Radix's Presence/positioning code paths call this too.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function noop() {};
}

// vaul's getTranslate() does `style.transform || style.webkitTransform ||
// style.mozTransform` then calls `.match()` on the result. jsdom reports
// transform as '' and the vendor-prefixed variants as undefined, so the
// chain yields undefined and the drawer throws on pointer-up — swallowing
// the click. Report a real 'none' so the parse path is exercised.
const realGetComputedStyle = window.getComputedStyle.bind(window);
window.getComputedStyle = ((el: Element, pseudo?: string | null) => {
  const style = realGetComputedStyle(el, pseudo ?? undefined);
  if (!style.transform) {
    Object.defineProperty(style, 'transform', { value: 'none', configurable: true });
  }
  return style;
}) as typeof window.getComputedStyle;

afterEach(() => {
  cleanup();
});
