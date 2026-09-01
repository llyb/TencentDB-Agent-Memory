export function mean(xs: number[]): number | null { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null; }
export function quantile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}
function random(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
// Resample conversation groups, not correlated queries within the same group.
export function bootstrapCI(items: { group_id: string; value: number }[], samples: number, seed: number) {
  if (!items.length) return null;
  const groups = [...new Set(items.map(x => x.group_id))];
  if (groups.length < 2) return null;
  const buckets = groups.map(g => items.filter(x => x.group_id === g).map(x => x.value));
  const rng = random(seed);
  const estimates: number[] = [];
  for (let i = 0; i < samples; i++) {
    const values: number[] = [];
    for (let j = 0; j < groups.length; j++) values.push(...buckets[Math.floor(rng() * groups.length)]);
    estimates.push(mean(values)!);
  }
  return [quantile(estimates, 0.025)!, quantile(estimates, 0.975)!];
}
