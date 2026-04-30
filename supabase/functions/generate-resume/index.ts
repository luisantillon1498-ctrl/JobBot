import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ANTHROPIC_MODEL_DEFAULT = "claude-opus-4-5";
const GEMINI_MODEL_DEFAULT = "gemini-2.5-flash";
const RESUME_GENERATOR_VERSION = "resume.1";

const SYSTEM_MESSAGE =
  "You are an expert resume writer. Given a job description and the candidate's resume data, select and tailor the most relevant experience, academics, and skills to maximize interview likelihood. Return ONLY a valid JSON object with no markdown fencing.";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ResumeFeatureRow {
  id: string;
  user_id: string;
  feature_type: "professional_experience" | "academics" | "extracurriculars" | "skills_and_certifications" | "personal";
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

interface ProfileRow {
  full_name: string | null;
  professional_email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  city: string | null;
  state_region: string | null;
  country: string | null;
  resume_wizard_page_limit: number | null;
}

interface ApplicationRow {
  id: string;
  user_id: string;
  company_name: string;
  job_title: string;
  job_description: string | null;
  submitted_resume_document_id?: string | null;
}

interface SelectedExperience {
  role_title: string;
  company_name: string;
  location: string;
  from_date: string;
  to_date: string;
  bullets: string[];
}

interface SelectedAcademic {
  degree: string;
  major: string;
  school: string;
  location: string;
  from_date: string;
  to_date: string;
  bullets: string[];
}

interface SelectedSkill {
  category: string;
  bullets: string[];
}

interface SelectedExtracurricular {
  role_title: string;
  organization: string;
  location: string;
  from_date: string;
  to_date: string;
  bullets: string[];
}

interface AIResponse {
  selected_experience: SelectedExperience[];
  selected_academics: SelectedAcademic[];
  selected_extracurriculars: SelectedExtracurricular[];
  selected_skills: SelectedSkill[];
  personal_interests: string;
}

function buildHeuristicResumeSelection(features: ResumeFeatureRow[]): AIResponse {
  const byType = {
    professional_experience: [] as ResumeFeatureRow[],
    academics: [] as ResumeFeatureRow[],
    extracurriculars: [] as ResumeFeatureRow[],
    skills_and_certifications: [] as ResumeFeatureRow[],
    personal: [] as ResumeFeatureRow[],
  };
  for (const f of features) {
    byType[f.feature_type].push(f);
  }

  const selected_experience: SelectedExperience[] = byType.professional_experience
    .slice(0, 4)
    .map((f) => ({
      role_title: f.role_title || "Experience",
      company_name: f.company || "",
      location: f.location || "",
      from_date: f.from_date ?? "",
      to_date: f.to_date ?? "",
      bullets: Array.isArray(f.description_lines) ? f.description_lines.filter(Boolean).slice(0, 4) : [],
    }));

  const selected_academics: SelectedAcademic[] = byType.academics.map((f) => ({
    degree: f.degree || "",
    major: f.major || "",
    school: f.company || "",
    location: f.location || "",
    from_date: f.from_date ?? "",
    to_date: f.to_date ?? "",
    bullets: Array.isArray(f.description_lines) ? f.description_lines.filter(Boolean).slice(0, 3) : [],
  }));

  const selected_skills: SelectedSkill[] = byType.skills_and_certifications.map((f) => ({
    category: f.role_title?.trim() || "Skills",
    bullets: (Array.isArray(f.description_lines) ? f.description_lines.filter(Boolean) : []).slice(0, 8),
  }));

  const selected_extracurriculars: SelectedExtracurricular[] = byType.extracurriculars.map((f) => ({
    role_title: f.role_title || "",
    organization: f.company || "",
    location: f.location || "",
    from_date: f.from_date ?? "",
    to_date: f.to_date ?? "",
    bullets: Array.isArray(f.description_lines) ? f.description_lines.filter(Boolean).slice(0, 3) : [],
  }));

  const personal_interests = byType.personal
    .flatMap((f) => [f.role_title, ...(Array.isArray(f.description_lines) ? f.description_lines : [])])
    .map((v) => (v ?? "").trim())
    .filter(Boolean)
    .join(", ");

  return {
    selected_experience,
    selected_academics,
    selected_extracurriculars,
    selected_skills,
    personal_interests,
  };
}

function applyResumePageLimitSelection(input: AIResponse, pageLimit: number): AIResponse {
  if (pageLimit >= 3) return input;
  if (pageLimit === 2) {
    return {
      ...input,
      selected_experience: input.selected_experience.slice(0, 5).map((e) => ({ ...e, bullets: e.bullets.slice(0, 4) })),
      selected_academics: input.selected_academics.slice(0, 3).map((a) => ({ ...a, bullets: a.bullets.slice(0, 3) })),
      selected_extracurriculars: input.selected_extracurriculars.slice(0, 2).map((x) => ({ ...x, bullets: x.bullets.slice(0, 2) })),
      selected_skills: input.selected_skills.slice(0, 4).map((s) => ({ ...s, bullets: s.bullets.slice(0, 6) })),
    };
  }
  return {
    ...input,
    selected_experience: input.selected_experience.slice(0, 4).map((e) => ({ ...e, bullets: e.bullets.slice(0, 3) })),
    selected_academics: input.selected_academics.slice(0, 2).map((a) => ({ ...a, bullets: a.bullets.slice(0, 1) })),
    selected_extracurriculars: input.selected_extracurriculars.slice(0, 2).map((x) => ({ ...x, bullets: x.bullets.slice(0, 1) })),
    selected_skills: input.selected_skills.slice(0, 4).map((s) => ({ ...s, bullets: s.bullets.slice(0, 5) })),
    personal_interests: (input.personal_interests ?? "").slice(0, 240),
  };
}

// ---------------------------------------------------------------------------
// CORS / response helpers
// ---------------------------------------------------------------------------

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

function jsonOk(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status: 200, headers: jsonHeaders });
}

