import pino from 'pino';

import { pinoInstance } from '@/lib/observability/logger';

/**
 * Every line the real base logger writes (and its children, which share its
 * stream), captured at the destination stream after redaction, until
 * `restore()`. The level is opened to `trace` meanwhile, so a debug line that
 * would leak in development is caught too.
 */
export function captureLogs() {
  const stream = (pinoInstance as unknown as Record<symbol, { write(s: string): boolean }>)[
    pino.symbols.streamSym
  ]!;
  const lines: string[] = [];
  const level = pinoInstance.level;
  pinoInstance.level = 'trace';
  const spy = jest.spyOn(stream, 'write').mockImplementation((s: string) => {
    lines.push(s);
    return true;
  });
  return {
    lines,
    restore: () => {
      spy.mockRestore();
      pinoInstance.level = level;
    },
  };
}
