declare module 'bullmq' {
  export interface JobsOptions {
    jobId?: string;
    delay?: number;
    removeOnComplete?: boolean | number;
    removeOnFail?: boolean | number;
  }

  export class Queue<T = unknown> {
    constructor(name: string, options?: unknown);
    add(name: string, data: T, options?: JobsOptions): Promise<void>;
    remove(jobId: string): Promise<void>;
    close(): Promise<void>;
  }

  export class Worker<T = unknown> {
    constructor(name: string, processor: (...args: any[]) => unknown, options?: unknown);
    on(event: string, handler: (...args: any[]) => void): void;
    close(): Promise<void>;
  }
}
