/** Tiny structured-ish logger. stdout for info, stderr for errors. */

function stamp(): string {
  return new Date().toISOString();
}

export function log(scope: string, msg: string, extra?: unknown): void {
  const tail = extra === undefined ? "" : ` ${safeJson(extra)}`;
  console.log(`${stamp()} [${scope}] ${msg}${tail}`);
}

export function logError(scope: string, msg: string, err?: unknown): void {
  const tail =
    err === undefined
      ? ""
      : ` ${err instanceof Error ? (err.stack ?? err.message) : safeJson(err)}`;
  console.error(`${stamp()} [${scope}] ERROR ${msg}${tail}`);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
