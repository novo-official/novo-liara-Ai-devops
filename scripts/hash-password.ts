/* Generates APP_ACCESS_PASSWORD_HASH. Reads the password from a hidden prompt (or stdin when piped). */
import { envLineFor, hashPassword, MIN_PASSWORD_LENGTH } from "../src/server/security/password";

async function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  process.stderr.write(prompt);
  return new Promise((resolve) => {
    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\u0003") process.exit(130);
        if (c === "\r" || c === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stderr.write("\n");
          return resolve(value);
        }
        if (c === "\u007f") value = value.slice(0, -1);
        else value += c;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main() {
  const pw = await readHidden(`Password (min ${MIN_PASSWORD_LENGTH} chars, not echoed): `);
  if (process.stdin.isTTY) {
    const again = await readHidden("Repeat password: ");
    if (again !== pw) {
      process.stderr.write("Passwords do not match.\n");
      process.exit(1);
    }
  }
  const hash = await hashPassword(pw);
  process.stderr.write("\nAdd this line to .env.local exactly as printed (each $ must stay escaped as \\$ — Next expands $name even inside quotes):\n\n");
  process.stdout.write(`${envLineFor(hash)}\n`);
}

main().catch((e: Error) => {
  process.stderr.write(`Error: ${e.message}\n`);
  process.exit(1);
});
