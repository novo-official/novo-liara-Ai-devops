import { z } from "zod";

/**
 * Parameters of a `first_deploy` proposal. They are part of the proposal digest, so the schema is STRICT and carries only
 * validated tokens: names, booleans, numbers and canonical commands. No secret value, no free text from the uploaded archive.
 */
export const DEPLOY_STEP_IDS = ["create_app", "validate_config", "prepare_artifact", "upload_source", "create_release", "build", "runtime_startup", "health_check", "post_checks"] as const;
export type DeployStepId = (typeof DEPLOY_STEP_IDS)[number];

export const SIM_SCENARIOS = ["success", "missing_build_script", "missing_config", "insufficient_permissions", "build_failure", "startup_failure", "health_failure"] as const;
export type SimScenario = (typeof SIM_SCENARIOS)[number];

export const NEW_APP_NAME = /^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const INVOCATION = /^(npm start|npm run (build|start)|yarn (build|start)|pnpm (build|start)|bun run (build|start))$/;

export const DeployParams = z
  .object({
    planId: z.string().regex(/^dplan_[0-9a-f]{12}$/),
    /** first 32 hex chars of the SHA-256 of the uploaded archive (128 bits): binds the plan to exactly that artifact */
    artifactDigest: z.string().regex(/^[0-9a-f]{32}$/),
    framework: z.literal("next"),
    appName: z.string().regex(NEW_APP_NAME),
    teamId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable(),
    platform: z.enum(["next", "static"]),
    planCategory: z.enum(["starter", "standard", "performance"]),
    resources: z.object({ ramMbMin: z.number().int().min(64).max(65536), ramMbRecommended: z.number().int().min(64).max(65536), diskGb: z.number().int().min(1).max(2048).nullable() }).strict(),
    build: z
      .object({
        packageManager: z.enum(["npm", "yarn", "pnpm", "bun"]).nullable(),
        buildInvocation: z.string().regex(INVOCATION).nullable(),
        startInvocation: z.string().regex(INVOCATION).nullable(),
        output: z.enum(["server", "standalone", "export"]),
        port: z.number().int().min(1).max(65535),
        nodeRange: z.string().regex(/^[0-9A-Za-z.<>=^~|* x-]{1,40}$/).nullable(),
      })
      .strict(),
    /** NAMES only; values are entered by the operator out-of-band and never reach this system */
    envKeys: z.array(z.string().regex(ENV_NAME)).max(40),
    needsDatabase: z.boolean(),
    readinessBasis: z.enum(["READY", "READY_WITH_WARNINGS", "NEEDS_CONFIGURATION_CONFIRMED"]),
    steps: z.array(z.enum(DEPLOY_STEP_IDS)).min(1).max(12),
    environment: z.literal("simulation"),
    simulation: z.object({ scenario: z.enum(SIM_SCENARIOS) }).strict(),
  })
  .strict();
export type DeployParamsT = z.infer<typeof DeployParams>;
