import { SignJWT, jwtVerify } from "jose";

import { config } from "./config.ts";

const secret = new TextEncoder().encode(config.jwtSecret);

export async function signToken(username: string): Promise<string> {
  return new SignJWT({ sub: username })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(`${config.jwtExpireMinutes}m`)
    .sign(secret);
}

export async function verifyToken(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, secret);
  return String(payload.sub || "");
}
