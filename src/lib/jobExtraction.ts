import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type ExtractedJobFields = {
  company_name: string;
  job_title: string;
  job_description: string;
  location: string;
  salary_range: string;
};

export type ExtractJobFromUrlResult = {
  fields: ExtractedJobFields;
  /** True when the edge function did not return usable parsed fields */
  usedFallback: boolean;
  /** Human-readable reason (show in UI); empty when extraction succeeded */
  fallbackDetail?: string;
};

function guessCompanyFromHost(host: string): string {
  const parts = host.replace(/^www\./, "").split(".");
  const skip = new Set(["www", "careers", "jobs", "apply", "boards", "greenhouse", "lever", "myworkdayjobs"]);
  let i = 0;
  while (i < parts.length - 1 && skip.has(parts[i])) i++;
  const raw = parts[i] || parts[0] || "company";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function fallbackFromUrlOnly(jobUrl: string): ExtractedJobFields {
  let host = "";
  try {
    host = new URL(jobUrl).hostname;
  } catch {
    host = "listing";
  }
  const company_name = guessCompanyFromHost(host);
  return {
    company_name,
    job_title: "Open role",
    job_description: "",
    location: "",
    salary_range: "",
  };
}

const CLIP = 400;

/** Pull "Label: value" lines (same heuristics as parse-job-url). */
function extractLabeledField(text: string, labels: string[]): string {
  if (!text.trim()) return "";
  const alt = labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const sameLine = new RegExp(
    `(?:^|\\n)\\s*(?:\\*\\*)?(?:${alt})(?:\\*\\*)?\\s*:\\s*(.+?)(?=\\n|$)`,
    "im",
  );
  let v = text.match(sameLine)?.[1]?.trim() ?? "";
  if (!v || v.length < 2) {
    const nextLine = new RegExp(
      `(?:^|\\n)\\s*(?:\\*\\*)?(?:${alt})(?:\\*\\*)?\\s*:?\\s*\\n+\\s*([^\\n#]{2,500})`,
      "im",
    );
    v = text.match(nextLine)?.[1]?.trim() ?? "";
  }
  v = v.replace(/^:\s*/, "").replace(/\s+/g, " ").trim();
  return v.length > 500 ? `${v.slice(0, 500)}…` : v;
}

function inferenceCorpus(f: ExtractedJobFields): string {
  return [f.job_title, f.job_description].filter(Boolean).join("\n").slice(0, 25_000);
}

const SENIORITY_TOKENS =
  /\b(Intern(?:ship)?|Junior|Jnr\.?|Associate|Mid[-\s]?Level|Mid|Intermediate|Senior|Sr\.?|Staff|Principal|Lead|Manager|Director|VP|Vice President|Executive|Head of)\b/i;

function inferSeniorityForTitle(job_title: string, corpus: string): string {
  const t = job_title.trim();
  if (!t || SENIORITY_TOKENS.test(t)) return t;
  const labeled = extractLabeledField(corpus, [
    "Seniority",
    "Career level",
    "Job level",
    "Experience level",
    "Years of experience",
  ]);
  if (!labeled) return t;
  const m = labeled.match(SENIORITY_TOKENS);
  if (!m?.[1]) return t;
  const word = m[1].replace(/\.$/, "").trim();
  if (!word) return t;
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\b${esc}\\.?\\b`, "i").test(t)) return t;
  return `${word} ${t}`.replace(/\s+/g, " ").trim();
}

/** Match location embedded in description (markdown / ATS text). Kept in sync with parse-job-url enrich step. */
function inferLocationFromFreeText(text: string): string {
  if (!text || text.length < 3) return "";
  const patterns: RegExp[] = [
    /(?:^|\n)\s*[-*•]\s*\*\*(?:Remote|Hybrid|On[-\s]?site|In[-\s]?office)\*\*\s*:?\s*([^\n]+)/im,
    /(?:^|\n)\s*(?:Remote|Hybrid|On[-\s]?site|In[-\s]?office)\s*(?:work|role|position)?\s*[:-—]\s*([^\n]+)/im,
    /\bRemote\s*\([^)]{2,120}\)/i,
    /(?:^|\n)\s*[-*•]\s*\*\*Location\*\*\s*:?\s*([^\n]+)/im,
    /\*\*Location\*\*\s*:?\s*([^\n*]{2,200})/i,
    /\*\*Locations?\*\*\s*:?\s*([^\n*]{2,200})/i,
    /\*\*Location\*\*\s*:?\s*\n+\s*([^\n#*]{2,200})/i,
    /#{1,4}\s*Location\s*\n+\s*([^\n#]{2,200})/im,
    /(?:^|\n)\s*[-*•]\s*\*?\*?Locations?\*?\*?\s*:?\s*[:-—]?\s*([^\n]+)/im,
    /(?:^|\n)\s*[-*•]\s*\*?\*?Location\*?\*?\s*:?\s*[:-—]\s*([^\n]+)/im,
    /(?:^|\n)\s*\|?\s*Locations?\s*\|\s*([^|\n]{2,200})\s*\|/i,
    /(?:^|\n)\s*\|?\s*Location\s*\|\s*([^|\n]{2,200})\s*\|/i,
    /(?:^|\n)\s*(?:Office|Work)\s+locations?\s*:?\s*([^\n]+)/i,
    /(?:^|\n)\s*(?:Office|Work)\s+location\s*:?\s*([^\n]+)/i,
    /(?:^|\n)\s*Workplace\s*(?:type|location)?\s*:?\s*([^\n]+)/i,
    /(?:^|\n)\s*Where\s+you(?:'|’)?ll\s+work\s*:?\s*([^\n]+)/i,
    /(?:^|\n)\s*Available\s+Locations?\s*:?\s*([^\n]+)/im,
    /(?:^|\n)\s*Job\s+locations?\s*:?\s*([^\n]+)/i,
    /(?:^|\n)\s*Locations?\s*:?\s*([^\n]+)/im,
    /(?:^|\n)\s*Location\s*:?\s*([^\n]+)/im,
    /(?:^|\n)\s*Location\s*\n+\s*([^\n#]{2,200})/im,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    const raw = m?.[1] ?? m?.[0];
    const v = raw?.trim();
    if (!v || /^https?:\/\//i.test(v)) continue;
    if (v.length >= 2) {
      return v.length > CLIP ? `${v.slice(0, CLIP)}…` : v;
    }
  }
  return "";
}

function inferSalaryFromFreeText(text: string): string {
  if (!text.trim()) return "";
  const labeled = extractLabeledField(text, [
    "Salary",
    "Salary range",
    "Compensation",
    "Pay range",
    "Pay",
    "Base salary",
    "Estimated salary",
  ]);
  if (labeled) return labeled.length > CLIP ? labeled.slice(0, CLIP) + "…" : labeled;
  const md = text.match(/\*\*(?:Salary|Compensation)\*\*\s*:?\s*([^\n*]{3,200})/i);
  if (md?.[1]?.trim()) return md[1].trim().slice(0, CLIP);
  const dollar = text.match(
    /\$\s*\d[\d,]*(?:\.\d+)?(?:k|K|m|M)?(?:\s*[-–]\s*\$?\s*\d[\d,]*(?:\.\d+)?(?:k|K|m|M)?)?(?:\s*(?:\/yr|per year|USD|GBP|EUR))?/,
  );
  if (dollar) return dollar[0].replace(/\s+/g, " ").trim();
  const gbp = text.match(
    /£\s*\d[\d,]*(?:\.\d+)?(?:k|K|m|M)?(?:\s*[-–]\s*£?\s*\d[\d,]*(?:\.\d+)?(?:k|K|m|M)?)?(?:\s*(?:\/yr|per year|GBP))?/i,
  );
  if (gbp) return gbp[0].replace(/\s+/g, " ").trim();
  const eur = text.match(
    /(?:€|EUR)\s*\d[\d,]*(?:\.\d+)?(?:k|K|m|M)?(?:\s*[-–]\s*(?:€|EUR)?\s*\d[\d,]*(?:\.\d+)?(?:k|K|m|M)?)?(?:\s*(?:\/yr|per year))?/i,
  );
  return eur ? eur[0].replace(/\s+/g, " ").trim() : "";
}

/** Flattened text often runs the next section into the same line as the city. */
function cleanExtractedLocation(value: string): string {
  const t = value.replace(/\s+/g, " ").trim();
  if (!t) return t;
  return t
    .replace(
      /\s+(About the role|About us|About Us|Responsibilities|Qualifications|Description|The opportunity|What you('ll| will)|What You('ll| Will))\b[\s\S]*$/i,
      "",
    )
    .trim();
}

/** Keep in sync with supabase/functions/parse-job-url/index.ts */
const US_METRO_TO_STATE: Record<string, string> = {
  "new york": "NY",
  "new york city": "NY",
  nyc: "NY",
  brooklyn: "NY",
  manhattan: "NY",
  queens: "NY",
  bronx: "NY",
  "los angeles": "CA",
  "san francisco": "CA",
  "san jose": "CA",
  oakland: "CA",
  berkeley: "CA",
  "palo alto": "CA",
  "mountain view": "CA",
  "menlo park": "CA",
  "redwood city": "CA",
  sunnyvale: "CA",
  "santa clara": "CA",
  "san diego": "CA",
  sacramento: "CA",
  houston: "TX",
  dallas: "TX",
  austin: "TX",
  "san antonio": "TX",
  chicago: "IL",
  seattle: "WA",
  boston: "MA",
  cambridge: "MA",
  miami: "FL",
  "fort lauderdale": "FL",
  tampa: "FL",
  orlando: "FL",
  atlanta: "GA",
  philadelphia: "PA",
  pittsburgh: "PA",
  phoenix: "AZ",
  denver: "CO",
  detroit: "MI",
  minneapolis: "MN",
  "st. paul": "MN",
  "saint paul": "MN",
  charlotte: "NC",
  raleigh: "NC",
  durham: "NC",
  nashville: "TN",
  "las vegas": "NV",
  portland: "OR",
  columbus: "OH",
  cleveland: "OH",
  cincinnati: "OH",
  indianapolis: "IN",
  baltimore: "MD",
  "washington dc": "DC",
  "washington d.c.": "DC",
  "st. louis": "MO",
  "saint louis": "MO",
  "kansas city": "MO",
  milwaukee: "WI",
  "salt lake city": "UT",
  honolulu: "HI",
  anchorage: "AK",
  louisville: "KY",
  memphis: "TN",
  "new orleans": "LA",
  omaha: "NE",
  boise: "ID",
  albuquerque: "NM",
  tucson: "AZ",
  fresno: "CA",
  "long beach": "CA",
  "virginia beach": "VA",
  richmond: "VA",
  "jersey city": "NJ",
  newark: "NJ",
};

const US_STATE_NAME_SET = new Set(
  [
    "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware",
    "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky",
    "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota", "mississippi",
    "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey", "new mexico",
    "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania",
    "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont",
    "virginia", "washington", "west virginia", "wisconsin", "wyoming", "district of columbia",
  ],
);

function locationAlreadyHasUsStateOrDc(location: string): boolean {
  const t = location.trim();
  if (/\bDC\b\s*$/i.test(t) || /,\s*D\.?\s*C\.?\s*$/i.test(t)) return true;
  const m = t.match(/,\s*([^,]+?)\s*$/);
  if (!m) return false;
  const seg = m[1].trim();
  if (/^[A-Za-z]{2}$/.test(seg)) return true;
  return US_STATE_NAME_SET.has(seg.toLowerCase());
}

function expandKnownUsMetroIfMissingState(location: string): string {
  const t = location.replace(/\s+/g, " ").trim();
  if (!t) return t;

  const splitters = /\s*[·•|]\s*/;
  if (splitters.test(t)) {
    const parts = t.split(splitters).map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return t;
    const out = parts.map((seg) => {
      if (locationAlreadyHasUsStateOrDc(seg)) return seg;
      let cityKey = seg;
      const co = seg.match(/^(.+?),\s*(USA|US|United States)\s*$/i);
      if (co) cityKey = co[1].trim();
      else if (seg.includes(",")) return seg;
      const abbr = US_METRO_TO_STATE[cityKey.toLowerCase()];
      return abbr ? `${cityKey}, ${abbr}` : seg;
    });
    return out.join(" · ");
  }

  if (locationAlreadyHasUsStateOrDc(t)) return t;

  let cityKey = t;
  const countryOnly = t.match(/^(.+?),\s*(USA|US|United States)\s*$/i);
  if (countryOnly) cityKey = countryOnly[1].trim();
  else if (t.includes(",")) return t;

  const abbr = US_METRO_TO_STATE[cityKey.toLowerCase()];
  if (!abbr) return t;
  return `${cityKey}, ${abbr}`;
}

/** Keep in sync with supabase/functions/parse-job-url/index.ts */
const US_FULL_STATE_NAME_TO_ABBR: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC",
  "d.c.": "DC",
  "washington dc": "DC",
};

const US_STATE_ABBR_WHITELIST = new Set(Object.values(US_FULL_STATE_NAME_TO_ABBR));

function abbreviateFullUsStateNameSegment(segment: string): string {
  const t = segment.replace(/\s+/g, " ").trim();
  if (!t.includes(",")) return t;
  const parts = t.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return t;
  const lastRaw = parts[parts.length - 1];
  const lower = lastRaw.toLowerCase().replace(/\.$/, "").trim();
  const fromFull = US_FULL_STATE_NAME_TO_ABBR[lower];
  if (fromFull) {
    parts[parts.length - 1] = fromFull;
    return parts.join(", ");
  }
  if (/^[a-z]{2}$/i.test(lastRaw.trim())) {
    const up = lastRaw.trim().toUpperCase();
    if (US_STATE_ABBR_WHITELIST.has(up)) {
      parts[parts.length - 1] = up;
      return parts.join(", ");
    }
  }
  return t;
}

function abbreviateFullUsStateNamesInLocation(location: string): string {
  const t = location.replace(/\s+/g, " ").trim();
  if (!t) return t;
  const splitters = /\s*[·•|]\s*/;
  if (splitters.test(t)) {
    return t.split(splitters).map((s) => s.trim()).filter(Boolean).map(abbreviateFullUsStateNameSegment).join(" · ");
  }
  return abbreviateFullUsStateNameSegment(t);
}

/** og:description / JSON-LD sometimes sets location to a workplace category with no geography — allow body inference to replace it. */
function isPlaceholderLocation(value: string): boolean {
  const t = value.trim();
  if (!t) return true;
  if (t.length <= 2) return true;
  if (/^(n\/?a|tbd|tbc|not specified|unspecified|see (the )?posting|various|multiple)$/i.test(t)) return true;
  if (/^(in[-\s]?office|on[-\s]?site)$/i.test(t)) return true;
  return false;
}

/** Re-run description heuristics after merging with form (so location/salary fill even when API omits them). */
export function enrichExtractedFromDescription(f: ExtractedJobFields): ExtractedJobFields {
  const corpus = inferenceCorpus(f);
  let job_title = inferSeniorityForTitle(f.job_title, corpus);
  let location = f.location.trim();
  let salary_range = f.salary_range.trim();
  if (isPlaceholderLocation(location)) location = "";
  if (!location) {
    location =
      extractLabeledField(corpus, [
        "Available Locations",
        "Available Location",
        "Location",
        "Locations",
        "Work location",
        "Job location",
        "Office location",
        "Office locations",
        "Where you'll work",
        "Where you\u2019ll work",
        "Workplace type",
      ]) || inferLocationFromFreeText(corpus);
  }
  if (!salary_range) salary_range = inferSalaryFromFreeText(corpus);
  location = abbreviateFullUsStateNamesInLocation(
    expandKnownUsMetroIfMissingState(cleanExtractedLocation(location)),
  );
  return { ...f, job_title, location, salary_range };
}

function coerceInvokeBody(data: unknown): unknown {
  if (data == null) return data;
  if (typeof data === "string") {
    try {
      return JSON.parse(data) as unknown;
    } catch {
      return null;
    }
  }
  return data;
}

function normalizeParsed(body: unknown): ExtractedJobFields | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  // Only treat as error payload when message is non-empty (avoid rejecting on `"error":""`).
  if (typeof o.error === "string" && o.error.length > 0) return null;
  return {
    company_name: typeof o.company_name === "string" ? o.company_name : "",
    job_title: typeof o.job_title === "string" ? o.job_title : "",
    job_description: typeof o.job_description === "string" ? o.job_description : "",
    location: typeof o.location === "string" ? o.location : "",
    salary_range: typeof o.salary_range === "string" ? o.salary_range : "",
  };
}

async function messageFromInvokeError(error: unknown): Promise<string | undefined> {
  if (!error || typeof error !== "object") return undefined;
  const e = error as { message?: string; context?: unknown };
  const ctx = e.context;
  if (ctx && typeof ctx === "object" && ctx !== null && "text" in ctx && typeof (ctx as Response).text === "function") {
    try {
      const raw = await (ctx as Response).clone().text();
      try {
        const body = JSON.parse(raw) as { error?: string };
        if (typeof body.error === "string") return body.error;
      } catch {
        if (raw.trim()) return raw.slice(0, 500);
      }
    } catch {
      /* ignore */
    }
  }
  return typeof e.message === "string" ? e.message : undefined;
}

/**
 * Calls the `parse-job-url` Edge Function (fetch + HTML/JSON-LD heuristics). Falls back to URL-only
 * heuristics if the function is missing, errors, or returns an error payload.
 */
function clientSupabaseApiKey(): string | undefined {
  const k = import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  return typeof k === "string" && k.length > 0 ? k : undefined;
}

/** Fallback when `supabase.functions.invoke` fails (SDK/relay quirks); same endpoint and headers. */
async function invokeParseJobUrlViaFetch(
  jobUrl: string,
  accessToken: string,
  apikey: string,
): Promise<{ data: unknown; error: string | null }> {
  const baseRaw = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const base = baseRaw?.replace(/\/+$/, "");
  if (!base) return { data: null, error: "VITE_SUPABASE_URL is not set" };
  try {
    const res = await fetch(`${base}/functions/v1/parse-job-url`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        apikey,
      },
      body: JSON.stringify({ url: jobUrl }),
    });
    const text = await res.text();
    if (!res.ok) {
      try {
        const j = JSON.parse(text) as { error?: string };
        if (typeof j.error === "string" && j.error.length > 0) {
          return { data: null, error: j.error };
        }
      } catch {
        /* ignore */
      }
      return { data: null, error: `HTTP ${res.status}: ${text.slice(0, 400).trim()}` };
    }
    try {
      return { data: JSON.parse(text) as unknown, error: null };
    } catch {
      return { data: null, error: "parse-job-url returned non-JSON" };
    }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function extractJobFromUrl(
  supabase: SupabaseClient<Database>,
  jobUrl: string,
): Promise<ExtractJobFromUrlResult> {
  let { data: sessionData } = await supabase.auth.getSession();
  let session = sessionData.session;
  const nowSec = Math.floor(Date.now() / 1000);
  if (session?.expires_at && session.expires_at <= nowSec + 120) {
    const { data: refreshed, error: refErr } = await supabase.auth.refreshSession();
    if (refErr) {
      return {
        fields: fallbackFromUrlOnly(jobUrl),
        usedFallback: true,
        fallbackDetail: `Session could not be refreshed (${refErr.message}). Sign out and sign in again, then retry import.`,
      };
    }
    session = refreshed.session ?? session;
  }

  const token = session?.access_token;
  if (!token) {
    return {
      fields: fallbackFromUrlOnly(jobUrl),
      usedFallback: true,
      fallbackDetail:
        "You need to be signed in to import a listing. Try signing out and signing back in, then retry.",
    };
  }

  const apikey = clientSupabaseApiKey();
  const inv = await supabase.functions.invoke("parse-job-url", {
    body: { url: jobUrl },
    headers: {
      Authorization: `Bearer ${token}`,
      ...(apikey ? { apikey } : {}),
    },
  });

  let rawData = inv.data;
  let error = inv.error;
  let directFetchError: string | null = null;

  if (error && apikey) {
    const direct = await invokeParseJobUrlViaFetch(jobUrl, token, apikey);
    if (!direct.error && direct.data != null) {
      rawData = direct.data;
      error = null;
      if (import.meta.env.DEV) {
        console.info("[extractJobFromUrl] direct fetch to Edge Function succeeded (invoke had failed)");
      }
    } else if (direct.error) {
      directFetchError = direct.error;
    }
  }

  const data = coerceInvokeBody(rawData);

  if (error) {
    const fromBody = await messageFromInvokeError(error);
    const primary = fromBody ?? directFetchError;
    const hint =
      primary?.toLowerCase().includes("invalid auth") || primary?.toLowerCase().includes("not authenticated")
        ? " If this persists, sign out, sign in again, and retry (your access token may be stale)."
        : "";
    if (import.meta.env.DEV) {
      console.warn("[extractJobFromUrl] invoke error", error, "body:", fromBody, "directFetch:", directFetchError);
    }
    return {
      fields: fallbackFromUrlOnly(jobUrl),
      usedFallback: true,
      fallbackDetail:
        (primary ??
          "Could not reach parse-job-url. Redeploy with: npx supabase functions deploy parse-job-url") + hint,
    };
  }

  const parsed = normalizeParsed(data);
  if (!parsed) {
    const serverErr =
      data && typeof data === "object" && typeof (data as { error?: string }).error === "string"
        ? (data as { error: string }).error
        : undefined;
    return {
      fields: fallbackFromUrlOnly(jobUrl),
      usedFallback: true,
      fallbackDetail: serverErr ?? "parse-job-url returned an unexpected response.",
    };
  }

  if (!parsed.job_title.trim() && !parsed.company_name.trim()) {
    return {
      fields: fallbackFromUrlOnly(jobUrl),
      usedFallback: true,
      fallbackDetail: "Listing response had no job title or company name.",
    };
  }

  return { fields: enrichExtractedFromDescription(parsed), usedFallback: false };
}

/** One job posting URL per line; trim, validate http(s), dedupe by normalized href. */
export function parseJobUrlsFromText(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;
    try {
      const u = new URL(raw);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      const key = u.href.split("#")[0];
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(raw);
    } catch {
      /* invalid URL */
    }
  }
  return out;
}

/**
 * Merge scraped fields into a base (e.g. form or empty row), then re-run description heuristics.
 */
export function mergeExtractedJobFields(
  base: ExtractedJobFields,
  extracted: ExtractedJobFields,
): ExtractedJobFields {
  return enrichExtractedFromDescription({
    company_name: base.company_name.trim() || extracted.company_name,
    job_title: base.job_title.trim() || extracted.job_title,
    job_description: base.job_description.trim() || extracted.job_description,
    location: base.location.trim() || extracted.location,
    salary_range: base.salary_range.trim() || extracted.salary_range,
  });
}

const MIN_DESCRIPTION_CHARS_FOR_AUTO_COVER = 120;
const MIN_COMPANY_CHARS = 2;
const MIN_TITLE_CHARS = 3;

/**
 * True when the listing scrape succeeded and there is enough structured text to generate a tailored cover letter.
 */
export function shouldAutoGenerateCoverLetter(
  scrapeResult: ExtractJobFromUrlResult,
  enriched: ExtractedJobFields,
): boolean {
  if (scrapeResult.usedFallback) return false;
  const company = enriched.company_name.trim();
  const title = enriched.job_title.trim();
  const desc = enriched.job_description.trim();
  if (company.length < MIN_COMPANY_CHARS || title.length < MIN_TITLE_CHARS) return false;
  if (desc.length < MIN_DESCRIPTION_CHARS_FOR_AUTO_COVER) return false;
  if (/^open role$/i.test(title)) return false;
  return true;
}
