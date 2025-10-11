const URL_PATTERN =
  /(?:https?:\/\/[^\s]+|(?:https?:\/\/)?(?:[\w.-]+\.)?2gis\.[^\/\s]+\/\S+)/giu;
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

const ensureAbsoluteUrl = (value: string): string =>
  /^\w[\w+.-]*:\/\//u.test(value) ? value : `https://${value}`;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

interface UrlCandidate {
  raw: string;
  cleaned: string;
  normalized: string;
}

const collectUrlCandidates = (value: string): UrlCandidate[] => {
  if (!value) {
    return [];
  }

  const candidates: UrlCandidate[] = [];
  for (const match of value.matchAll(URL_PATTERN)) {
    const raw = match[0];
    const cleaned = stripTrailingPunctuation(raw);
    if (!isMeaningfulUrl(cleaned)) {
      continue;
    }

    const normalized = ensureAbsoluteUrl(cleaned);
    candidates.push({ raw, cleaned, normalized });
  }

  return candidates;
};

/**
 * Extracts the most relevant URL from a free-form text value.
 * Prefers 2ГИС links when present and removes trailing punctuation.
 */
export const extractPreferredUrl = (value: string): string | null => {
  const candidates = collectUrlCandidates(value);
  if (candidates.length === 0) {
    return null;
  }

  for (const candidate of candidates) {
    try {
      const hostname = new URL(candidate.normalized).hostname;
      if (/2gis\./iu.test(hostname)) {
        return candidate.normalized;
      }
    } catch {
      // Ignore parsing errors and try the next candidate.
    }
  }

  return candidates[0]?.normalized ?? null;
};

export const removeUrls = (value: string): string => {
  if (!value) {
    return '';
  }

  let result = value;
  const seen = new Set<string>();

  for (const candidate of collectUrlCandidates(value)) {
    const variations = [candidate.raw];
    if (candidate.cleaned !== candidate.raw) {
      variations.push(candidate.cleaned);
    }

    for (const variation of variations) {
      if (!variation || seen.has(variation)) {
        continue;
      }

      seen.add(variation);
      const pattern = new RegExp(escapeRegExp(variation), 'giu');
      result = result.replace(pattern, ' ');
    }
  }

  return result.replace(/\s+/gu, ' ').trim();
};

export default extractPreferredUrl;
