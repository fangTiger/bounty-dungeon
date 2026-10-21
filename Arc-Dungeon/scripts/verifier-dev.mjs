/**
 * scripts/verifier-dev.mjs
 *
 * Local dev server for the verifier API.
 * Starts an HTTP server on http://127.0.0.1:8787/api/verify
 *
 * Usage:
 *   node scripts/verifier-dev.mjs
 *
 * Set VERIFIER_PRIVATE_KEY (and optionally CHAIN_ID, BOUNTY_CONTRACT) in your
 * shell environment before running.  Never commit a .env file with the key.
 *
 *   VERIFIER_PRIVATE_KEY=0x... node scripts/verifier-dev.mjs
 */

import http from "node:http";
import { handleVerify } from "../api/verify.js";

const HOST = "127.0.0.1";
const PORT = 8787;

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type":                 "application/json",
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.url !== "/api/verify") {
    res.writeHead(404);
    return res.end(JSON.stringify({ error: "Not found" }));
  }

  if (req.method !== "POST") {
    res.writeHead(405);
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  // Collect body
  let rawBody = "";
  for await (const chunk of req) rawBody += chunk;

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: "Invalid JSON body" }));
  }

  const { status, body: responseBody } = await handleVerify(body, process.env);
  res.writeHead(status);
  res.end(JSON.stringify(responseBody));
});

server.listen(PORT, HOST, () => {
  console.log(`Verifier dev server listening on http://${HOST}:${PORT}/api/verify`);
  console.log("VERIFIER_PRIVATE_KEY:", process.env.VERIFIER_PRIVATE_KEY ? "(set)" : "(MISSING — will return 503)");
});
