/** Deterministic (per run, order-stable) pseudonyms: the same input always maps to the same label. */
export class Pseudonymizer {
  private maps = new Map<string, Map<string, string>>();
  name(label: string, value: string): string {
    const m = this.maps.get(label) ?? new Map<string, string>();
    this.maps.set(label, m);
    if (!m.has(value)) m.set(value, `${label}-${m.size + 1}`);
    return m.get(value)!;
  }
}
