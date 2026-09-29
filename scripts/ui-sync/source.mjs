/**
 * Just enough lexing to read import statements without being fooled by prose.
 * Pure (no node: imports at all), so the jest guardrails can load it too.
 */

/**
 * Comments removed, strings and template literals kept, newlines preserved so
 * line numbers still hold. A string ends at a newline even when unterminated,
 * which bounds the damage a regex literal such as /["']/ can do to one line.
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  let state = 'code';
  const templateDepth = [];
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') {
        state = 'line';
        i += 2;
        continue;
      }
      if (c === '/' && d === '*') {
        state = 'block';
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') state = c;
      else if (c === '}' && templateDepth.length && templateDepth.at(-1) === 0) {
        templateDepth.pop();
        state = '`';
      } else if (c === '{' && templateDepth.length) templateDepth[templateDepth.length - 1]++;
      else if (c === '}' && templateDepth.length) templateDepth[templateDepth.length - 1]--;
      out += c;
      i++;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += c;
      }
      i++;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') {
        state = 'code';
        i += 2;
        continue;
      }
      if (c === '\n') out += c;
      i++;
      continue;
    }
    // Inside a string or a template literal.
    out += c;
    if (c === '\\') {
      out += d ?? '';
      i += 2;
      continue;
    }
    if (state === '`' && c === '$' && d === '{') {
      out += d;
      i += 2;
      templateDepth.push(0);
      state = 'code';
      continue;
    }
    if (c === state || (c === '\n' && state !== '`')) state = 'code';
    i++;
  }
  return out;
}

/** Every module a file imports, re-exports, dynamically imports or requires. */
export function importSpecifiers(text) {
  const src = stripComments(text);
  const specs = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[^'";]*?\bfrom\s*(['"])([^'"\n]+)\1/g,
    /\bimport\s*(['"])([^'"\n]+)\1/g,
    /\b(?:import|require)\s*\(\s*(['"`])([^'"`\n$]+)\1\s*\)/g,
  ];
  for (const re of patterns) for (const m of src.matchAll(re)) specs.add(m[2]);
  return [...specs];
}
