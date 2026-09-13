import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
export function requiredParam(c: Context, key: string): string {
  const value = c.req.param(key);
  if (!value) throw new HTTPException(400, { message: `缺少路径参数 ${key}` });
  return value;
}
