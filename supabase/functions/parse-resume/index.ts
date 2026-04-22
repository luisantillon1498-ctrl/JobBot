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
// Retry / backoff helpers (mirrors generate-cover-letter pattern)
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseProviderErrorMessage(errText: string): string | null {
  try {
    const j = JSON.parse(errText) as { error?: { message?: string }; message?: string };
    const m = j?.error?.message ?? j?.message;
    if (typeof m === "string" && m.trim()) return m.trim().slice(0, 500);
  } catch {
    /* ignore */
  }
  const t = errText.trim();
  return t ? t.slice(0, 400) : null;
}

function retryAfterMsFromResponse(res: Response, attemptIndex: number): number {
  const ra = res.headers.get("retry-after");
  if (ra) {
    const sec = parseFloat(ra);
    if (Number.isFinite(sec) && sec >= 0) return Math.min(Math.max(sec * 1000, 500), 25000);
  }
  return [2000, 5000, 10000][attemptIndex] ?? 8000;
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

const PARSE_PROMPT = `Parse this resume PDF and extract all content into a structured JSON array. Return ONLY a valid JSON array with no markdown fencing, no explanation, just the raw JSON array.

Each item in the array must have these exact fields:
- feature_type: one of "professional_experience", "academics", "extracurriculars", "skills_and_certifications", "personal"
- role_title: string (job title, category name for skills, interests text for personal)
- company: string (company/org name, school name for academics, empty for skills/personal)
- location: string (city/state, empty if not shown)
- degree: string (degree type for academics, empty otherwise)
- major: string (field of study for academics, empty otherwise)
- from_date: string "YYYY-MM-01" or null
- to_date: string "YYYY-MM-01" or null (null means current/present)
- description_lines: array of strings (bullet points, one string per bullet)
- sort_order: sequential integer per feature_type group starting at 0

Rules:
- Skills section: one entry per category (e.g. "Technical Skills", "Languages"). Use role_title for category name. List skills as description_lines items.
- Personal/interests: one entry total, put all interests in role_title as a comma-separated string, description_lines empty.
- For "present" positions, set to_date to null.
- Preserve all bullet points exactly as written.
- If a date is approximate (e.g. "Spring 2023"), use your best estimate for the month.`;

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

/** Strip leading/trailing markdown code fences that Gemini sometimes emits. */
function stripMarkdownFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

/** Validate and coerce a raw parsed entry, throwing if unrecoverable. */
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
    // Enforce YYYY-MM-01 format — fix day component if present
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

    const { pdf_base64 } = body;
    if (pdf_base64 == null || typeof pdf_base64 !== "string" || pdf_base64.trim() === "") {
      return jsonOk({ ok: false, error: "Missing pdf_base64", code: "bad_request" });
    }

    // -- Env --
    const geminiApiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
    if (!geminiApiKey) {
      return jsonOk({
        ok: false,
        error: "GEMINI_API_KEY is not configured on this Edge Function.",
        code: "misconfigured",
      });
    }
    const geminiModel = (Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash").trim() || "gemini-2.5-flash";

    // -- Call Gemini multimodal API --
    // Use gemini-1.5-flash for PDF parsing — faster and cheaper than 2.5-flash,
    // and the structured extraction task doesn't need 2.5's reasoning depth.
    // Fall back to whatever GEMINI_MODEL env var says only if explicitly overridden.
    const pdfGeminiModel = Deno.env.get("GEMINI_PARSE_MODEL")?.trim() || "gemini-1.5-flash";

    const geminiUrl =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(pdfGeminiModel)}` +
      `:generateContent?key=${encodeURIComponent(geminiApiKey)}`;

    console.log(`[parse-resume] Calling Gemini model: ${pdfGeminiModel}, pdf_base64 length: ${pdf_base64.length}`);

    const buildGeminiPayload = () =>
      JSON.stringify({
        contents: [
          {
            parts: [
              {
                inline_data: {
                  mime_type: "application/pdf",
                  data: pdf_base64.trim(),
                },
              },
              {
                text: PARSE_PROMPT,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 4096,
        },
      });

    // 45-second timeout — leaves headroom before Supabase's 60s function limit
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
      console.error("[parse-resume] Gemini fetch error:", isTimeout ? "timeout (45s)" : String(fetchErr));
      return jsonOk({
        ok: false,
        error: isTimeout
          ? "Resume parsing timed out — the PDF may be too large or complex. Try a smaller PDF (under 2MB)."
          : `Network error calling AI: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
        code: isTimeout ? "timeout" : "network_error",
      });
    }

    console.log(`[parse-resume] Gemini responded with status: ${aiResponse.status}`);

    // Retry on transient overload errors (up to 3 additional attempts)
    let lastBackoffBody = "";
    for (let attempt = 0; !aiResponse.ok && attempt < 3; attempt++) {
      const attemptBody = await aiResponse.text().catch(() => "");
      if (!isTransientOverload(aiResponse.status, attemptBody)) {
        lastBackoffBody = attemptBody;
        break;
      }
      lastBackoffBody = attemptBody;
      console.warn(
        "Gemini transient overload, backing off:",
        aiResponse.status,
        attempt + 1,
        attemptBody.slice(0, 200),
      );
      await delay(retryAfterMsFromResponse(aiResponse, attempt));
      aiResponse = await doGeminiFetch();
    }

    // Handle non-OK responses after retries
    if (!aiResponse.ok) {
      const errText = (await aiResponse.text().catch(() => "")) || lastBackoffBody;

      if (aiResponse.status === 429) {
        const detail = parseProviderErrorMessage(errText);
        return jsonOk({
          ok: false,
          error: detail
            ? `The model provider rate-limited this request (429). ${detail} Wait and try again, or check quotas in Google AI Studio.`
            : "The model provider rate-limited this request (HTTP 429). Wait 1–2 minutes and try again.",
          code: "rate_limited",
        });
      }

      if (isTransientOverload(aiResponse.status, errText)) {
        const detail = parseProviderErrorMessage(errText);
        return jsonOk({
          ok: false,
          error: detail ?? "The model provider is temporarily overloaded. Please retry shortly.",
          code: "provider_unavailable",
        });
      }

      console.error("Gemini generateContent error:", aiResponse.status, errText.slice(0, 800));
      const hint =
        (parseProviderErrorMessage(errText) ?? errText.trim().slice(0, 400)) ||
        `HTTP ${aiResponse.status}`;
      return jsonOk({ ok: false, error: `AI generation failed: ${hint}`, code: "ai_provider" });
    }

    // -- Parse Gemini response --
    const aiData = await aiResponse.json() as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
      promptFeedback?: { blockReason?: string };
      error?: { message?: string };
    };

    if (aiData.promptFeedback?.blockReason) {
      return jsonOk({
        ok: false,
        error: `Generation blocked (${aiData.promptFeedback.blockReason}).`,
        code: "blocked",
      });
    }

    const parts = aiData.candidates?.[0]?.content?.parts ?? [];
    const rawText = parts
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("")
      .trim();

    if (!rawText) {
      return jsonOk({ ok: false, error: "No content generated by AI", code: "empty_completion" });
    }

    // -- Strip markdown fences and parse JSON --
    const cleaned = stripMarkdownFences(rawText);
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error("JSON parse failed. Raw AI output (first 500 chars):", rawText.slice(0, 500));
      return jsonOk({
        ok: false,
        error: `Failed to parse AI response as JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        code: "parse_error",
      });
    }

    if (!Array.isArray(parsed)) {
      return jsonOk({
        ok: false,
        error: "AI returned a non-array JSON value. Expected a JSON array of resume entries.",
        code: "parse_error",
      });
    }

    // -- Validate and coerce each entry --
    const entries: ResumeEntry[] = [];
    for (let i = 0; i < parsed.length; i++) {
      try {
        entries.push(coerceEntry(parsed[i], i));
      } catch (validationErr) {
        console.warn("Skipping invalid entry:", validationErr);
        // Skip malformed individual entries rather than failing the whole response
      }
    }

    if (entries.length === 0) {
      return jsonOk({
        ok: false,
        error: "No valid resume entries could be extracted from the PDF.",
        code: "no_entries",
      });
    }

    console.log(`[parse-resume] Returning ${entries.length} entries successfully`);
    return jsonOk({ ok: true, entries });
  } catch (e) {
    console.error("Unexpected error in parse-resume:", e);
    return jsonOk({
      ok: false,
      error: e instanceof Error ? e.message : "Unknown error",
      code: "unexpected",
    });
  }
});
