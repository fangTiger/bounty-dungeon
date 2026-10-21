/**
 * src/bounty/useVerifier.ts
 * POST to the verifier API and return a signed RunResult.
 */

import { VERIFIER_URL } from "./contract";

export interface VerifierRequest {
  player: string;
  package: unknown;
}

export interface VerifierRunResult {
  player: string;
  seed: string;
  score: string;
  replayHash: string;
  runId: string;
}

export interface VerifierResponse {
  runResult: VerifierRunResult;
  signature: string;
  chainId: number;
  contract: string;
  replayMismatch: boolean;
}

export async function callVerifier(req: VerifierRequest): Promise<VerifierResponse> {
  const res = await fetch(VERIFIER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: Record<string, unknown> = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    if (res.status === 503) throw new Error("Verifier offline — check VERIFIER_PRIVATE_KEY.");
    const msg = typeof json.error === "string" ? json.error : `Verifier error ${res.status}`;
    throw new Error(msg);
  }
  return json as unknown as VerifierResponse;
}
