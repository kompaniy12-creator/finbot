// Image handling for receipt photos.
//
// Supabase Edge Functions runtime (Deno+V8) does NOT support native modules
// like sharp / heic-convert. Per docs/16 patches, the v1.2 plan is to use
// @imagemagick/magick-wasm. For M9 we ship JPEG+PNG end-to-end (just pass
// bytes through to Storage + Claude Vision); HEIC detection rejects with a
// user-friendly message and stashes the file_id for later support.

export const ACCEPTED_MIME_TYPES = ["image/jpeg", "image/jpg", "image/png"];

export interface DetectedImage {
  mime: string;
  isHeic: boolean;
  accepted: boolean;
  size: number;
}

/**
 * Quick magic-byte sniff. Telegram messages often carry mime_type, but for
 * messages where photo[] is used we get no mime, so check first bytes.
 */
export function detectImage(buf: Uint8Array, declaredMime?: string): DetectedImage {
  const size = buf.byteLength;
  if (declaredMime) {
    const mime = declaredMime.toLowerCase();
    const isHeic = mime === "image/heic" || mime === "image/heif";
    return {
      mime,
      isHeic,
      accepted: !isHeic && ACCEPTED_MIME_TYPES.includes(mime),
      size,
    };
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: "image/jpeg", isHeic: false, accepted: true, size };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  ) {
    return { mime: "image/png", isHeic: false, accepted: true, size };
  }
  // HEIC: bytes 4..11 contain "ftypheic" / "ftypheix" / "ftyphevc" / "ftypmif1"
  // Check ftyp box (offset 4 = "ftyp")
  if (
    buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70
  ) {
    const brand = String.fromCharCode(buf[8] ?? 0, buf[9] ?? 0, buf[10] ?? 0, buf[11] ?? 0);
    if (
      brand === "heic" || brand === "heix" || brand === "hevc" || brand === "mif1" ||
      brand === "heim"
    ) {
      return { mime: "image/heic", isHeic: true, accepted: false, size };
    }
  }
  return { mime: "application/octet-stream", isHeic: false, accepted: false, size };
}

/**
 * Reconcile parsed receipt items vs total. Returns true if sum is within
 * +- tolerance (default 5%).
 */
export function reconcileTotal(
  items: Array<{ amount: number; qty?: number }>,
  total: number,
  tolerance = 0.05,
): { ok: boolean; sum: number; deltaRatio: number } {
  const sum = items.reduce((acc, i) => acc + i.amount, 0);
  if (total <= 0) return { ok: false, sum, deltaRatio: 1 };
  const deltaRatio = Math.abs(sum - total) / total;
  return { ok: deltaRatio <= tolerance, sum, deltaRatio };
}
