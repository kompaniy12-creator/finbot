// Backup helpers shared between cron-backup and tests.
//
// FINBOT_TABLES is the explicit whitelist of tables we dump (per
// CLAUDE.local.md "Backup Whitelist"). We NEVER read or back up any
// other table in the shared database, even if the schema appears to
// contain one.

import type { SupabaseClient } from "@supabase/supabase-js";
import { Encrypter } from "age-encryption";

export const FINBOT_TABLES = [
  "family_members",
  "categories",
  "expenses",
  "receipts",
  "expense_audit",
  "exchange_rates",
  "recurring_expenses",
  "anthropic_usage",
  "media_group_buffer",
  "message_log",
  "pending_retry",
  "system_health",
  "settings",
] as const;

export type FinbotTable = typeof FINBOT_TABLES[number];

const PAGE_SIZE = 1000;

/**
 * Dump all FINBOT_TABLES into a single JSON-serializable object
 * { table_name: rows[] }. Big tables (expenses, expense_audit) are
 * paginated to avoid blowing the request size.
 */
export async function dumpAllTables(
  sb: SupabaseClient,
): Promise<Record<string, Array<Record<string, unknown>>>> {
  const out: Record<string, Array<Record<string, unknown>>> = {};
  for (const table of FINBOT_TABLES) {
    out[table] = await dumpOne(sb, table);
  }
  return out;
}

async function dumpOne(
  sb: SupabaseClient,
  table: string,
): Promise<Array<Record<string, unknown>>> {
  const all: Array<Record<string, unknown>> = [];
  let from = 0;
  for (;;) {
    const res = await sb.from(table).select("*").range(from, from + PAGE_SIZE - 1);
    if (res.error) throw new Error(`dump ${table}: ${res.error.message}`);
    const rows = (res.data ?? []) as Array<Record<string, unknown>>;
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

/**
 * gzip then age-encrypt a buffer. Returns the ciphertext as Uint8Array.
 */
export async function gzipAndEncrypt(
  bytes: Uint8Array,
  agePublicKey: string,
): Promise<Uint8Array> {
  const gz = await gzip(bytes);
  const enc = new Encrypter();
  enc.addRecipient(agePublicKey);
  return await enc.encrypt(gz);
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  // Copy to a fresh ArrayBuffer to satisfy ArrayBufferView<ArrayBuffer>.
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const cs = new CompressionStream("gzip");
  const w = cs.writable.getWriter();
  w.write(new Uint8Array(ab));
  w.close();
  const out = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(out);
}

export interface GithubRelease {
  id: number;
  tag_name: string;
  created_at: string;
}

/**
 * Create a GitHub release and upload one asset. Returns the asset
 * download URL.
 */
export async function uploadToGithubRelease(args: {
  repo: string;
  token: string;
  tag: string;
  body: string;
  assetName: string;
  assetBytes: Uint8Array;
}): Promise<{ releaseId: number; assetUrl: string }> {
  // 1. Create release.
  const relResp = await fetch(`https://api.github.com/repos/${args.repo}/releases`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tag_name: args.tag,
      name: args.tag,
      body: args.body,
      draft: false,
      prerelease: false,
    }),
  });
  if (!relResp.ok) throw new Error(`github release create: HTTP ${relResp.status}`);
  const rel = await relResp.json() as { id: number; upload_url: string };

  // 2. Upload asset.
  const uploadUrl = rel.upload_url.replace(/\{\?.*\}$/, "") + `?name=${args.assetName}`;
  // Copy bytes to fresh ArrayBuffer for fetch body type.
  const bodyAb = args.assetBytes.buffer.slice(
    args.assetBytes.byteOffset,
    args.assetBytes.byteOffset + args.assetBytes.byteLength,
  ) as ArrayBuffer;
  const assetResp = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.token}`,
      "Content-Type": "application/octet-stream",
    },
    body: bodyAb,
  });
  if (!assetResp.ok) throw new Error(`github asset upload: HTTP ${assetResp.status}`);
  const asset = await assetResp.json() as { browser_download_url: string };
  return { releaseId: rel.id, assetUrl: asset.browser_download_url };
}

export async function listBackupReleases(
  repo: string,
  token: string,
): Promise<GithubRelease[]> {
  const resp = await fetch(
    `https://api.github.com/repos/${repo}/releases?per_page=100`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
  );
  if (!resp.ok) return [];
  const list = await resp.json() as GithubRelease[];
  return list.filter((r) => r.tag_name.startsWith("backup-"));
}

export async function deleteRelease(repo: string, token: string, id: number): Promise<void> {
  await fetch(`https://api.github.com/repos/${repo}/releases/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

/**
 * Prune backup-* releases older than `keepDays` (default 84 = 12 weeks).
 * Returns the number deleted.
 */
export async function pruneOldReleases(
  repo: string,
  token: string,
  keepDays = 84,
  now: Date = new Date(),
): Promise<number> {
  const list = await listBackupReleases(repo, token);
  const cutoff = now.getTime() - keepDays * 86_400_000;
  let n = 0;
  for (const r of list) {
    if (new Date(r.created_at).getTime() < cutoff) {
      await deleteRelease(repo, token, r.id);
      n++;
    }
  }
  return n;
}

/**
 * Safety gate read: returns true if backup_key_confirmed is true.
 */
export async function isBackupConfirmed(sb: SupabaseClient): Promise<boolean> {
  const res = await sb.from("system_health")
    .select("backup_key_confirmed")
    .eq("id", 1)
    .maybeSingle();
  return Boolean((res.data as { backup_key_confirmed?: boolean } | null)?.backup_key_confirmed);
}
