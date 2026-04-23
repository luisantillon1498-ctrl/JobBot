import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FeatureType =
  | "professional_experience"
  | "academics"
  | "extracurriculars"
  | "skills_and_certifications"
  | "personal";

interface ResumeEntry {
  feature_type: FeatureType;
  role_title: string;
  company: string;
  location: string;
  degree: string;
  major: string;
  from_date: string | null;
  to_date: string | null;
  description_lines: string[];
  sort_order: number;
}

// ---------------------------------------------------------------------------
// CORS / response helpers
// ---------------------------------------------------------------------------

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

/** Always HTTP 200 so Supabase `invoke` returns JSON in `data`. */
function jsonOk(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: jsonHeaders });
}

// ---------------------------------------------------------------------------
// Retry / backoff helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseProviderErrorMessage(errText: string): string | null {
  try {
    const j = JSON.parse(errText) as { error?: { message?: string }; message?: string };
    const m = j?.error?.message ?? j?.message;
    if (typeof m === "string" && m.trim()) return m.trim().slice(0, 500);
  } catch { /* ignore */ }
  const t = errText.trim();
  return t ? t.slice(0, 400) : null;
}

function retryAfterMsFromResponse(res: Response, attemptIndex: number): number {
  const ra = res.headers.get("retry-after");
  if (ra) {
    const sec = parseFloat(ra);
    if (Number.isFinite(sec) && sec >= 0) return Math.min(Math.max(sec * 1000, 500), 25000);
  }
  return [1000, 2000, 4000, 6000, 8000][attemptIndex] ?? 8000;
}

function isTransientOverload(status: number, errText: string): boolean {
  if (status === 429 || status === 500 || status === 503 || status === 504) return true;
  const msg = (parseProviderErrorMessage(errText) ?? errText).toLowerCase();
  return (
    msg.includes("high demand") ||
    msg.includes("overloaded") ||
    msg.includes("temporarily unavailable") ||
    msg.includes("try again later") ||
    msg.includes("resource exhausted")
  );
}

// ---------------------------------------------------------------------------
// Gemini prompt
// ---------------------------------------------------------------------------

const PARSE_PROMPT = `You are a resume parser. Extract all resume content from the text below into a JSON array.

Each item must have these exact fields:
- feature_type: one of "professional_experience", "academics", "extracurriculars", "skills_and_certifications", "personal"
- role_title: string (job title, skill category name, or interests text for personal)
- company: string (company/org name, or school name for academics; empty for skills/personal)
- location: string (city/state if shown, otherwise empty)
- degree: string (degree type for academics, empty otherwise)
- major: string (field of study for academics, empty otherwise)
- from_date: string in "YYYY-MM-01" format, or null
- to_date: string in "YYYY-MM-01" format, or null if current/present
- description_lines: array of strings, one bullet point per string
- sort_order: integer, sequential per feature_type group starting at 0

Rules:
- Skills: one entry per category. Use role_title for category name, list items as description_lines.
- Personal/interests: one entry, comma-separated interests in role_title, empty description_lines.
- Present roles: set to_date to null.
- Preserve bullet text exactly as written.
- Approximate dates (e.g. "Spring 2023"): use best estimate for month.`;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_FEATURE_TYPES = new Set<string>([
  "professional_experience",
  "academics",
  "extracurriculars",
  "skills_and_certifications",
  "personal",
]);

