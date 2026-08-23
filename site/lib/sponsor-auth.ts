import { timingSafeEqual } from "crypto";

export function sponsorAdminAuthorized(req: Request): boolean {
  const expected = process.env.SPONSOR_ADMIN_KEY || "";
  const actual = req.headers.get("x-sponsor-admin-key") || "";
  if (expected.length < 32 || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
