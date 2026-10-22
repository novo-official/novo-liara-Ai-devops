import { buildZip, type ZipSpec } from "./zip";

/** Programmatic project fixtures (built into ZIPs in memory). Every scenario is derived from `nextProject` by MUTATING real inputs. */
export type Files = Record<string, string | null>;

export const PKG = {
  name: "my-shop-site",
  version: "1.0.0",
  private: true,
  scripts: { dev: "next dev", build: "next build", start: "next start", lint: "next lint" },
  dependencies: { next: "^14.2.3", react: "^18.3.0", "react-dom": "^18.3.0" },
  engines: { node: ">=18.17" },
} as const;

export function baseFiles(): Files {
  return {
    "package.json": JSON.stringify(PKG, null, 2),
    "package-lock.json": "{}",
    "next.config.js": "/** @type {import('next').NextConfig} */\nmodule.exports = { reactStrictMode: true };\n",
    "app/page.tsx": "export default function Page() { return <main>hello</main>; }\n",
    "app/layout.tsx": "export default function L({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n",
    ".gitignore": "node_modules\n.next\n.env\n.env.local\n",
  };
}

export function withPkg(patch: (p: Record<string, unknown>) => void, files: Files = baseFiles()): Files {
  const p = JSON.parse(files["package.json"]!) as Record<string, unknown>;
  patch(p);
  return { ...files, "package.json": JSON.stringify(p, null, 2) };
}

export const zipOf = (files: Files, extra: ZipSpec[] = []): Buffer => buildZip([...Object.entries(files).filter(([, v]) => v !== null).map(([name, data]) => ({ name, data: data! })), ...extra]);
export const nextZip = (over: Files = {}): Buffer => zipOf({ ...baseFiles(), ...over });
