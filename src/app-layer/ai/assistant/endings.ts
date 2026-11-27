/**
 * Why the assistant refused, and why it stopped early (agri-saas
 * `refusal-codes.ts` + `endings.ts`).
 *
 * A REFUSAL means no answer and no fault: nothing to answer from, or the
 * answer was caught on the way out. A HALT means the answer above is real and
 * INCOMPLETE, or (the two provider codes) that the model could not be used at
 * all. Collapsing them would tell a person "I cannot answer that" when the
 * truth is "that is as far as I got", and they would retry and pay again.
 *
 * `code` is for branching; `message` is the sentence, already in the person's
 * language (bg or en, from their account), so the app needs no catalogue.
 */
import type { AssistantLocale } from './prompt';

export const REFUSAL_CODES = [
  'ASSISTANT_NO_GROUNDING',
  'ASSISTANT_EGRESS_BLOCKED',
  'ASSISTANT_DECLINED',
] as const;

export const HALT_CODES = [
  'ASSISTANT_TOOL_BUDGET',
  'ASSISTANT_TIME_BUDGET',
  'ASSISTANT_SPEND_CEILING',
  'ASSISTANT_PROVIDER_UNAVAILABLE',
  'ASSISTANT_REQUEST_REJECTED',
  'ASSISTANT_TRUNCATED_RESULT',
  'ASSISTANT_PARTIAL_DATA',
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];
export type HaltCode = (typeof HALT_CODES)[number];

export function isHaltCode(code: string): code is HaltCode {
  return (HALT_CODES as readonly string[]).includes(code);
}

/** Every code, in both languages. A unit test holds that none is missing. */
export const ENDING_MESSAGES: Record<RefusalCode | HaltCode, Record<AssistantLocale, string>> = {
  ASSISTANT_NO_GROUNDING: {
    bg: 'Нямам отговор на това. Опитай да питаш по друг начин.',
    en: 'I have no answer to that. Try asking another way.',
  },
  ASSISTANT_EGRESS_BLOCKED: {
    bg: 'Спрях отговора, защото изглеждаше, че съдържа парола или ключ. Нищо не е изпратено.',
    en: 'I stopped that answer because it looked like it held a password or a key. Nothing was sent.',
  },
  ASSISTANT_DECLINED: {
    bg: 'Не мога да помогна с това.',
    en: 'I can’t help with that.',
  },
  ASSISTANT_TOOL_BUDGET: {
    bg: 'Отговорът е непълен: стигнах границата на проверките за един въпрос.',
    en: 'The answer above is incomplete: I reached the limit of look-ups for one question.',
  },
  ASSISTANT_TIME_BUDGET: {
    bg: 'Отговорът е непълен: търсенето отне твърде дълго и спрях, за да не чакаш.',
    en: 'The answer above is incomplete: it was taking too long, so I stopped rather than keep you waiting.',
  },
  ASSISTANT_SPEND_CEILING: {
    bg: 'За днес стигна лимита на асистента. Опитай пак утре.',
    en: 'You have reached today’s assistant limit. Try again tomorrow.',
  },
  ASSISTANT_PROVIDER_UNAVAILABLE: {
    bg: 'Асистентът не отговаря в момента. Нищо не е запазено. Опитай пак след малко.',
    en: 'The assistant is not answering right now. Nothing was saved. Try again in a moment.',
  },
  ASSISTANT_REQUEST_REJECTED: {
    bg: 'Асистентът отказа заявката. Грешката е при нас, не при теб. Нищо не е запазено.',
    en: 'The assistant refused the request. The fault is ours, not yours. Nothing was saved.',
  },
  ASSISTANT_TRUNCATED_RESULT: {
    bg: 'Отговорът ползва само част от данните: един от списъците беше твърде дълъг.',
    en: 'The answer above uses part of the data: one of the lists was too long to use whole.',
  },
  ASSISTANT_PARTIAL_DATA: {
    bg: 'Отговорът е непълен: част от данните не можаха да бъдат прочетени.',
    en: 'The answer above is incomplete: some of the data could not be read.',
  },
};

export function endingEvent(
  code: RefusalCode | HaltCode,
  locale: AssistantLocale,
):
  | { type: 'halt'; code: HaltCode; message: string }
  | { type: 'refusal'; code: RefusalCode; message: string } {
  const message = ENDING_MESSAGES[code][locale];
  return isHaltCode(code)
    ? { type: 'halt', code, message }
    : { type: 'refusal', code: code as RefusalCode, message };
}
