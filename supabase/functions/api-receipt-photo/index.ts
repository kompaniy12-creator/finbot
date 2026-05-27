// GET /api-receipt-photo?id=<receipt_uuid>
// Returns a short-lived signed URL for the receipt's stored photo so the
// Mini App can show the original image in a lightbox.
//
// Auth: Telegram initData. Family-wide visibility (any member can view any
// receipt's photo, matching the dashboard contract).

import { adminClient } from "../_shared/supabase.ts";
import { authenticateInitData, extractInitData } from "../_shared/webapp_auth.ts";
import { handleOptions, json, unauthorized } from "../_shared/api_response.ts";

const STORAGE_BUCKET = "receipts";
const SIGNED_URL_TTL_SEC = 300;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleOptions(req);
  const initData = extractInitData(req);
  if (!initData) return unauthorized(req);
  const sb = adminClient();
  const me = await authenticateInitData(initData, sb);
  if (!me) return unauthorized(req);
  void me; // family-wide visibility, role unused

  const id = new URL(req.url).searchParams.get("id");
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return json(req, { error: "id (uuid) required" }, 400);
  }

  const rec = await sb.from("receipts")
    .select("id, photo_path, photo_purged_at, merchant, receipt_date")
    .eq("id", id).maybeSingle();
  if (rec.error) return json(req, { error: rec.error.message }, 500);
  const r = rec.data as {
    id: string;
    photo_path: string | null;
    photo_purged_at: string | null;
    merchant: string | null;
    receipt_date: string;
  } | null;
  if (!r) return json(req, { error: "not_found" }, 404);
  if (!r.photo_path) {
    return json(req, { error: "no_photo", reason: "receipt has no stored photo" }, 404);
  }
  if (r.photo_purged_at) {
    return json(
      req,
      { error: "photo_purged", purged_at: r.photo_purged_at },
      410, // Gone
    );
  }

  const signed = await sb.storage.from(STORAGE_BUCKET)
    .createSignedUrl(r.photo_path, SIGNED_URL_TTL_SEC);
  if (signed.error || !signed.data?.signedUrl) {
    return json(req, { error: signed.error?.message ?? "sign_failed" }, 500);
  }

  return json(req, {
    receipt_id: r.id,
    merchant: r.merchant,
    receipt_date: r.receipt_date,
    url: signed.data.signedUrl,
    expires_in_sec: SIGNED_URL_TTL_SEC,
  });
});
