import { execSync } from 'node:child_process';

let cachedRevision: string | null = null;

const envKeys = [
  'GIT_COMMIT',
  'RAILWAY_GIT_COMMIT_SHA',
  'VERCEL_GIT_COMMIT_SHA',
  'COMMIT_SHA',
  'SOURCE_VERSION',
];

export const getGitRevision = (): string => {
  if (cachedRevision) {
    return cachedRevision;
  }

  for (const key of envKeys) {
    const value = process.env[key];
    if (value && value.trim()) {
      cachedRevision = value.trim();
      return cachedRevision;
    }
  }

  try {
    const output = execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();

    if (output) {
      cachedRevision = output;
      return cachedRevision;
    }
  } catch {
    // ignore missing git binary or repository
  }

  cachedRevision = 'unknown';
  return cachedRevision;
};

export const __testing__ = {
  resetCache() {
    cachedRevision = null;
  },
};
