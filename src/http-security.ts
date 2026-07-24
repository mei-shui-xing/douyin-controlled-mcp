import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { CONFIG } from "./config.js";

type NextFunction = () => void;

type RateWindow = { startedAt: number; count: number };

const rateWindows = new Map<string, RateWindow>();

function normalizeOrigin(value: string): string {
  return value.trim().toLowerCase().replace(/\/$/, "");
}

function tokenFromRequest(req: Request): string {
  const authorization = req.header("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const headerToken = req.header("x-mcp-access-token")?.trim();
  const queryToken = typeof req.query.access_token === "string"
    ? req.query.access_token.trim()
    : "";
  return bearer || headerToken || queryToken || "";
}

function sameSecret(actual: string, expected: string): boolean {
  if (!actual || !expected) return false;
  const actualHash = createHash("sha256").update(actual).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function requestIdentity(req: Request): string {
  const token = tokenFromRequest(req);
  if (token) return createHash("sha256").update(token).digest("hex").slice(0, 24);
  return req.ip || req.socket.remoteAddress || "unknown";
}

export function applyCors(req: Request, res: Response, next: NextFunction): void {
  const rawOrigin = req.header("origin");
  if (rawOrigin) {
    const origin = normalizeOrigin(rawOrigin);
    if (!CONFIG.allowedOrigins.has(origin)) {
      res.status(403).json({ ok: false, code: "ORIGIN_NOT_ALLOWED" });
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", rawOrigin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization,Content-Type,MCP-Session-Id,MCP-Protocol-Version,X-MCP-Access-Token",
  );
  res.setHeader("Access-Control-Expose-Headers", "MCP-Session-Id");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

export function requireMcpAuthentication(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!CONFIG.accessToken) {
    res.status(503).json({
      ok: false,
      code: "MCP_AUTH_NOT_CONFIGURED",
      message: "HTTP MCP requires MCP_ACCESS_TOKEN. Use stdio for unauthenticated local access.",
    });
    return;
  }
  if (!sameSecret(tokenFromRequest(req), CONFIG.accessToken)) {
    res.setHeader("WWW-Authenticate", "Bearer");
    res.status(401).json({ ok: false, code: "MCP_AUTH_REQUIRED" });
    return;
  }
  next();
}

export function enforceRequestRate(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const now = Date.now();
  const key = requestIdentity(req);
  const current = rateWindows.get(key);
  const window = !current || now - current.startedAt >= 60_000
    ? { startedAt: now, count: 0 }
    : current;
  window.count += 1;
  rateWindows.set(key, window);
  if (window.count > CONFIG.maxRequestsPerMinute) {
    res.setHeader("Retry-After", String(Math.max(
      1,
      Math.ceil((window.startedAt + 60_000 - now) / 1000),
    )));
    res.status(429).json({ ok: false, code: "MCP_RATE_LIMITED" });
    return;
  }
  next();
}

export function accessTokenFingerprint(): string | null {
  if (!CONFIG.accessToken) return null;
  return createHash("sha256")
    .update(CONFIG.accessToken)
    .digest("hex")
    .slice(0, 12);
}
