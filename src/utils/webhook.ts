export const removeTrailingSlashes = (value: string): string => value.replace(/\/+$/, '');

export const buildWebhookConfig = (
  domain: string,
  secret: string,
): { path: string; url: string } => {
  const trimmedDomain = removeTrailingSlashes(domain);
  const path = `/bot/${secret}`;

  return {
    path,
    url: `${trimmedDomain}${path}`,
  };
};

