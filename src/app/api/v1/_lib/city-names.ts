import bg from '../../../../../messages/bg.json';
import en from '../../../../../messages/en.json';

import { cityKey, type CityKey } from '@/lib/geo/cities';

/** A city's name in both of the app's languages (#667). */
export interface CityNames {
  bg: string;
  en: string;
}

/**
 * The v1 API has no request language, so a city goes out in both: the
 * catalogue's names for a key of the canonical list, else the text as the
 * club typed it in both slots. One source with the web (`cities.<key>`).
 */
export function cityNames(raw: string, key: CityKey | null = cityKey(raw)): CityNames {
  if (!key) return { bg: raw, en: raw };
  return { bg: bg.cities[key], en: en.cities[key] };
}
