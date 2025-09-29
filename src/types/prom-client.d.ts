declare module 'prom-client' {
  export class Registry {
    constructor();
    setDefaultLabels(labels: Record<string, string>): void;
    metrics(): Promise<string>;
    readonly contentType: string;
  }

  export interface CounterConfiguration<TLabel extends string = string> {
    name: string;
    help: string;
    labelNames?: readonly TLabel[];
    registers?: Registry[];
  }

  export interface HistogramConfiguration<TLabel extends string = string> {
    name: string;
    help: string;
    labelNames?: readonly TLabel[];
    buckets?: number[];
    registers?: Registry[];
  }

  export class Counter<TLabel extends string = string> {
    constructor(configuration: CounterConfiguration<TLabel>);
    inc(labels?: Record<TLabel, string>, value?: number): void;
    reset(): void;
  }

  export interface GaugeConfiguration<TLabel extends string = string> {
    name: string;
    help: string;
    labelNames?: readonly TLabel[];
    registers?: Registry[];
  }

  export class Gauge<TLabel extends string = string> {
    constructor(configuration: GaugeConfiguration<TLabel>);
    inc(labels?: Record<TLabel, string>, value?: number): void;
    dec(labels?: Record<TLabel, string>, value?: number): void;
    set(labels: Record<TLabel, string>, value: number): void;
    set(value: number): void;
    setToCurrentTime(labels?: Record<TLabel, string>): void;
    startTimer(labels?: Record<TLabel, string>): () => number;
    labels(...values: string[]): Gauge<TLabel>;
    labels(labels: Record<TLabel, string>): Gauge<TLabel>;
    reset(): void;
  }

  export class Histogram<TLabel extends string = string> {
    constructor(configuration: HistogramConfiguration<TLabel>);
    startTimer(labels?: Record<TLabel, string>): () => void;
    reset(): void;
  }

  export function collectDefaultMetrics(options: { register?: Registry }): void;
}
