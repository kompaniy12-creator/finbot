// cron-backup: weekly Saturday 03:00 UTC.
// Per SPEC §9.4: dump FINBOT_TABLES only, gzip, age-encrypt with
// BACKUP_ENCRYPTION_KEY, upload to GitHub release backup-YYYY-MM-DD.
// Integrity check after upload, then prune releases > 12 weeks old.

import { adminClient } from "../_shared/supabase.ts";
import { log } from "../_shared/log.ts";
import { checkCronAuth } from "../_shared/retry.ts";
import {
  dumpAllTables,
  gzipAndEncrypt,
  isBackupConfirmed,
  pruneOldReleases,
  uploadToGithubRelease,
} from "../_shared/backup.ts";
import { todayWarsawIso } from "../_shared/dates.ts";

Deno.serve(async (req: Request) => {
  if (!checkCronAuth(req)) return new Response("forbidden", { status: 401 });
  const sb = adminClient();

  // Safety gate.
  const confirmed = await isBackupConfirmed(sb);
  if (!confirmed) {
    log("warn", "backup_safety_gate_blocked", {
      hint: "Admin must run /health backup-confirm in Telegram after saving the age private key.",
    });
    return Response.json({ ok: false, reason: "safety_gate" });
  }

  const ageKey = Deno.env.get("BACKUP_ENCRYPTION_KEY");
  const ghRepo = Deno.env.get("GITHUB_REPO");
  const ghToken = Deno.env.get("GITHUB_TOKEN");
  if (!ageKey || !ghRepo || !ghToken) {
    return Response.json({ ok: false, reason: "missing_env" }, { status: 500 });
  }

  // Dump
  const dump = await dumpAllTables(sb);
  const json = new TextEncoder().encode(JSON.stringify(dump));
  const expensesCount = dump["expenses"]?.length ?? 0;

  // Encrypt
  const ciphertext = await gzipAndEncrypt(json, ageKey);

  // Upload
  const tag = `backup-${todayWarsawIso()}`;
  let releaseId = 0;
  try {
    const r = await uploadToGithubRelease({
      repo: ghRepo,
      token: ghToken,
      tag,
      body: `FinBot weekly backup. ${expensesCount} expenses. Encrypted with age.`,
      assetName: `finbot-${tag}.age`,
      assetBytes: ciphertext,
    });
    releaseId = r.releaseId;
  } catch (err) {
    log("error", "backup_upload_failed", { error: (err as Error).message });
    return Response.json({ ok: false, reason: "upload_failed" }, { status: 500 });
  }

  // Prune
  const pruned = await pruneOldReleases(ghRepo, ghToken);

  log("info", "backup_done", {
    tag,
    release_id: releaseId,
    expenses_count: expensesCount,
    pruned_old_releases: pruned,
    bytes: ciphertext.byteLength,
  });
  return Response.json({
    ok: true,
    tag,
    expenses_count: expensesCount,
    pruned,
    bytes: ciphertext.byteLength,
  });
});
