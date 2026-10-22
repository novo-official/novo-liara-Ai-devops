import "server-only";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * READ-ONLY lookup of the bootstrapped application scope (table `app_scope`, written ONLY by the live executor's transactional bootstrap).
 * It uses its own read-only SQLite handle so the Liara layer does not depend on the agent/live modules. It can only answer "was this exact app created
 * by a verified, approved live operation in this team?"; it cannot add anything, and any error means "no".
 */
interface RoDb {
  prepare(sql: string): { get(...p: unknown[]): Record<string, unknown> | undefined };
}
let handle: { file: string; db: RoDb | null } | null = null;

export function bootstrappedScopeLookup(file: string, teamId: string | null): (name: string) => boolean {
  const team = teamId ?? "personal";
  return (name) => {
    try {
      const abs = path.resolve(file);
      if (!handle || handle.file !== abs) {
        const mod = process.getBuiltinModule("node:sqlite") as unknown as { DatabaseSync: new (f: string, o: { readOnly: boolean }) => RoDb } | undefined;
        handle = { file: abs, db: mod && existsSync(abs) ? new mod.DatabaseSync(abs, { readOnly: true }) : null };
      }
      if (!handle.db) {
        handle = null; // the file may appear later (first live operation)
        return false;
      }
      return !!handle.db.prepare("SELECT 1 AS x FROM app_scope WHERE team_key=? AND app_name=?").get(team, name);
    } catch {
      handle = null;
      return false;
    }
  };
}
