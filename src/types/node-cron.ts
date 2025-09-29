declare module 'node-cron' {
  export interface ScheduledTask {
    start(): void;
    stop(): void;
    destroy(): void;
    getStatus?(): 'scheduled' | 'running' | 'stopped';
  }

  export interface ScheduleOptions {
    scheduled?: boolean;
    timezone?: string;
    recoverMissedExecutions?: boolean;
  }

  export type CronCallback = () => void | Promise<void>;

  export interface CronModule {
    schedule(expression: string, callback: CronCallback, options?: ScheduleOptions): ScheduledTask;
    validate(expression: string): boolean;
  }

  const cron: CronModule;
  export default cron;
}
