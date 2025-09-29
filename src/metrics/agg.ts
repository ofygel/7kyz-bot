const latencySamples = new Map<string, number[]>();
const flowCounters = new Map<string, { started: number; completed: number }>();

export function sampleLatency(name: string, ms: number): void {
  const bucket = latencySamples.get(name) ?? [];
  bucket.push(ms);
  if (bucket.length > 1000) {
    bucket.shift();
  }
  latencySamples.set(name, bucket);
}

export function p95(name: string): number | null {
  const bucket = latencySamples.get(name);
  if (!bucket || bucket.length < 5) {
    return null;
  }

  const sorted = [...bucket].sort((a, b) => a - b);
  const index = Math.floor(0.95 * (sorted.length - 1));
  return sorted[index];
}

export function flowStart(flow: string): void {
  const entry = flowCounters.get(flow) ?? { started: 0, completed: 0 };
  entry.started += 1;
  flowCounters.set(flow, entry);
}

export function flowComplete(flow: string, ok = true): void {
  const entry = flowCounters.get(flow) ?? { started: 0, completed: 0 };
  if (ok) {
    entry.completed += 1;
  }
  flowCounters.set(flow, entry);
}

export function snapshot(): {
  latP95: Record<string, number>;
  flows: Record<string, { started: number; completed: number; completionRate: number }>;
} {
  const latP95: Record<string, number> = {};
  for (const key of latencySamples.keys()) {
    const value = p95(key);
    if (value !== null) {
      latP95[key] = value;
    }
  }

  const flows: Record<string, { started: number; completed: number; completionRate: number }> = {};
  for (const [key, value] of flowCounters.entries()) {
    flows[key] = {
      started: value.started,
      completed: value.completed,
      completionRate: value.started === 0 ? 0 : Math.round((value.completed / value.started) * 100),
    };
  }

  return { latP95, flows };
}
