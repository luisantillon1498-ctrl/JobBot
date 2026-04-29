import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

/** Increment when system prompt, user template, or decoding strategy changes (stored on each artifact). */
const COVER_LETTER_GENERATOR_VERSION = "cover-letter.10";

const TONE_GUIDANCE: Record<string, string> = {
  professional:
    "Use a balanced professional tone: clear, respectful, and approachable without being stiff.",
  warm: "Use a warm, personable tone; sound genuinely enthusiastic and human while staying professional.",
  confident: "Use a confident, outcomes-focused tone; emphasize achievements and fit without arrogance.",
  concise: "Keep paragraphs short and language tight; favor clarity and directness over flourish.",
  formal: "Use a formal, traditional business tone suitable for conservative industries.",
};

const SYSTEM_MESSAGE =
  "You are an expert career coach and professional writer specializing in cover letters.";

const MAX_REFERENCE_APPLICATIONS = 5;
const PEER_COVER_LETTER_EXCERPT_CHARS = 550;

function normalizeWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2);
  return new Set(words);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter++;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Higher = stronger evidence the candidate was invited to interview (or progressed). */
function interviewProgressScore(
  applicationStatus: string,
  outcome: string | null,
  hadInterviewScheduledEvent: boolean,
): number {
  let base = 0.2;
  switch (applicationStatus) {
    case "final_round_interview":
    case "second_round_interview":
    case "first_round_interview":
      base = 1;
      break;
    case "screening":
      base = 0.65;
      break;
    case "not_started":
      base = 0.12;
      break;
    default:
      base = 0.25;
  }
  if (outcome === "offer_accepted") base = Math.max(base, 1);
  if (hadInterviewScheduledEvent) base = Math.min(1, base + 0.15);
  return base;
}

type PeerRow = {
  id: string;
  company_name: string;
  job_title: string;
  application_status: string;
  outcome: string | null;
};

type ScoredPeer = PeerRow & {
  title_sim: number;
  company_sim: number;
  role_company_similarity: number;
  interview_signal: number;
  rank_score: number;
  prior_cover_excerpt: string | null;
};

function statusNarrative(status: string, outcome: string | null): string {
  if (outcome === "offer_accepted") return "Offer accepted";
  if (outcome === "rejected") return "Closed (rejected)";
  if (outcome === "withdrew") return "Withdrawn";
  if (outcome === "ghosted") return "No response (ghosted)";
  const map: Record<string, string> = {
    not_started: "Not started / pre-screening",
    screening: "Screening / early conversations",
    first_round_interview: "Invited to interview (first round)",
    second_round_interview: "Advanced to further interview rounds",
    final_round_interview: "Late-stage interviews",
  };
  return map[status] ?? status;
}

function relevanceLine(titleSim: number, companySim: number): string {
  const role =
    titleSim >= 0.38 ? "strong role overlap" : titleSim >= 0.16 ? "moderate role overlap" : "limited role overlap";
  const co =
    companySim >= 0.32 ? "strong company/name overlap" : companySim >= 0.12 ? "some company overlap" : "different company";
  return `${role}; ${co}`;
}

