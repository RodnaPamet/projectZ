import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE SPEC STAYS GENERATABLE FOR THE iOS CLIENT (playerz-ios).
 *
 * swift-openapi-generator refuses the whole document when an integer enum
 * lists `null`: "Disallowed value for an integer enum … <null>". Valid OpenAPI,
 * but the client stops building, and nothing on this side noticed: three of
 * them (a draw match's `proposal.side` and `mySide`, a walkover's
 * `winnerSide`) went out in trains 29–31 before the app's spec was refreshed.
 * A nullable 0-or-1 is `type: ["integer", "null"]` with `minimum`/`maximum`.
 */
describe('the spec is generatable for the iOS client', () => {
  it('no integer enum lists null', () => {
    const spec = JSON.parse(readFileSync(join(process.cwd(), 'openapi/playerz-v1.json'), 'utf8'));
    const found: string[] = [];
    const walk = (node: unknown, path: string[]) => {
      if (Array.isArray(node)) {
        node.forEach((v, i) => walk(v, [...path, String(i)]));
        return;
      }
      if (!node || typeof node !== 'object') return;
      const n = node as Record<string, unknown>;
      const types = Array.isArray(n.type) ? n.type : [n.type];
      if (Array.isArray(n.enum) && n.enum.includes(null) && types.includes('integer')) {
        found.push(path.join('/'));
      }
      for (const [k, v] of Object.entries(n)) walk(v, [...path, k]);
    };
    walk(spec, []);
    expect(found).toEqual([]);
  });
});
