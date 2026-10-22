import { argvTemplateDigest } from "@/server/live/cli/spec";

/** the approved argv-template digest for a parameter set (what a proposal binds) */
export const argvDigestOf = (p: { app: string; platform: "next" | "static"; port: number; teamId: string | null; message: string }) => argvTemplateDigest(p);
