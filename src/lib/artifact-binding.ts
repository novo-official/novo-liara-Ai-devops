/**
 * Client-side helpers for the ONE artifact (ZIP) the operator selects on the deployment page. The browser keeps the `File` in memory only; the SERVER never trusts
 * this comparison — every preview, proposal and execution re-uploads the bytes and the server re-hashes, re-analyses and re-builds the artifact. The check here
 * only tells the operator early that they picked a different file than the one that was analysed.
 */
export type ArtifactState = "none" | "hashing" | "match" | "mismatch" | "unverifiable";

export async function sha256Hex(file: Blob): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null; // non-secure context: the server still verifies
    const digest = await subtle.digest("SHA-256", await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/** `analysedPrefix` is the 32-hex-char digest the server stored for the analysed archive (the server compares with `startsWith`). */
export function artifactState(file: { size: number } | null, hashed: { sha256: string | null } | null, analysedPrefix: string): ArtifactState {
  if (!file) return "none";
  if (!hashed) return "hashing";
  if (hashed.sha256 === null) return "unverifiable";
  return hashed.sha256.startsWith(analysedPrefix) ? "match" : "mismatch";
}

/** The states in which the UI may offer preview / proposal / execution (the server decides for real each time). */
export const artifactUsable = (s: ArtifactState): boolean => s === "match" || s === "unverifiable";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
