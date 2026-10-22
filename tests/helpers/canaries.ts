/** Distinctive strings that must NEVER appear in any output. */
export const CANARY = {
  token: "eyJhbGciOiJIUzI1NiJ9.CANARYTOKENPAYLOADabc.CANARYSIGNATURExyz",
  envValue: "ENVCANARYvalue-9f3k2",
  apiToken: "CANARY-api-token-should-not-leak",
  sshKey: "CANARY-ssh-private",
  email: "canary.person@example.invalid",
  nodeIp: "198.51.100.77",
  unknownField: "CANARY-unknown-future-field",
  remote: "https://git.example.invalid/CANARY-remote.git",
  author: "CANARY Author Name",
};
export const ALL_CANARIES = Object.values(CANARY);

export function assertNoCanary(value: unknown): void {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  for (const c of ALL_CANARIES) {
    if (s.includes(c)) throw new Error(`Canary leaked: ${c.slice(0, 18)}…`);
  }
}