function coerceEntry(raw: unknown, index: number): ResumeEntry {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Entry ${index} is not an object`);
  }
  const r = raw as Record<string, unknown>;

  const feature_type = String(r.feature_type ?? "").trim() as FeatureType;
  if (!VALID_FEATURE_TYPES.has(feature_type)) {
    throw new Error(`Entry ${index} has invalid feature_type: "${r.feature_type}"`);
  }

  const coerceStr = (val: unknown): string =>
    val == null ? "" : String(val).trim();

  const coerceDate = (val: unknown): string | null => {
    if (val == null) return null;
    const s = String(val).trim();
    if (!s || s.toLowerCase() === "null") return null;
    const match = s.match(/^(\d{4})-(\d{2})/);
    if (match) return `${match[1]}-${match[2]}-01`;
    return null;
  };

  const descLines = (() => {
    const raw_lines = r.description_lines;
    if (!Array.isArray(raw_lines)) return [];
    return raw_lines.map((l) => String(l ?? "").trim()).filter((l) => l.length > 0);
  })();

  const sort_order = typeof r.sort_order === "number" ? Math.max(0, Math.floor(r.sort_order)) : 0;

  return {
    feature_type,
    role_title: coerceStr(r.role_title),
    company: coerceStr(r.company),
    location: coerceStr(r.location),
    degree: coerceStr(r.degree),
    major: coerceStr(r.major),
    from_date: coerceDate(r.from_date),
    to_date: coerceDate(r.to_date),
    description_lines: descLines,
    sort_order,
  };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    // -- Auth --
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return jsonOk({ ok: false, error: "Not authenticated", code: "unauthenticated" });
    }

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) {
      return jsonOk({ ok: false, error: "Invalid auth", code: "unauthenticated" });
    }

    // -- Parse body --
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return jsonOk({ ok: false, error: "Request body must be valid JSON", code: "bad_request" });
    }

    const { pdf_text } = body;
    if (!pdf_text || typeof pdf_text !== "string" || !pdf_text.trim()) {
      return jsonOk({ ok: false, error: "Missing pdf_text", code: "bad_request" });
    }

    // Truncate very long documents to stay within token limits
    const MAX_CHARS = 40_000;
    const resumeText = pdf_text.length > MAX_CHARS
      ? pdf_text.slice(0, MAX_CHARS) + "\n[document truncated]"
      : pdf_text;

    // -- Env --
    const geminiApiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
    if (!geminiApiKey) {
      return jsonOk({
        ok: false,
        error: "GEMINI_API_KEY is not configured on this Edge Function.",
        code: "misconfigured",
      });
    }

    // Use the same model as generate-cover-letter
    const geminiModel = (Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash").trim() || "gemini-2.5-flash";

    const geminiUrl =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}` +
      `:generateContent?key=${encodeURIComponent(geminiApiKey)}`;

    console.log(`[parse-resume] model=${geminiModel} text_length=${resumeText.length}`);

    const buildGeminiPayload = () => JSON.stringify({
      contents: [
        {
          parts: [
            { text: `${PARSE_PROMPT}\n\nResume text:\n${resumeText}` },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
      },
    });

    // 45-second timeout per attempt
    const doGeminiFetch = () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45_000);
      return fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: buildGeminiPayload(),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
    };

    let aiResponse: Response;
    try {
      aiResponse = await doGeminiFetch();
    } catch (fetchErr) {
      const isTimeout = fetchErr instanceof Error && fetchErr.name === "AbortError";
      console.error("[parse-resume] fetch error:", isTimeout ? "timeout" : String(fetchErr));
      return jsonOk({
        ok: false,
        error: isTimeout
          ? "Resume parsing timed out. Please try again."
          : `Network error: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
        code: isTimeout ? "timeout" : "network_error",
      });
    }

    console.log(`[parse-resume] Gemini status: ${aiResponse.status}`);

    // Retry on transient overload (up to 5 attempts)
    let lastBackoffBody = "";
    for (let attempt = 0; !aiResponse.ok && attempt < 5; attempt++) {
      const attemptBody = await aiResponse.text().catch(() => "");
      if (!isTransientOverload(aiResponse.status, attemptBody)) {
        lastBackoffBody = attemptBody;
        break;
      }
      lastBackoffBody = attemptBody;
      console.warn(`[parse-resume] overload, retry ${attempt + 1}:`, aiResponse.status);
      await delay(retryAfterMsFromResponse(aiResponse, attempt));
      aiResponse = await doGeminiFetch();
    }

    if (!aiResponse.ok) {
      const errText = (await aiResponse.text().catch(() => "")) || lastBackoffBody;
      if (aiResponse.status === 429) {
        const detail = parseProviderErrorMessage(errText);
        return jsonOk({
          ok: false,
          error: detail ?? "Rate limited (429). Wait a moment and try again.",
          code: "rate_limited",
        });
      }
      if (isTransientOverload(aiResponse.status, errText)) {
        return jsonOk({
          ok: false,
          error: "The AI provider is temporarily overloaded. Please try again in a moment.",
          code: "provider_unavailable",
        });
      }
      const hint = parseProviderErrorMessage(errText) ?? `HTTP ${aiResponse.status}`;
      console.error("[parse-resume] Gemini error:", aiResponse.status, errText.slice(0, 400));
      return jsonOk({ ok: false, error: `AI generation failed: ${hint}`, code: "ai_provider" });
    }

    // -- Parse response --
    const aiData = await aiResponse.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      promptFeedback?: { blockReason?: string };
    };

    if (aiData.promptFeedback?.blockReason) {
      return jsonOk({ ok: false, error: `Blocked: ${aiData.promptFeedback.blockReason}`, code: "blocked" });
    }

    const parts = aiData.candidates?.[0]?.content?.parts ?? [];
    const rawText = parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("").trim();

    if (!rawText) {
      return jsonOk({ ok: false, error: "No content generated.", code: "empty_completion" });
    }

    // With responseMimeType: "application/json", Gemini guarantees valid JSON —
    // just parse directly, no repair needed.
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseErr) {
      console.error("[parse-resume] JSON parse failed:", rawText.slice(0, 300));
      return jsonOk({
        ok: false,
        error: `JSON parse error: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        code: "parse_error",
      });
    }

    // Gemini might wrap the array in an object — unwrap if needed
    const arr: unknown = Array.isArray(parsed)
      ? parsed
      : (parsed && typeof parsed === "object"
          ? Object.values(parsed as Record<string, unknown>).find(Array.isArray)
          : null);

    if (!Array.isArray(arr)) {
      console.error("[parse-resume] not an array:", rawText.slice(0, 200));
      return jsonOk({ ok: false, error: "AI did not return a JSON array.", code: "parse_error" });
    }

    const entries: ResumeEntry[] = [];
    for (let i = 0; i < arr.length; i++) {
      try {
        entries.push(coerceEntry(arr[i], i));
      } catch (e) {
        console.warn("[parse-resume] skipping invalid entry:", e);
      }
    }

    if (entries.length === 0) {
      return jsonOk({ ok: false, error: "No valid resume entries found in the document.", code: "no_entries" });
    }

    console.log(`[parse-resume] success: ${entries.length} entries`);
    return jsonOk({ ok: true, entries });

  } catch (e) {
    console.error("[parse-resume] unexpected error:", e);
    return jsonOk({ ok: false, error: e instanceof Error ? e.message : "Unknown error", code: "unexpected" });
  }
});
