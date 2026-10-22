import type { ActionProposal, SimulationResult } from "../types";
import { DeployParams } from "../../deploy/params";
import { simulateDeployment } from "../../deploy/simulator";
import { defaultScenario, simulate, type SimScenario } from "./simulator";

/**
 * The execution boundary. Phase 1D implements ONLY the simulated backend.
 * A future production backend would be a SEPARATE class implementing this interface behind its own policy gate; it does not exist
 * here, no write-capable Liara client is constructed anywhere, and `kind` can only be "simulation".
 */
export interface ExecutionBackend {
  readonly kind: "simulation";
  execute(p: ActionProposal, nowIso: string): Promise<SimulationResult>;
}

export class SimulatedExecutionBackend implements ExecutionBackend {
  readonly kind = "simulation" as const;
  constructor(private readonly scenarioFor: (p: ActionProposal) => SimScenario = defaultScenario) {}
  async execute(p: ActionProposal, nowIso: string): Promise<SimulationResult> {
    if (p.operation === "first_deploy") {
      const params = DeployParams.parse(p.params); // already policy-validated; parsed again so the simulator only ever sees a strict shape
      return simulateDeployment({ id: p.id, app: p.app, params }, nowIso);
    }
    return simulate(p, this.scenarioFor(p), nowIso);
  }
}