function excerptFromArtifact(content: string, maxLen: number): string {
  const t = content.replace(/\s+/g, " ").trim().replace(/"""/g, '"');
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen).trim()}…`;
}

function parseUserEditFeedback(promptUsed: string | null): string | null {
  if (!promptUsed) return null;
  const marker = "feedback=";
  const idx = promptUsed.indexOf(marker);
  if (idx < 0) return null;
  const raw = promptUsed.slice(idx + marker.length).trim();
  return raw ? raw.slice(0, 600) : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** OpenAI-style JSON: { error: { message } } */
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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

/** HTTP 200 so Supabase `invoke` returns JSON in `data` (avoids opaque FunctionsHttpError). */
function jsonOk(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status: 200, headers: jsonHeaders });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) throw new Error("Not authenticated");

    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    // SUPABASE_ANON_KEY is auto-injected but shows as "deprecated" in the UI.
    // Fall back to serviceRoleKey so internal EF-to-EF calls work without the anon key.
    const clientKey = Deno.env.get("SUPABASE_ANON_KEY") || serviceRoleKey;
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      clientKey,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) throw new Error("Invalid auth");

    const body = await req.json();
    const application_id = body.application_id as string;
    const job_title = String(body.job_title ?? "").trim();
    const company_name = String(body.company_name ?? "").trim();
    const job_description = body.job_description != null ? String(body.job_description).trim() : "";
    const resume_path = body.resume_path != null ? String(body.resume_path).trim() : "";
    if (!application_id || !job_title || !company_name) throw new Error("Missing required fields");

    /** Prefer Google Gemini when GEMINI_API_KEY is set; otherwise OpenAI-compatible APIs. */
    const geminiApiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
    const openaiApiKey =
      (Deno.env.get("OPENAI_API_KEY") ?? Deno.env.get("AI_API_KEY") ?? "").trim();
    const useGemini = Boolean(geminiApiKey);
    if (!useGemini && !openaiApiKey) {
      throw new Error(
        "Set GEMINI_API_KEY and/or OPENAI_API_KEY on this Edge Function (Supabase → Edge Functions → Secrets). " +
          "If both are set, Gemini is used. OpenAI options: OPENAI_BASE_URL, OPENAI_MODEL. " +
          "Gemini options: GEMINI_MODEL (default gemini-2.5-flash).",
      );
    }
    const openaiBase = (Deno.env.get("OPENAI_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const openaiModel = (Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini").trim() || "gpt-4o-mini";
    const geminiModel = (Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash").trim() || "gemini-2.5-flash";

    // Get user's profile (tone may be missing before migration — fall back to professional)
    const { data: profile } = await supabaseClient
      .from("profiles")
      .select("full_name, cover_letter_tone")
      .eq("user_id", user.id)
      .single();

    const applicantName = (profile?.full_name ?? "Job Applicant").trim() || "Job Applicant";
    const rawTone =
      profile && typeof (profile as { cover_letter_tone?: string }).cover_letter_tone === "string"
        ? (profile as { cover_letter_tone: string }).cover_letter_tone.trim()
        : "professional";
    const toneKey = TONE_GUIDANCE[rawTone] ? rawTone : "professional";
    const toneInstruction = TONE_GUIDANCE[toneKey] ?? TONE_GUIDANCE.professional;
    const jobDescriptionBlock = job_description
      ? `Job Description:\n${job_description}`
      : "Job Description:\n(none provided)";
    const resumeBlock = resume_path
      ? `Resume file (storage path):\n${resume_path}`
      : "Resume file (storage path):\n(none linked)";

    const currentTitleTokens = normalizeWords(job_title);
    const currentCompanyTokens = normalizeWords(company_name);

    const { data: peerAppsRaw } = await supabaseClient
      .from("applications")
      .select("id, company_name, job_title, application_status, outcome")
      .eq("user_id", user.id)
      .neq("id", application_id)
      .order("updated_at", { ascending: false })
      .limit(100);

    const peerRows = (peerAppsRaw ?? []) as PeerRow[];
    const peerIds = peerRows.map((p) => p.id);

    let interviewEventIds = new Set<string>();
    if (peerIds.length > 0) {
      const { data: evRows } = await supabaseClient
        .from("application_events")
        .select("application_id")
        .eq("event_type", "interview_scheduled")
        .in("application_id", peerIds);
      interviewEventIds = new Set((evRows ?? []).map((e: { application_id: string }) => e.application_id));
    }

    const scored: ScoredPeer[] = peerRows.map((p) => {
      const title_sim = jaccardSimilarity(currentTitleTokens, normalizeWords(p.job_title));
      const company_sim = jaccardSimilarity(currentCompanyTokens, normalizeWords(p.company_name));
      const role_company_similarity = title_sim * 0.55 + company_sim * 0.45;
      const interview_signal = interviewProgressScore(
        p.application_status,
        p.outcome,
        interviewEventIds.has(p.id),
      );
      // Primary: similar role/company × interview progress. Small additive term so strong interview
      // signal still surfaces useful context when lexical overlap is low.
      const rank_score = role_company_similarity * interview_signal + 0.12 * interview_signal;
      return {
        ...p,
        title_sim,
        company_sim,
        role_company_similarity,
        interview_signal,
        rank_score,
        prior_cover_excerpt: null,
      };
    });

    scored.sort((a, b) => {
      if (b.rank_score !== a.rank_score) return b.rank_score - a.rank_score;
      return a.id.localeCompare(b.id);
    });

    const topPeers = scored.slice(0, MAX_REFERENCE_APPLICATIONS);
    const topIds = topPeers.map((p) => p.id);

    const latestCoverByApp = new Map<string, string>();
    if (topIds.length > 0) {
      const { data: artRows } = await supabaseClient
        .from("generated_artifacts")
        .select("application_id, content, created_at")
        .eq("type", "cover_letter")
        .in("application_id", topIds)
        .order("created_at", { ascending: false });
      for (const row of artRows ?? []) {
        const aid = row.application_id as string;
        if (!latestCoverByApp.has(aid)) latestCoverByApp.set(aid, row.content as string);
      }
    }

    for (const p of topPeers) {
      const full = latestCoverByApp.get(p.id);
      p.prior_cover_excerpt = full ? excerptFromArtifact(full, PEER_COVER_LETTER_EXCERPT_CHARS) : null;
    }

    const peer_snapshot = topPeers.map((p) => ({
      id: p.id,
      ts: Math.round(p.title_sim * 1e4) / 1e4,
      cs: Math.round(p.company_sim * 1e4) / 1e4,
      iv: Math.round(p.interview_signal * 1e4) / 1e4,
      rs: Math.round(p.rank_score * 1e4) / 1e4,
      ex: p.prior_cover_excerpt ? 1 : 0,
    }));

    const referenceBlock =
      topPeers.length === 0
        ? ""
        : `\n## Your other applications (context only)\nThese are your own past applications, ranked by (1) similarity of role and company to this target and (2) how far you progressed toward interviews. Use them to reuse *themes*, *proof points*, and *tone* that fit this new role. Do not copy wording verbatim, do not invent employers you did not apply to, and do not name past employers unless it genuinely strengthens this letter.\n\n${topPeers
            .map((p, i) => {
              const lines = [
                `### ${i + 1}. ${p.company_name} — ${p.job_title}`,
                `- Your tracker: ${statusNarrative(p.application_status, p.outcome)}`,
                `- Relevance vs this application: ${relevanceLine(p.title_sim, p.company_sim)}; interview signal weighted higher when you reached interview stages.`,
              ];
              if (p.prior_cover_excerpt) {
                lines.push(
                  `- Prior cover letter you generated for that application (excerpt for style only; do not paste): ${p.prior_cover_excerpt}`,
                );
              }
              return lines.join("\n");
            })
            .join("\n\n")}\n`;

    const { data: editedRows } = await supabaseClient
      .from("generated_artifacts")
      .select("content, prompt_used, created_at")
      .eq("user_id", user.id)
      .eq("type", "cover_letter")
      .like("generator_version", "user-edit.%")
      .order("created_at", { ascending: false })
      .limit(6);

    const feedbackPoints = (editedRows ?? [])
      .map((r) => parseUserEditFeedback((r as { prompt_used: string | null }).prompt_used))
      .filter((x): x is string => Boolean(x));
    const dedupedFeedback = [...new Set(feedbackPoints)].slice(0, 5);
    const feedbackBlock =
      dedupedFeedback.length > 0
        ? `\n## User feedback from prior cover-letter edits\nApply these preferences where relevant:\n${dedupedFeedback
            .map((f, i) => `- ${i + 1}. ${f}`)
            .join("\n")}\n`
        : "";

    const referenceFingerprintBuf = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(referenceBlock),
    );
    const reference_fingerprint = [...new Uint8Array(referenceFingerprintBuf)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);

    const prompt = `Write a professional cover letter for the following job application.

Applicant: ${applicantName}
Company: ${company_name}
Position: ${job_title}
${jobDescriptionBlock}
${resumeBlock}
${referenceBlock}
${feedbackBlock}
Voice and tone: ${toneInstruction}

Write a compelling cover letter (typically 3-4 paragraphs) that:
- Opens with enthusiasm for the specific role
- Highlights relevant skills and experience
- Shows knowledge of the company
- Closes with a strong call to action
- Follows the voice and tone guidance above
- Where helpful, aligns emphasis with what worked in similar roles/companies from the reference applications above (without copying text)

Return only the cover letter text, no headers or metadata.`;

    const seedMaterial = JSON.stringify({
      v: COVER_LETTER_GENERATOR_VERSION,
      system: SYSTEM_MESSAGE,
      applicant: applicantName,
      cover_letter_tone: toneKey,
      company_name,
      job_title,
      job_description,
      resume_path,
      peer_snapshot,
      reference_fingerprint,
      user_feedback_points: dedupedFeedback,
    });
    const seedBytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seedMaterial)),
    );
    const seed = new DataView(seedBytes.buffer).getUint32(0, false) & 0x7fffffff;

    let content: string;
    let usedGemini = useGemini;

    if (usedGemini) {
      const geminiUrl =
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}` +
        `:generateContent?key=${encodeURIComponent(geminiApiKey)}`;

      let geminiUseSeed = true;
      const buildGeminiPayload = (includeSeed: boolean) =>
        JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_MESSAGE }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            topP: 1,
            maxOutputTokens: 8192,
            ...(includeSeed ? { seed } : {}),
          },
        });

      const doGeminiFetch = () =>
        fetch(geminiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: buildGeminiPayload(geminiUseSeed),
        });

      let aiResponse = await doGeminiFetch();

      if (!aiResponse.ok && (aiResponse.status === 400 || aiResponse.status === 422) && geminiUseSeed) {
        await aiResponse.text().catch(() => "");
        geminiUseSeed = false;
        aiResponse = await doGeminiFetch();
      }

      let lastBackoffBody = "";
      for (let rateAttempt = 0; !aiResponse.ok && rateAttempt < 3; rateAttempt++) {
        const attemptBody = await aiResponse.text().catch(() => "");
        if (!isTransientOverload(aiResponse.status, attemptBody)) {
          lastBackoffBody = attemptBody;
          break;
        }
        lastBackoffBody = attemptBody;
        console.warn("Gemini transient overload, backing off:", aiResponse.status, rateAttempt + 1, attemptBody.slice(0, 200));
        await delay(retryAfterMsFromResponse(aiResponse, rateAttempt));
        aiResponse = await doGeminiFetch();
      }

      if (!aiResponse.ok) {
        const errText = (await aiResponse.text().catch(() => "")) || lastBackoffBody;
        if (isTransientOverload(aiResponse.status, errText) && openaiApiKey) {
          console.warn("Gemini unavailable; falling back to OpenAI-compatible provider");
          usedGemini = false;
        } else if (aiResponse.status === 429) {
          const detail = parseProviderErrorMessage(errText);
          return jsonOk({
            ok: false,
            error:
              (detail
                ? `The model provider rate-limited this request (429). ${detail} Wait and try again, or check quotas in Google AI Studio / Cloud.`
                : "The model provider rate-limited this request (HTTP 429). Wait 1–2 minutes and try again."),
            code: "rate_limited",
          });
        } else if (isTransientOverload(aiResponse.status, errText)) {
          const detail = parseProviderErrorMessage(errText);
          return jsonOk({
            ok: false,
            error:
              detail ??
              "The model provider is temporarily overloaded. Please retry shortly.",
            code: "provider_unavailable",
          });
        } else {
          console.error("Gemini generateContent error:", aiResponse.status, errText.slice(0, 800));
          const hint =
            (parseProviderErrorMessage(errText) ?? errText.trim().slice(0, 400)) || `HTTP ${aiResponse.status}`;
          return jsonOk({ ok: false, error: `AI generation failed: ${hint}`, code: "ai_provider" });
        }
      }

      if (usedGemini) {
        const aiData = await aiResponse.json() as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
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
        const textOut = parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("").trim();
        if (!textOut) {
          return jsonOk({ ok: false, error: "No content generated", code: "empty_completion" });
        }
        content = textOut;
      }
    }

    if (!usedGemini) {
      if (!openaiApiKey) {
        return jsonOk({
          ok: false,
          error: "Gemini is temporarily unavailable and no OPENAI_API_KEY fallback is configured.",
          code: "provider_unavailable",
        });
      }
      const chatUrl = `${openaiBase}/chat/completions`;
      const chatHeaders = {
        Authorization: `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      };
      const chatMessages = [
        { role: "system" as const, content: SYSTEM_MESSAGE },
        { role: "user" as const, content: prompt },
      ];
      const buildBody = (extra: Record<string, unknown>) =>
        JSON.stringify({ model: openaiModel, ...extra });

      let useSeed = true;
      const doChatFetch = () =>
        fetch(chatUrl, {
          method: "POST",
          headers: chatHeaders,
          body: buildBody({
            messages: chatMessages,
            temperature: 0,
            top_p: 1,
            ...(useSeed ? { seed } : {}),
          }),
        });

      let aiResponse = await doChatFetch();

      if (!aiResponse.ok && (aiResponse.status === 400 || aiResponse.status === 422) && useSeed) {
        await aiResponse.text().catch(() => "");
        useSeed = false;
        aiResponse = await doChatFetch();
      }

      let last429Body = "";
      for (let rateAttempt = 0; !aiResponse.ok && aiResponse.status === 429 && rateAttempt < 3; rateAttempt++) {
        last429Body = await aiResponse.text().catch(() => "");
        console.warn("LLM 429, backing off:", rateAttempt + 1, last429Body.slice(0, 200));
        await delay(retryAfterMsFromResponse(aiResponse, rateAttempt));
        aiResponse = await doChatFetch();
      }

      if (!aiResponse.ok) {
        const errText =
          aiResponse.status === 429
            ? ((await aiResponse.text().catch(() => "")) || last429Body)
            : await aiResponse.text().catch(() => "");
        if (aiResponse.status === 429) {
          const detail = parseProviderErrorMessage(errText);
          return jsonOk({
            ok: false,
            error:
              (detail
                ? `The model provider rate-limited this request (429). ${detail} Wait a minute and try again, or check usage limits / billing in your OpenAI (or other) dashboard.`
                : "The model provider rate-limited this request (HTTP 429). Wait 1–2 minutes and try again, or check your API usage tier and billing."),
            code: "rate_limited",
          });
        }
        console.error("OpenAI-compatible chat/completions error:", aiResponse.status, errText.slice(0, 800));
        const hint =
          (parseProviderErrorMessage(errText) ?? errText.trim().slice(0, 400)) || `HTTP ${aiResponse.status}`;
        return jsonOk({ ok: false, error: `AI generation failed: ${hint}`, code: "ai_provider" });
      }

      const aiData = await aiResponse.json();
      const openaiContent = aiData.choices?.[0]?.message?.content;
      if (!openaiContent) {
        return jsonOk({ ok: false, error: "No content generated", code: "empty_completion" });
      }
      content = openaiContent;
    }

    // Save artifact (retry without generator_version if DB migration not applied yet)
    const insertPayload = {
      application_id,
      user_id: user.id,
      type: "cover_letter" as const,
      content,
      prompt_used: prompt,
      generator_version: COVER_LETTER_GENERATOR_VERSION,
    };
    let { error: insertError } = await supabaseClient.from("generated_artifacts").insert(insertPayload);
    if (insertError) {
      const em = `${insertError.message ?? ""} ${(insertError as { details?: string }).details ?? ""}`;
      const missingGenCol =
        /generator_version/i.test(em) &&
        (/column|schema|could not find|does not exist/i.test(em) || (insertError as { code?: string }).code === "PGRST204");
      if (missingGenCol) {
        const { generator_version: _v, ...rest } = insertPayload;
        ({ error: insertError } = await supabaseClient.from("generated_artifacts").insert(rest));
      }
    }
    if (insertError) {
      return jsonOk({
        ok: false,
        error: insertError.message || "Could not save cover letter",
        code: "db_insert",
      });
    }

    // Log event
    const { error: eventErr } = await supabaseClient.from("application_events").insert({
      application_id,
      user_id: user.id,
      event_type: "document_generated",
      description: "Cover letter generated with AI",
    });
    if (eventErr) {
      console.warn("application_events insert:", eventErr);
    }

    return jsonOk({
      ok: true,
      content,
      generator_version: COVER_LETTER_GENERATOR_VERSION,
    });
  } catch (e) {
    console.error("Error:", e);
    return jsonOk({
      ok: false,
      error: e instanceof Error ? e.message : "Unknown error",
      code: "unexpected",
    });
  }
});
