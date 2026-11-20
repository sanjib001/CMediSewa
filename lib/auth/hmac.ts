import "server-only";
import { createHmac, randomBytes } from "node:crypto";

function key(): string {
  const k = process.env.AUTH_HMAC_SECRET;
  if (!k || k.length < 32) throw new Error("AUTH_HMAC_SECRET must be set (32+ chars)");
  return k;
}

/** HMAC with a purpose prefix, so the same secret never produces interchangeable hashes. */
export function hmac(purpose: "device" | "login" | "invite", value: string): string {
  return createHmac("sha256", key()).update(`${purpose}:${value}`).digest("base64url");
}

/** A fresh 256-bit token (trusted-device cookie). Only its HMAC is stored. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export const DEVICE_COOKIE = "cm_device";
export const LAST_TENANT_COOKIE = "cm_last_tenant";
