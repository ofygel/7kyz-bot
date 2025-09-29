const URL_PATTERN = /https?:\/\/[^\s]+/giu;
const TRAILING_PUNCTUATION_RE = /[)\]\}>,.!?:;'"«»„“”›‹…]+$/u;

const stripTrailingPunctuation = (value: string): string => {
  let result = value;

  while (true) {
    const next = result.replace(TRAILING_PUNCTUATION_RE, '');
    if (next === result) {
      break;
    }

    result = next;
  }

  return result;
};

const isMeaningfulUrl = (value: string): boolean => {
  if (!value) {
    return false;
  }

  const lower = value.toLowerCase();
  return !(lower === 'http://' || lower === 'https://');
};

/**
 * Extracts the most relevant URL from a free-form text value.
 * Prefers 2ГИС links when present and removes trailing punctuation.
 */
export const extractPreferredUrl = (value: string): string | null => {
  if (!value) {
    return null;
  }

  const matches: string[] = [];
  for (const match of value.matchAll(URL_PATTERN)) {
    const cleaned = stripTrailingPunctuation(match[0]);
    if (!isMeaningfulUrl(cleaned)) {
      continue;
    }

    matches.push(cleaned);
  }

  if (matches.length === 0) {
    return null;
  }

  for (const candidate of matches) {
    try {
      const hostname = new URL(candidate).hostname;
      if (/2gis\./iu.test(hostname)) {
        return candidate;
      }
    } catch {
      // Ignore parsing errors and try the next candidate.
    }
  }

  return matches[0];
};

export default extractPreferredUrl;