// ---------------------------------------------------------------------------
// Retry helpers (same pattern as generate-cover-letter)
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
// JSON parsing — strip markdown fences if present
// ---------------------------------------------------------------------------

function parseAIJson(raw: string): AIResponse {
  let cleaned = raw.trim();
  // Strip ```json ... ``` or ``` ... ``` wrappers
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  return JSON.parse(cleaned) as AIResponse;
}

// ---------------------------------------------------------------------------
// Outcome / peer-learning helpers (mirrors generate-cover-letter logic)
// ---------------------------------------------------------------------------

function normalizeWords(text: string): Set<string> {
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
  return new Set(words);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) { if (b.has(x)) inter++; }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function interviewProgressScore(
  applicationStatus: string,
  outcome: string | null,
  hadInterviewEvent: boolean,
): number {
  let base = 0.2;
  switch (applicationStatus) {
    case "final_round_interview":
    case "second_round_interview":
    case "first_round_interview": base = 1; break;
    case "screening": base = 0.65; break;
    case "not_started": base = 0.12; break;
    default: base = 0.25;
  }
  if (outcome === "offer_accepted") base = Math.max(base, 1);
  if (hadInterviewEvent) base = Math.min(1, base + 0.15);
  return base;
}

function statusNarrative(status: string, outcome: string | null): string {
  if (outcome === "offer_accepted") return "Offer accepted";
  if (outcome === "rejected") return "Closed (rejected)";
  if (outcome === "withdrew") return "Withdrawn";
  if (outcome === "ghosted") return "No response (ghosted)";
  const map: Record<string, string> = {
    not_started: "Not started",
    screening: "Screening / early conversations",
    first_round_interview: "Invited to interview (first round)",
    second_round_interview: "Advanced to further rounds",
    final_round_interview: "Late-stage interviews",
  };
  return map[status] ?? status;
}

// ---------------------------------------------------------------------------
// AI call: Anthropic (primary)
// ---------------------------------------------------------------------------

async function callAnthropic(
  apiKey: string,
  model: string,
  userPrompt: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string; code: string }> {
  const url = "https://api.anthropic.com/v1/messages";
  const headers = {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  };
  const buildBody = () =>
    JSON.stringify({
      model,
      max_tokens: 4096,
      system: SYSTEM_MESSAGE,
      messages: [{ role: "user", content: userPrompt }],
    });

  const doFetch = () => fetch(url, { method: "POST", headers, body: buildBody() });

  let res = await doFetch();

  // Retry on transient overload (up to 3 times)
  let lastErrBody = "";
  for (let attempt = 0; !res.ok && attempt < 3; attempt++) {
    const errText = await res.text().catch(() => "");
    if (!isTransientOverload(res.status, errText)) {
      lastErrBody = errText;
      break;
    }
    lastErrBody = errText;
    console.warn(`Anthropic transient error (${res.status}), backoff attempt ${attempt + 1}:`, errText.slice(0, 200));
    await delay(retryAfterMsFromResponse(res, attempt));
    res = await doFetch();
  }

  if (!res.ok) {
    const errText = (await res.text().catch(() => "")) || lastErrBody;
    if (res.status === 429) {
      const detail = parseProviderErrorMessage(errText);
      return {
        ok: false,
        error: detail
          ? `Anthropic rate-limited this request (429). ${detail} Wait and try again.`
          : "Anthropic rate-limited this request (429). Wait 1–2 minutes and try again.",
        code: "rate_limited",
      };
    }
    if (isTransientOverload(res.status, errText)) {
      return {
        ok: false,
        error: parseProviderErrorMessage(errText) ?? "Anthropic is temporarily overloaded. Please retry shortly.",
        code: "provider_unavailable",
      };
    }
    console.error("Anthropic error:", res.status, errText.slice(0, 800));
    const hint = (parseProviderErrorMessage(errText) ?? errText.trim().slice(0, 400)) || `HTTP ${res.status}`;
    return { ok: false, error: `AI generation failed: ${hint}`, code: "ai_provider" };
  }

  const data = await res.json() as {
    content?: Array<{ type: string; text?: string }>;
    error?: { message?: string };
  };
  const text = data.content?.find((c) => c.type === "text")?.text ?? "";
  if (!text.trim()) {
    return { ok: false, error: "No content returned by Anthropic", code: "empty_completion" };
  }
  return { ok: true, text };
}

