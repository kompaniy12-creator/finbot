// scripts/restore.ts
//
// Local-only script: downloads the latest (or specified) FinBot backup
// release from GitHub, decrypts via age with the user's private key,
// inspects the contents, and (with confirmation) loads each table into
// the live Supabase project via the Management API query endpoint.
//
// Usage:
//   GITHUB_TOKEN=ghp_... GITHUB_REPO=user/finbot \
//   SUPABASE_ACCESS_TOKEN=sbp_... SUPABASE_PROJECT_REF=... \
//   AGE_PRIVATE_KEY="<your-age-private-key-from-1Password>" \
//   deno run --allow-net --allow-env --allow-read scripts/restore.ts [<tag>]

import { Decrypter } from "npm:age-encryption@0.3.0";

const env = {
  ghToken: Deno.env.get("GITHUB_TOKEN") ?? die("GITHUB_TOKEN missing"),
  ghRepo: Deno.env.get("GITHUB_REPO") ?? die("GITHUB_REPO missing"),
  sbToken: Deno.env.get("SUPABASE_ACCESS_TOKEN") ?? die("SUPABASE_ACCESS_TOKEN missing"),
  sbRef: Deno.env.get("SUPABASE_PROJECT_REF") ?? die("SUPABASE_PROJECT_REF missing"),
  ageKey: Deno.env.get("AGE_PRIVATE_KEY") ?? die("AGE_PRIVATE_KEY missing"),
};

function die(msg: string): never {
  console.error("FAIL: " + msg);
  Deno.exit(1);
}

async function listReleases(): Promise<
  Array<{ id: number; tag_name: string; assets: Array<{ name: string; url: string }> }>
> {
  const r = await fetch(`https://api.github.com/repos/${env.ghRepo}/releases?per_page=100`, {
    headers: { Authorization: `Bearer ${env.ghToken}`, Accept: "application/vnd.github+json" },
  });
  return await r.json();
}

async function downloadAsset(url: string): Promise<Uint8Array> {
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${env.ghToken}`, Accept: "application/octet-stream" },
  });
  if (!r.ok) die(`asset download HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function decryptAndUnzip(cipher: Uint8Array): Promise<Record<string, unknown[]>> {
  const dec = new Decrypter();
  dec.addIdentity(env.ageKey);
  const plain = await dec.decrypt(cipher);
  const ds = new DecompressionStream("gzip");
  const w = ds.writable.getWriter();
  const plainAb = plain.buffer.slice(
    plain.byteOffset,
    plain.byteOffset + plain.byteLength,
  ) as ArrayBuffer;
  w.write(new Uint8Array(plainAb));
  w.close();
  const decompressedAb = await new Response(ds.readable).arrayBuffer();
  return JSON.parse(new TextDecoder().decode(decompressedAb));
}

async function confirm(prompt: string): Promise<boolean> {
  console.log(prompt + " [y/N]");
  const buf = new Uint8Array(8);
  const n = await Deno.stdin.read(buf) ?? 0;
  return new TextDecoder().decode(buf.slice(0, n)).trim().toLowerCase() === "y";
}

async function runSql(sql: string): Promise<unknown> {
  const r = await fetch(
    `https://api.supabase.com/v1/projects/${env.sbRef}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.sbToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: sql }),
    },
  );
  return await r.json();
}

const requestedTag = Deno.args[0];

const releases = await listReleases();
const backups = releases.filter((r) => r.tag_name.startsWith("backup-"));
const target = requestedTag ? backups.find((r) => r.tag_name === requestedTag) : backups[0];
if (!target) die(`No backup release found for tag=${requestedTag ?? "(latest)"}`);
console.log("Target release:", target.tag_name);

const asset = target.assets.find((a) => a.name.endsWith(".age"));
if (!asset) die("Release has no .age asset");
console.log("Downloading asset...");
const cipher = await downloadAsset(asset.url);
console.log(`Downloaded ${cipher.byteLength} bytes. Decrypting...`);
const dump = await decryptAndUnzip(cipher);
console.log("Tables in dump:");
for (const [table, rows] of Object.entries(dump)) {
  console.log(`  ${table}: ${(rows as unknown[]).length} rows`);
}
console.log("\nFor each table, you'll be asked whether to TRUNCATE + insert.");
for (const [table, rows] of Object.entries(dump)) {
  const arr = rows as Array<Record<string, unknown>>;
  if (arr.length === 0) continue;
  if (!(await confirm(`Truncate ${table} and restore ${arr.length} rows?`))) continue;
  await runSql(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);
  // Batched INSERT
  for (let i = 0; i < arr.length; i += 100) {
    const batch = arr.slice(i, i + 100);
    const cols = Object.keys(batch[0]!);
    const values = batch.map((row) => "(" + cols.map((c) => sqlValue(row[c])).join(",") + ")").join(
      ",",
    );
    const sql = `INSERT INTO ${table} (${cols.join(",")}) VALUES ${values}`;
    const r = await runSql(sql) as unknown;
    if (typeof r === "object" && r && "message" in r) {
      die(`Insert ${table} batch failed: ${(r as { message: string }).message}`);
    }
  }
  console.log(`Restored ${table}.`);
}
console.log("Done.");

function sqlValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v) || typeof v === "object") {
    return "'" + JSON.stringify(v).replace(/'/g, "''") + "'::jsonb";
  }
  return "'" + String(v).replace(/'/g, "''") + "'";
}
