// Groq Whisper transcription wrapper.
// Per SPEC §6.2: download voice .ogg from Telegram (limit duration first),
// POST as multipart to Groq audio/transcriptions, get { text, language }.

import { log } from "./log.ts";

export interface TranscribeResult {
  text: string;
  language: string;
  duration?: number;
}

const DEFAULT_MODEL = "whisper-large-v3-turbo";

export async function transcribe(
  audio: Uint8Array | ArrayBuffer,
  opts: { language?: string; filename?: string; model?: string } = {},
): Promise<TranscribeResult> {
  const apiKey = Deno.env.get("GROQ_API_KEY");
  if (!apiKey) throw new Error("GROQ_API_KEY not set");

  const model = opts.model ?? Deno.env.get("GROQ_MODEL") ?? DEFAULT_MODEL;
  const filename = opts.filename ?? "voice.ogg";
  // Normalize to ArrayBuffer (SharedArrayBuffer is not accepted by Blob).
  const ab = audio instanceof ArrayBuffer
    ? audio
    : (audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer);

  const form = new FormData();
  form.append("file", new Blob([ab], { type: "audio/ogg" }), filename);
  form.append("model", model);
  form.append("response_format", "verbose_json");
  if (opts.language && opts.language !== "auto") {
    form.append("language", opts.language);
  }

  const resp = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}` },
    body: form,
  });
  if (!resp.ok) {
    const text = await resp.text();
    log("error", "groq_transcribe_failed", { status: resp.status, body: text.slice(0, 200) });
    throw new Error(`Groq transcription failed: HTTP ${resp.status}`);
  }
  const json = await resp.json() as {
    text: string;
    language?: string;
    duration?: number;
  };
  return {
    text: json.text ?? "",
    language: (json.language ?? "unknown").toLowerCase(),
    duration: json.duration,
  };
}

// Groq Whisper returns language as the full English name ("russian",
// "ukrainian", etc), but the whitelist env var uses ISO-639-1 codes.
// Normalize before comparing.
const LANG_TO_CODE: Record<string, string> = {
  russian: "ru",
  ukrainian: "uk",
  polish: "pl",
  english: "en",
  belarusian: "be",
  czech: "cs",
  slovak: "sk",
  german: "de",
  french: "fr",
  spanish: "es",
  italian: "it",
  albanian: "sq",
  bulgarian: "bg",
};

export function languageAllowed(detected: string): boolean {
  const d = detected.toLowerCase().trim();
  const normalized = LANG_TO_CODE[d] ?? d;
  const whitelist = (Deno.env.get("WHISPER_LANGUAGES_WHITELIST") ?? "ru,uk,pl,en")
    .split(",")
    .map((s) => s.trim().toLowerCase());
  return whitelist.includes(normalized);
}

export function maxDurationSec(): number {
  return Number(Deno.env.get("WHISPER_MAX_VOICE_DURATION_SEC") ?? "300");
}