// ---------------------------------------------------------------------------
// AI call: Gemini (fallback)
// ---------------------------------------------------------------------------

async function callGemini(
  apiKey: string,
  model: string,
  userPrompt: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string; code: string }> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
    `:generateContent?key=${encodeURIComponent(apiKey)}`;
  const buildBody = () =>
    JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_MESSAGE }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0, topP: 1, maxOutputTokens: 4096 },
    });

  const doFetch = () =>
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: buildBody() });

  let res = await doFetch();

  let lastErrBody = "";
  for (let attempt = 0; !res.ok && attempt < 3; attempt++) {
    const errText = await res.text().catch(() => "");
    if (!isTransientOverload(res.status, errText)) {
      lastErrBody = errText;
      break;
    }
    lastErrBody = errText;
    console.warn(`Gemini transient error (${res.status}), backoff attempt ${attempt + 1}:`, errText.slice(0, 200));
    await delay(retryAfterMsFromResponse(res, attempt));
    res = await doFetch();
  }

  if (!res.ok) {
    const errText = (await res.text().catch(() => "")) || lastErrBody;
    if (res.status === 429) {
      const detail = parseProviderErrorMessage(errText);
      return {
        ok: false,
        error: detail
          ? `Gemini rate-limited this request (429). ${detail} Wait and try again.`
          : "Gemini rate-limited this request (429). Wait 1–2 minutes and try again.",
        code: "rate_limited",
      };
    }
    if (isTransientOverload(res.status, errText)) {
      return {
        ok: false,
        error: parseProviderErrorMessage(errText) ?? "Gemini is temporarily overloaded. Please retry shortly.",
        code: "provider_unavailable",
      };
    }
    console.error("Gemini error:", res.status, errText.slice(0, 800));
    const hint = (parseProviderErrorMessage(errText) ?? errText.trim().slice(0, 400)) || `HTTP ${res.status}`;
    return { ok: false, error: `AI generation failed (Gemini): ${hint}`, code: "ai_provider" };
  }

  const data = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    promptFeedback?: { blockReason?: string };
  };

  if (data.promptFeedback?.blockReason) {
    return { ok: false, error: `Generation blocked by Gemini (${data.promptFeedback.blockReason}).`, code: "blocked" };
  }

  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("").trim();
  if (!text) {
    return { ok: false, error: "No content returned by Gemini", code: "empty_completion" };
  }
  return { ok: true, text };
}

