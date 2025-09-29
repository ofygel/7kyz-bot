import { config, logger } from '../config';

export function startBot(): void {
  logger.info(
    {
      environment: config.nodeEnv,
    },
    'Bot entry point initialised',
  );
}
