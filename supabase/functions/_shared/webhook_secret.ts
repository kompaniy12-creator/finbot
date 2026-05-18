export function checkSecret(req: Request, expected: string): boolean {
  if (!expected) return false;
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  return secret === expected;
}