// ---------------------------------------------------------------------------
// HTML resume builder
// ---------------------------------------------------------------------------

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  // dateStr may be a date string like "2023-05-01" or "2023-05"
  try {
    const d = new Date(dateStr + (dateStr.length <= 7 ? "-01" : ""));
    return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  } catch {
    return dateStr;
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildResumeHtml(
  profile: { name: string; email: string; phone: string; location: string; linkedin: string },
  aiData: AIResponse,
): string {
  const sectionHeader = (title: string) =>
    `<div class="section-header"><span>${esc(title)}</span><hr /></div>`;

  const dateLine = (from: string | null, to: string | null): string => {
    const f = from ? formatDate(from) : "";
    const t = to ? formatDate(to) : "Present";
    if (!f && !t) return "";
    if (!f) return esc(t);
    return `${esc(f)} – ${esc(t)}`;
  };

  // Experience section
  const experienceHtml = aiData.selected_experience.length === 0
    ? ""
    : `
    ${sectionHeader("EXPERIENCE")}
    ${aiData.selected_experience
      .map(
        (e) => `
      <div class="entry">
        <div class="entry-header">
          <span class="entry-title">${esc(e.role_title)}</span>
          <span class="entry-date">${dateLine(e.from_date, e.to_date)}</span>
        </div>
        <div class="entry-sub">${esc([e.company_name, e.location].filter(Boolean).join(" • "))}</div>
        ${
          e.bullets.length > 0
            ? `<ul>${e.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`
            : ""
        }
      </div>`,
      )
      .join("")}`;

  // Academics section
  const academicsHtml = aiData.selected_academics.length === 0
    ? ""
    : `
    ${sectionHeader("EDUCATION")}
    ${aiData.selected_academics
      .map(
        (a) => `
      <div class="entry">
        <div class="entry-header">
          <span class="entry-title">${esc([a.degree, a.major].filter(Boolean).join(", "))}</span>
          <span class="entry-date">${dateLine(a.from_date, a.to_date)}</span>
        </div>
        <div class="entry-sub">${esc([a.school, a.location].filter(Boolean).join(" • "))}</div>
        ${
          a.bullets.length > 0
            ? `<ul>${a.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`
            : ""
        }
      </div>`,
      )
      .join("")}`;

  // Extracurricular section
  const extracurricularHtml = aiData.selected_extracurriculars.length === 0
    ? ""
    : `
    ${sectionHeader("COMMUNITY")}
    ${aiData.selected_extracurriculars
      .map(
        (x) => `
      <div class="entry">
        <div class="entry-header">
          <span class="entry-title">${esc(x.role_title || x.organization)}</span>
          <span class="entry-date">${dateLine(x.from_date, x.to_date)}</span>
        </div>
        <div class="entry-sub">${esc([x.organization, x.location].filter(Boolean).join(" • "))}</div>
        ${
          x.bullets.length > 0
            ? `<ul>${x.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`
            : ""
        }
      </div>`,
      )
      .join("")}`;

  // Skills section
  const skillsHtml = aiData.selected_skills.length === 0
    ? ""
    : `
    ${sectionHeader("SKILLS & CERTIFICATIONS")}
    <div class="skills-grid">
      ${aiData.selected_skills
        .map(
          (s) => `
        <div class="skill-category">
          <span class="skill-label">${esc(s.category)}:</span>
          <span class="skill-items">${s.bullets.map((b) => esc(b)).join(", ")}</span>
        </div>`,
        )
        .join("")}
    </div>`;

  // Personal interests
  const interestsHtml =
    aiData.personal_interests && aiData.personal_interests.trim()
      ? `
    ${sectionHeader("PERSONAL INTERESTS")}
    <p class="interests">${esc(aiData.personal_interests.trim())}</p>`
      : "";

  // Contact line pieces (only include non-empty)
  const contactParts = [
    profile.email,
    profile.phone,
    profile.location,
    profile.linkedin,
  ].filter(Boolean);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Resume – ${esc(profile.name)}</title>
  <style>
    /* Reset */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Times New Roman', Times, serif;
      font-size: 10pt;
      color: #000;
      background: #fff;
      padding: .5in;
      line-height: 1.2;
    }

    /* Header */
    .resume-name {
      font-size: 10pt;
      font-weight: bold;
      text-transform: uppercase;
      text-align: center;
      letter-spacing: 0.04em;
      margin-bottom: 1pt;
    }

    .resume-contact {
      text-align: center;
      font-size: 10pt;
      color: #000;
      margin-bottom: 2pt;
    }

    .resume-contact a {
      color: #000;
      text-decoration: none;
    }

    /* Section headers */
    .section-header {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 7pt;
      margin-bottom: 3pt;
    }

    .section-header span {
      font-weight: bold;
      font-size: 10pt;
      letter-spacing: 0.08em;
      white-space: nowrap;
    }

    .section-header hr {
      flex: 1;
      border: none;
      border-top: 1px solid #111;
    }

    /* Entry */
    .entry {
      margin-bottom: 3pt;
    }

    .entry-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
    }

    .entry-title {
      font-weight: bold;
      font-size: 10pt;
    }

    .entry-date {
      font-size: 10pt;
      color: #333;
      white-space: nowrap;
      margin-left: 8px;
    }

    .entry-sub {
      font-size: 10pt;
      color: #333;
      margin-bottom: 1pt;
    }

    ul {
      margin-left: 13pt;
      margin-top: 1pt;
    }

    ul li {
      font-size: 10pt;
      margin-bottom: 0;
    }

    /* Skills */
    .skills-grid {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .skill-category {
      font-size: 10pt;
    }

    .skill-label {
      font-weight: bold;
    }

    .skill-items {
      color: #111;
    }

    /* Interests */
    .interests {
      font-size: 10pt;
      color: #000;
    }
    @page { size: letter; margin: 0; }
  </style>
</head>
<body>
  <div class="resume-name">${esc(profile.name)}</div>
  <div class="resume-contact">${contactParts
    .map((p) => {
      if (p.startsWith("http") || p.includes("linkedin")) {
        return `<a href="${esc(p)}" target="_blank">${esc(p)}</a>`;
      }
      return esc(p);
    })
    .join(" &nbsp;|&nbsp; ")}</div>

  ${experienceHtml}
  ${academicsHtml}
  ${extracurricularHtml}
  ${skillsHtml}
  ${interestsHtml}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    // --- Auth ---
    const authHeader = req.headers.get("authorization");
    if (!authHeader) throw new Error("Not authenticated");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    // SUPABASE_ANON_KEY is auto-injected by Supabase but shows as "deprecated" in the UI.
    // Fall back to serviceRoleKey so internal EF-to-EF calls (which pass a user JWT in
    // the Authorization header) continue to work even if the anon key isn't resolvable.
    const clientKey = Deno.env.get("SUPABASE_ANON_KEY") || serviceRoleKey;

    // User-scoped client — auth.getUser() validates the Bearer JWT in the Authorization header
    // regardless of which API key was used to create the client.
    const userClient = createClient(supabaseUrl, clientKey, {
      global: { headers: { Authorization: authHeader } },
    });

    // Service-role client (bypasses RLS, used for storage upload)
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) throw new Error("Invalid auth");

    // --- Parse request ---
    const body = await req.json();
    const application_id = String(body.application_id ?? "").trim();
    if (!application_id) {
      return jsonOk({ ok: false, error: "Missing required field: application_id", code: "bad_request" });
    }

    // --- Environment variables ---
    const anthropicApiKey = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
    const geminiApiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
    const anthropicModel = (Deno.env.get("ANTHROPIC_MODEL") ?? ANTHROPIC_MODEL_DEFAULT).trim() || ANTHROPIC_MODEL_DEFAULT;
    const geminiModel = (Deno.env.get("GEMINI_MODEL") ?? GEMINI_MODEL_DEFAULT).trim() || GEMINI_MODEL_DEFAULT;
    const runnerUrl = (Deno.env.get("JOBPAL_AUTOMATION_RUNNER_URL") ?? "").replace(/\/$/, "");
    // Accept either base URL or /run endpoint in env, mirroring queue handoff behavior.
    // Example:
    // - https://runner.example.com/run   -> https://runner.example.com
    // - https://runner.example.com       -> https://runner.example.com
    const runnerBaseUrl = runnerUrl.replace(/\/run\/?$/, "");
    const runnerToken = (Deno.env.get("JOBPAL_AUTOMATION_RUNNER_TOKEN") ?? "").trim();

    if (!geminiApiKey && !anthropicApiKey) {
      return jsonOk({
        ok: false,
        error: "Neither GEMINI_API_KEY nor ANTHROPIC_API_KEY is configured. Set at least one secret on this Edge Function.",
        code: "config_error",
      });
    }
    if (!runnerUrl) {
      return jsonOk({
        ok: false,
        error: "JOBPAL_AUTOMATION_RUNNER_URL is not configured.",
        code: "config_error",
      });
    }

    // --- Fetch application ---
    const { data: appRow, error: appErr } = await userClient
      .from("applications")
      .select("id, user_id, company_name, job_title, job_description, submitted_resume_document_id")
      .eq("id", application_id)
      .single();

    if (appErr || !appRow) {
      return jsonOk({
        ok: false,
        error: appErr?.message ?? "Application not found",
        code: "not_found",
      });
    }
    const app = appRow as ApplicationRow;

    // Idempotency guard: if this application already has a usable resume document, reuse it.
    if (app.submitted_resume_document_id) {
      const existingDoc = await userClient
        .from("documents")
        .select("id, file_path")
        .eq("id", app.submitted_resume_document_id)
        .eq("user_id", user.id)
        .eq("type", "resume")
        .maybeSingle();
      if (existingDoc.data?.id && existingDoc.data.file_path) {
        return jsonOk({
          ok: true,
          storage_path: existingDoc.data.file_path,
          document_id: existingDoc.data.id,
          generator_version: RESUME_GENERATOR_VERSION,
          generation_mode: "existing_reuse",
        });
      }
    }

    // --- Fetch profile ---
    const { data: profileRow } = await userClient
      .from("profiles")
      .select("full_name, professional_email, phone, linkedin_url, city, state_region, country, resume_wizard_page_limit")
      .eq("user_id", user.id)
      .single();

    const profile = profileRow as ProfileRow | null;

    // Get user email from auth if professional_email not set
    const authEmail = user.email ?? "";
    const email = profile?.professional_email?.trim() || authEmail;
    const phone = profile?.phone?.trim() ?? "";
    const linkedin = profile?.linkedin_url?.trim() ?? "";
    const locationParts = [profile?.city, profile?.state_region, profile?.country].filter(Boolean);
    const location = locationParts.join(", ");
    const fullName = profile?.full_name?.trim() || "Resume";
    const pageLimit = Math.min(3, Math.max(1, Number(profile?.resume_wizard_page_limit ?? 1)));

    // --- Fetch resume_features ---
    const { data: featuresRaw, error: featErr } = await userClient
      .from("resume_features")
      .select("id, user_id, feature_type, role_title, company, location, degree, major, from_date, to_date, description_lines, sort_order")
      .eq("user_id", user.id)
      .order("feature_type", { ascending: true })
      .order("sort_order", { ascending: true });

    if (featErr) {
      return jsonOk({ ok: false, error: `Failed to fetch resume features: ${featErr.message}`, code: "db_error" });
    }

    const features = (featuresRaw ?? []) as ResumeFeatureRow[];

    // ---------------------------------------------------------------------------
    // Peer-learning: fetch past applications with outcomes to inform selection
    // ---------------------------------------------------------------------------
    const currentTitleTokens = normalizeWords(app.job_title);
    const currentCompanyTokens = normalizeWords(app.company_name);
    const MAX_PEER_APPLICATIONS = 4;

    const { data: peerAppsRaw } = await userClient
      .from("applications")
      .select("id, company_name, job_title, application_status, outcome")
      .eq("user_id", user.id)
      .neq("id", application_id)
      .order("updated_at", { ascending: false })
      .limit(100);

    type PeerApp = { id: string; company_name: string; job_title: string; application_status: string; outcome: string | null };
    const peerApps = (peerAppsRaw ?? []) as PeerApp[];
    const peerIds = peerApps.map((p) => p.id);

    // Fetch interview events to boost signal
    let interviewEventIds = new Set<string>();
    if (peerIds.length > 0) {
      const { data: evRows } = await userClient
        .from("application_events")
        .select("application_id")
        .eq("event_type", "interview_scheduled")
        .in("application_id", peerIds);
      interviewEventIds = new Set((evRows ?? []).map((e: { application_id: string }) => e.application_id));
    }

    // Score and rank peers by (role similarity × interview signal)
    const scoredPeers = peerApps
      .map((p) => {
        const titleSim = jaccardSimilarity(currentTitleTokens, normalizeWords(p.job_title));
        const companySim = jaccardSimilarity(currentCompanyTokens, normalizeWords(p.company_name));
        const roleSim = titleSim * 0.6 + companySim * 0.4;
        const ivSignal = interviewProgressScore(p.application_status, p.outcome, interviewEventIds.has(p.id));
        const rankScore = roleSim * ivSignal + 0.1 * ivSignal;
        return { ...p, titleSim, companySim, roleSim, ivSignal, rankScore };
      })
      .sort((a, b) => b.rankScore - a.rankScore)
      .slice(0, MAX_PEER_APPLICATIONS);

    // Fetch the resume content selections for top-ranked peers (if they had resumes generated)
    const topPeerIds = scoredPeers.map((p) => p.id);
    const latestResumeContentByApp = new Map<string, string>();
    if (topPeerIds.length > 0) {
      const { data: artifactRows } = await userClient
        .from("generated_artifacts")
        .select("application_id, content, created_at")
        .eq("type", "resume_content")
        .in("application_id", topPeerIds)
        .order("created_at", { ascending: false });
      for (const row of artifactRows ?? []) {
        const aid = row.application_id as string;
        if (!latestResumeContentByApp.has(aid)) latestResumeContentByApp.set(aid, row.content as string);
      }
    }

    // Build peer context block for the prompt
    const peersWithHighSignal = scoredPeers.filter((p) => p.ivSignal >= 0.5); // screening or better
    const peerContextBlock = peersWithHighSignal.length === 0
      ? ""
      : `\n## Past applications — outcome signals\nUse these to understand which types of experience emphasis led to interview progress for similar roles. Prioritize experience bullets and framings that align with what worked.\n\n${peersWithHighSignal
          .map((p, i) => {
            const lines = [
              `### ${i + 1}. ${p.company_name} — ${p.job_title}`,
              `- Outcome: ${statusNarrative(p.application_status, p.outcome)}`,
              `- Role similarity to this application: ${Math.round(p.roleSim * 100)}%`,
            ];
            const content = latestResumeContentByApp.get(p.id);
            if (content) {
              try {
                const parsed = JSON.parse(content) as { selected_experience?: Array<{ role_title: string; bullets: string[] }> };
                const expSummary = (parsed.selected_experience ?? [])
                  .slice(0, 2)
                  .map((e) => `    • ${e.role_title}: ${e.bullets.slice(0, 2).join("; ")}`)
                  .join("\n");
                if (expSummary) lines.push(`- What was emphasized in the resume for this application:\n${expSummary}`);
              } catch { /* ignore parse errors */ }
            }
            return lines.join("\n");
          })
          .join("\n\n")}\n`;

    if (features.length === 0) {
      return jsonOk({
        ok: false,
        error: "No resume features found. Please add your experience, education, and skills in the Resume Wizard before generating a tailored resume.",
        code: "no_resume_data",
      });
    }

    // Group features by type for the prompt
    const grouped: Record<string, unknown[]> = {};
    for (const f of features) {
      const type = f.feature_type;
      if (!grouped[type]) grouped[type] = [];
      grouped[type].push({
        role_title: f.role_title,
        company_name: f.company,
        location: f.location,
        degree: f.degree,
        major: f.major,
        from_date: f.from_date,
        to_date: f.to_date,
        description_lines: f.description_lines,
      });
    }

    // --- Build AI prompt ---
    const userPrompt = `Job Title: ${app.job_title}
