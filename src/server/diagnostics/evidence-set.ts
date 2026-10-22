import type { AnyEvidence, EvidenceDataMap, EvidenceItem, SourceKey } from "./types";

/** Immutable bag of evidence items for one run. Detectors only ever see this (never raw API data). */
export class EvidenceSet {
  private readonly bySource = new Map<SourceKey, AnyEvidence>();
  constructor(public readonly items: AnyEvidence[]) {
    for (const i of items) this.bySource.set(i.source, i);
  }
  item<K extends SourceKey>(k: K): EvidenceItem<K> | undefined {
    return this.bySource.get(k) as EvidenceItem<K> | undefined;
  }
  /** Data only when the item is usable as an observation (available, or stale-but-present). */
  data<K extends SourceKey>(k: K): EvidenceDataMap[K] | null {
    const i = this.item(k);
    return i && (i.availability === "available" || i.availability === "stale") ? i.data : null;
  }
  ids(): Set<string> {
    return new Set(this.items.map((i) => i.id));
  }
  idOf(k: SourceKey): string | null {
    return this.item(k)?.id ?? null;
  }
}
