// Tests for _shared/image.ts: detectImage + reconcileTotal.
import { assertAlmostEquals, assertEquals } from "@std/assert";
import { detectImage, reconcileTotal } from "../supabase/functions/_shared/image.ts";

Deno.test("detectImage: JPEG magic bytes", () => {
  const buf = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const r = detectImage(buf);
  assertEquals(r.mime, "image/jpeg");
  assertEquals(r.accepted, true);
  assertEquals(r.isHeic, false);
});

Deno.test("detectImage: PNG magic bytes", () => {
  const buf = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const r = detectImage(buf);
  assertEquals(r.mime, "image/png");
  assertEquals(r.accepted, true);
});

Deno.test("detectImage: HEIC via ftyp box", () => {
  // bytes 0..3: size; bytes 4..7: 'ftyp'; bytes 8..11: brand
  const buf = new Uint8Array([
    0,
    0,
    0,
    32,
    0x66,
    0x74,
    0x79,
    0x70,
    0x68,
    0x65,
    0x69,
    0x63,
  ]);
  const r = detectImage(buf);
  assertEquals(r.isHeic, true);
  assertEquals(r.accepted, false);
});

Deno.test("detectImage: declared mime takes precedence", () => {
  const buf = new Uint8Array([0xff, 0xd8, 0xff]);
  const r = detectImage(buf, "image/heic");
  assertEquals(r.isHeic, true);
  assertEquals(r.accepted, false);
});

Deno.test("detectImage: unknown bytes -> not accepted", () => {
  const buf = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0xab, 0xcd]);
  const r = detectImage(buf);
  assertEquals(r.accepted, false);
});

Deno.test("reconcileTotal: sum within +5% -> ok", () => {
  const items = [{ amount: 10 }, { amount: 5 }, { amount: 3 }]; // 18
  const r = reconcileTotal(items, 18.5); // ratio = 0.027
  assertEquals(r.ok, true);
  assertAlmostEquals(r.sum, 18, 1e-9);
});

Deno.test("reconcileTotal: sum within -5% -> ok", () => {
  const items = [{ amount: 10 }, { amount: 5 }, { amount: 3 }]; // 18
  const r = reconcileTotal(items, 17.5); // ratio = 0.029
  assertEquals(r.ok, true);
});

Deno.test("reconcileTotal: 10% off -> not ok", () => {
  const items = [{ amount: 10 }];
  const r = reconcileTotal(items, 12); // ratio = 0.167
  assertEquals(r.ok, false);
  assertAlmostEquals(r.deltaRatio, 0.1667, 1e-3);
});

Deno.test("reconcileTotal: zero total -> not ok", () => {
  const items = [{ amount: 1 }];
  const r = reconcileTotal(items, 0);
  assertEquals(r.ok, false);
});

Deno.test("reconcileTotal: custom tolerance accepts larger delta", () => {
  const items = [{ amount: 10 }];
  const r = reconcileTotal(items, 12, 0.25);
  assertEquals(r.ok, true);
});
