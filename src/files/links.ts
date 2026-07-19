/**
 * Public (tailnet) URL for a mission artifact, or null when PUBLIC_BASE_URL
 * is unset. relPath segments are URI-encoded; missionId is already URL-safe.
 * e.g. artifactUrl("https://m.tail.ts.net", "m-20260719-4fa1", "report.md")
 *      → "https://m.tail.ts.net/m-20260719-4fa1/report.md"
 */
export function artifactUrl(
  publicBaseUrl: string | undefined,
  missionId: string,
  relPath: string
): string | null {
  if (!publicBaseUrl) return null;
  const segments = relPath.split("/");
  // Defense in depth: a ".." segment is a path-escape attempt, never a link.
  if (segments.some((s) => s === "..")) return null;
  const encoded = segments.map((s) => encodeURIComponent(s)).join("/");
  return `${publicBaseUrl}/${missionId}/${encoded}`;
}
