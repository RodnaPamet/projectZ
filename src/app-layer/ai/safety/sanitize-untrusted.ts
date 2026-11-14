/**
 * Neutralise instruction-shaped lines in text that reaches the model as DATA
 * (agri-saas `sanitize-untrusted.ts`): the person's question, the replayed
 * conversation, the screen context.
 *
 * Not the defence on its own. The prompt fences every such block and says it
 * is data; this catches the plainest attempts to step out of the fence, in
 * English and in Bulgarian, and a role label spoofed at the start.
 *
 * Run AFTER `sanitizePlainText` (agri-saas #2698): the role check is anchored
 * at the line start, so markup in front of `system:` would hide it from the
 * check and show it to the model.
 */
const INJECTION_LINE_PATTERNS: RegExp[] = [
  /\bignore (?:all )?(?:the )?(?:previous|prior|above|preceding) (?:instructions?|prompts?|rules?)\b/i,
  /\bdisregard (?:all )?(?:the )?(?:previous|prior|above) (?:instructions?|rules?)\b/i,
  /\bforget (?:everything|all) (?:above|before|previous)\b/i,
  /\boverride (?:the )?(?:system|previous) (?:prompt|instructions?)\b/i,
  /\byou are now\b/i,
  /\bnew instructions?:/i,
  /(?:^|\s)(?:игнорирай|забрави|пренебрегни)\s+(?:всички\s+)?(?:предишни(?:те)?|горни(?:те)?)\s+(?:инструкции|указания|правила)/i,
  /(?:^|\s)нови\s+инструкции\s*:/i,
];

const ROLE_SPOOF_PREFIX = /^(system|assistant|developer|tool|система|асистент)\s*:/i;

const NEUTRALISED = '[removed: untrusted directive]';

export function sanitizeUntrusted(text: string): string {
  if (!text) return '';
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim().length > 0);
  return lines
    .map((line, i) => {
      if (INJECTION_LINE_PATTERNS.some((p) => p.test(line))) return NEUTRALISED;
      if (i !== first) return line;
      const rest = line.trimStart();
      return ROLE_SPOOF_PREFIX.test(rest) ? rest.replace(ROLE_SPOOF_PREFIX, '[role] ') : line;
    })
    .join('\n');
}

/**
 * Break a fence marker the person typed, so a turn cannot close the block it
 * sits in (agri-saas `neutraliseFence`). Broken rather than deleted: deleting
 * would let `<<<<<<END>>>` reassemble.
 */
export function neutraliseFence(content: string): string {
  return content.replace(/<{2,}/g, '<\u200b<').replace(/>{2,}/g, '>\u200b>');
}
