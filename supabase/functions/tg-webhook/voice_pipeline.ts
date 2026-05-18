// Voice message pipeline (SPEC §6.2):
//   duration pre-check -> download .ogg -> Groq transcribe -> language
//   whitelist -> hand off to text_pipeline.processTextMessage.
// Progress messages are emitted via the caller (we just return what
// happened); the caller orchestrates editMessageText.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FamilyMember, TelegramMessageSchema } from "../_shared/types.ts";
import type { z } from "zod";
import { languageAllowed, maxDurationSec, transcribe } from "../_shared/groq.ts";
import { log } from "../_shared/log.ts";
import { type PipelineResult, processTextMessage } from "./text_pipeline.ts";

export type TelegramMessage = z.infer<typeof TelegramMessageSchema>;

export type VoiceOutcome =
  | { kind: "too_long"; duration: number; maxAllowed: number }
  | { kind: "download_failed"; error: string }
  | { kind: "transcribe_failed"; error: string }
  | { kind: "language_rejected"; detected: string }
  | { kind: "no_text" }
  | { kind: "ok"; transcript: string; result: PipelineResult };

export async function processVoiceMessage(args: {
  sb: SupabaseClient;
  member: FamilyMember;
  msg: TelegramMessage;
}): Promise<VoiceOutcome> {
  const voice = args.msg.voice;
  if (!voice) return { kind: "no_text" };

  // Pre-check duration BEFORE download
  const max = maxDurationSec();
  if (voice.duration > max) {
    log("info", "voice_rejected_duration", {
      duration: voice.duration,
      max,
    });
    return { kind: "too_long", duration: voice.duration, maxAllowed: max };
  }

  // Download via Telegram getFile + fetch
  const buf = await downloadTelegramFile(voice.file_id);
  if (!buf) {
    return { kind: "download_failed", error: "getFile/fetch returned empty" };
  }

  // Transcribe via Groq
  let transcript;
  try {
    transcript = await transcribe(buf, { language: "auto" });
  } catch (err) {
    return { kind: "transcribe_failed", error: (err as Error).message };
  }

  if (!languageAllowed(transcript.language)) {
    return { kind: "language_rejected", detected: transcript.language };
  }

  if (!transcript.text.trim()) {
    return { kind: "no_text" };
  }

  // Reuse text pipeline (same Claude parse + categorize + insert)
  const result = await processTextMessage({
    sb: args.sb,
    member: args.member,
    text: transcript.text,
    telegramMessageId: args.msg.message_id,
  });

  return result ? { kind: "ok", transcript: transcript.text, result } : { kind: "no_text" };
}

/**
 * getFile -> fetch the actual file bytes. Returns null on any failure.
 */
async function downloadTelegramFile(fileId: string): Promise<Uint8Array | null> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) return null;

  const getFileResp = await fetch(
    `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`,
  );
  if (!getFileResp.ok) {
    log("warn", "tg_getfile_failed", { status: getFileResp.status });
    return null;
  }
  const getFileJson = await getFileResp.json() as {
    ok: boolean;
    result?: { file_path: string };
  };
  const filePath = getFileJson.result?.file_path;
  if (!filePath) {
    log("warn", "tg_getfile_no_path", { json: getFileJson });
    return null;
  }
  const fileResp = await fetch(
    `https://api.telegram.org/file/bot${token}/${filePath}`,
  );
  if (!fileResp.ok) {
    log("warn", "tg_file_download_failed", { status: fileResp.status });
    return null;
  }
  return new Uint8Array(await fileResp.arrayBuffer());
}