Company: ${app.company_name}
Job Description: ${app.job_description ?? "(none provided)"}
${peerContextBlock}
Candidate's Resume Data:
${JSON.stringify(grouped, null, 2)}

Instructions:
- Select the most relevant experience entries (up to 4, ordered by relevance)
- For each experience entry, you may keep, trim, or rewrite bullets to emphasize relevance to this specific role
- Select all academics entries (keep them all)
- Select relevant extracurricular/community entries when they strengthen this application
- Select the most relevant skills categories (keep all, but reorder by relevance)
- Include personal interests if present
- Keep bullets concise (1-2 lines each)
- Do NOT invent experience or skills not in the source data
- Resume page limit selected by user in Resume Wizard: ${pageLimit} page(s). Keep content within this limit.

Return this exact JSON structure:
{
  "selected_experience": [{ "role_title": "...", "company_name": "...", "location": "...", "from_date": "...", "to_date": "...", "bullets": ["..."] }],
  "selected_academics": [{ "degree": "...", "major": "...", "school": "...", "location": "...", "from_date": "...", "to_date": "...", "bullets": ["..."] }],
  "selected_extracurriculars": [{ "role_title": "...", "organization": "...", "location": "...", "from_date": "...", "to_date": "...", "bullets": ["..."] }],
  "selected_skills": [{ "category": "...", "bullets": ["..."] }],
  "personal_interests": "..."
}`;

    // --- Call AI (Gemini primary, Anthropic fallback) ---
    let aiResult: { ok: true; text: string } | { ok: false; error: string; code: string };

    if (geminiApiKey) {
      aiResult = await callGemini(geminiApiKey, geminiModel, userPrompt);
      if (!aiResult.ok && aiResult.code === "provider_unavailable" && anthropicApiKey) {
        console.warn("Gemini unavailable, falling back to Anthropic");
        aiResult = await callAnthropic(anthropicApiKey, anthropicModel, userPrompt);
      }
    } else {
      // No Gemini key — go straight to Anthropic
      aiResult = await callAnthropic(anthropicApiKey, anthropicModel, userPrompt);
    }

    // --- Parse AI JSON response (with deterministic fallback when provider is overloaded) ---
    let aiData: AIResponse;
    let generationMode: "ai" | "fallback_heuristic" = "ai";
    if (!aiResult.ok) {
      const fallbackCodes = new Set(["provider_unavailable", "rate_limited", "empty_completion"]);
      if (!fallbackCodes.has(aiResult.code)) {
        return jsonOk({ ok: false, error: aiResult.error, code: aiResult.code });
      }
      console.warn("AI provider unavailable; using heuristic resume fallback:", aiResult.code, aiResult.error);
      aiData = buildHeuristicResumeSelection(features);
      generationMode = "fallback_heuristic";
    } else {
      try {
        aiData = parseAIJson(aiResult.text);
      } catch (parseErr) {
        console.error("Failed to parse AI JSON; using heuristic fallback:", aiResult.text.slice(0, 500), parseErr);
        aiData = buildHeuristicResumeSelection(features);
        generationMode = "fallback_heuristic";
      }
    }

    // Ensure arrays are present (defensive defaults)
    aiData.selected_experience = Array.isArray(aiData.selected_experience) ? aiData.selected_experience : [];
    aiData.selected_academics = Array.isArray(aiData.selected_academics) ? aiData.selected_academics : [];
    aiData.selected_extracurriculars = Array.isArray(aiData.selected_extracurriculars) ? aiData.selected_extracurriculars : [];
    aiData.selected_skills = Array.isArray(aiData.selected_skills) ? aiData.selected_skills : [];
    aiData.personal_interests = typeof aiData.personal_interests === "string" ? aiData.personal_interests : "";
    aiData = applyResumePageLimitSelection(aiData, pageLimit);

    // Save the AI's content selection so future generations can learn from outcomes
    await userClient.from("generated_artifacts").insert({
      application_id,
      user_id: user.id,
      type: "resume_content",
      content: JSON.stringify(aiData),
      prompt_used:
        generationMode === "ai"
          ? userPrompt.slice(0, 8000)
          : `HEURISTIC_FALLBACK\nreason=ai_provider_unavailable_or_malformed\n${userPrompt.slice(0, 7800)}`,
      generator_version: RESUME_GENERATOR_VERSION,
    }).then(({ error: artifactErr }) => {
      if (artifactErr) console.warn("resume_content artifact insert:", artifactErr);
    });

    // --- Build HTML ---
    const htmlString = buildResumeHtml(
      { name: fullName, email, phone, location, linkedin },
      aiData,
    );

    // --- Call runner /generate-pdf ---
    let pdfBytes: ArrayBuffer;
    try {
      const pdfRes = await fetch(`${runnerBaseUrl}/generate-pdf`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${runnerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ html: htmlString }),
        signal: AbortSignal.timeout(90_000),
      });

      if (!pdfRes.ok) {
        const errText = await pdfRes.text().catch(() => "");
        console.error("Runner /generate-pdf error:", pdfRes.status, errText.slice(0, 400));
        return jsonOk({
          ok: false,
          error: `PDF generation failed (HTTP ${pdfRes.status}): ${errText.slice(0, 300) || "Unknown runner error"}`,
          code: "pdf_generation_failed",
        });
      }

      pdfBytes = await pdfRes.arrayBuffer();
    } catch (runnerErr) {
      console.error("Runner fetch error:", runnerErr);
      return jsonOk({
        ok: false,
        error: `Runner unavailable: ${runnerErr instanceof Error ? runnerErr.message : String(runnerErr)}`,
        code: "runner_unavailable",
      });
    }

    // --- Upload to Supabase Storage (service role to bypass RLS) ---
    const storagePath = `${user.id}/resumes/${application_id}/resume.pdf`;

    const { error: uploadErr } = await adminClient.storage
      .from("documents")
      .upload(storagePath, pdfBytes, {
        contentType: "application/pdf",
        upsert: true,
      });

    if (uploadErr) {
      console.error("Storage upload error:", uploadErr);
      return jsonOk({
        ok: false,
        error: `Failed to upload PDF to storage: ${uploadErr.message}`,
        code: "storage_upload_failed",
      });
    }

    // --- Resolve/create document record (idempotent for this app path) ---
    const existingDocForPath = await userClient
      .from("documents")
      .select("id")
      .eq("user_id", user.id)
      .eq("type", "resume")
      .eq("file_path", storagePath)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let documentId = existingDocForPath.data?.id ?? null;
    if (!documentId) {
      const docInsertPayload: Record<string, unknown> = {
        user_id: user.id,
        name: "Tailored Resume",
        type: "resume",
        file_path: storagePath,
      };

      const { data: docRow, error: docInsertErr } = await userClient
        .from("documents")
        .insert(docInsertPayload)
        .select("id")
        .single();

      if (docInsertErr || !docRow) {
        // Re-check in case a concurrent request inserted first.
        const retryDoc = await userClient
          .from("documents")
          .select("id")
          .eq("user_id", user.id)
          .eq("type", "resume")
          .eq("file_path", storagePath)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!retryDoc.data?.id) {
          console.error("Document insert error:", docInsertErr);
          return jsonOk({
            ok: false,
            error: `PDF uploaded but document record could not be saved: ${docInsertErr?.message ?? "Unknown error"}`,
            code: "db_insert_failed",
            storage_path: storagePath,
          });
        }
        documentId = retryDoc.data.id;
      } else {
        documentId = (docRow as { id: string }).id;
      }
    }

    // --- Link document to application via application_documents ---
    const existingLink = await userClient
      .from("application_documents")
      .select("id")
      .eq("application_id", application_id)
      .eq("document_id", documentId)
      .eq("user_id", user.id)
      .maybeSingle();

    const { error: junctionErr } = existingLink.data?.id
      ? { error: null }
      : await userClient
          .from("application_documents")
          .insert({
            application_id,
            document_id: documentId,
            user_id: user.id,
          });

    if (junctionErr) {
      // Log but don't fail — the document exists, the link is cosmetic
      console.warn("application_documents insert error (non-fatal):", junctionErr);
    }

    // Pin the generated resume to the application to avoid duplicate regeneration in queue runs.
    await userClient
      .from("applications")
      .update({ submitted_resume_document_id: documentId })
      .eq("id", application_id)
      .eq("user_id", user.id)
      .then(({ error: appUpdateErr }) => {
        if (appUpdateErr) console.warn("applications.submitted_resume_document_id update (non-fatal):", appUpdateErr);
      });

    // --- Log event ---
    await userClient.from("application_events").insert({
      application_id,
      user_id: user.id,
      event_type: "document_generated",
      description: "Tailored resume generated with AI",
    }).then(({ error: evErr }) => {
      if (evErr) console.warn("application_events insert:", evErr);
    });

    return jsonOk({
      ok: true,
      storage_path: storagePath,
      document_id: documentId,
      generator_version: RESUME_GENERATOR_VERSION,
      generation_mode: generationMode,
    });
  } catch (e) {
    console.error("Unexpected error:", e);
    return jsonOk({
      ok: false,
      error: e instanceof Error ? e.message : "Unknown error",
      code: "unexpected",
    });
  }
});
