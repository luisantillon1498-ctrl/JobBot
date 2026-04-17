import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Parsed = {
  company_name: string;
  job_title: string;
  job_description: string;
  location: string;
  salary_range: string;
};

/** Bumped when extraction logic changes — check Network response for `parse-job-url` to confirm deploy. */
const PARSER_REV = "20260416a";

function serializeParsed(p: Parsed): string {
  return JSON.stringify({ ...p, _parser_rev: PARSER_REV });
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function metaTag(html: string, attr: "property" | "name", key: string): string | null {
  const p1 = new RegExp(
    `<meta[^>]+${attr}=["']${key}["'][^>]+content=["']([^"']*)["']`,
    "i",
  );
  const p2 = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]+${attr}=["']${key}["']`,
    "i",
  );
  const m = html.match(p1) || html.match(p2);
  return m?.[1] ? decodeEntities(m[1]) : null;
}

function titleTag(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m?.[1] ? decodeEntities(m[1].replace(/\s+/g, " ").trim()) : null;
}

function guessCompanyFromHost(host: string): string {
  const parts = host.replace(/^www\./, "").split(".");
  const skip = new Set(["www", "careers", "jobs", "apply", "boards", "greenhouse", "lever", "myworkdayjobs"]);
  let i = 0;
  while (i < parts.length - 1 && skip.has(parts[i])) i++;
  const raw = parts[i] || parts[0] || "company";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** e.g. /acme/jobs/123 on boards.greenhouse.io → "Acme" */
function companyFromGreenhouseJobPath(pageUrl: string): string | null {
  try {
    const u = new URL(pageUrl);
    if (!u.hostname.includes("greenhouse.io")) return null;
    const m = u.pathname.match(/^\/([^/]+)\/jobs\/\d/i);
    if (!m) return null;
    const slug = m[1].toLowerCase();
    if (slug === "embed" || slug === "job" || slug === "jobs") return null;
    return slug
      .split(/[-_]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  } catch {
    return null;
  }
}

/** Ashby uses "Role @ Company" in <title> and meta name="title"; there is often no og:site_name. */
function extractCompanyFromTitleAtSuffix(title: string | null): string | null {
  if (!title) return null;
  const t = title.replace(/\s+/g, " ").trim();
  const m = t.match(/\s@\s+(.+)$/);
  if (!m?.[1]) return null;
  return m[1].trim();
}

function companyFromAshbyPage(html: string, pageUrl: string): string | null {
  try {
    const u = new URL(pageUrl);
    if (!u.hostname.includes("ashbyhq.com")) return null;
  } catch {
    return null;
  }
  const fromMeta = extractCompanyFromTitleAtSuffix(metaTag(html, "name", "title"));
  if (fromMeta) return fromMeta;
  return extractCompanyFromTitleAtSuffix(titleTag(html));
}

/** jobs.ashbyhq.com/{orgSlug}/{jobId} → title-case slug when title meta is missing (e.g. Jina-only body). */
function organizationSlugFromAshbyJobUrl(pageUrl: string): string | null {
  try {
    const u = new URL(pageUrl);
    if (!u.hostname.includes("ashbyhq.com")) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const slug = parts[0];
    if (!/^[a-z0-9-]+$/i.test(slug)) return null;
    return slug
      .split(/[-_]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
  } catch {
    return null;
  }
}

/** Strip trailing " @ Company" from Ashby-style titles. */
function stripRoleAtCompanySuffix(title: string): string {
  const t = title.trim();
  const m = t.match(/^(.+?)\s@\s+[^@]+$/);
  return m ? m[1].trim() : t;
}

function collectJobPosting(obj: unknown): Record<string, unknown> | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const t = o["@type"];
  const types = Array.isArray(t) ? t : t ? [t] : [];
  if (types.includes("JobPosting")) return o;
  if (Array.isArray(o["@graph"])) {
    for (const item of o["@graph"] as unknown[]) {
      const found = collectJobPosting(item);
      if (found) return found;
    }
  }
  return null;
}

function parseJsonLdJobPosting(html: string): Partial<Parsed> | null {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1].trim());
      const candidates = Array.isArray(data) ? data : [data];
      for (const c of candidates) {
        const jp = collectJobPosting(c);
        if (!jp) continue;
        const title = typeof jp.title === "string" ? jp.title : "";
        const desc = typeof jp.description === "string" ? jp.description : "";
        let company = "";
        const hiring = jp.hiringOrganization;
        if (hiring && typeof hiring === "object") {
          const ho = hiring as Record<string, unknown>;
          if (typeof ho.name === "string") company = ho.name;
        }
        let location = "";
        const jobLoc = jp.jobLocation;
        if (typeof jobLoc === "string" && jobLoc.trim()) {
          location = jobLoc.trim();
        } else if (Array.isArray(jobLoc) && jobLoc.length > 0) {
          const first = jobLoc[0];
          if (typeof first === "string" && first.trim()) location = first.trim();
          else if (first && typeof first === "object") {
            const jl = first as Record<string, unknown>;
            const addr = jl.address;
            if (addr && typeof addr === "object") {
              const a = addr as Record<string, unknown>;
              const parts = [a.addressLocality, a.addressRegion, a.addressCountry].filter(
                (x): x is string => typeof x === "string" && x.length > 0,
              );
              location = parts.join(", ");
            } else if (typeof jl.name === "string" && jl.name.trim()) {
              location = jl.name.trim();
            }
          }
        } else if (jobLoc && typeof jobLoc === "object") {
          const jl = jobLoc as Record<string, unknown>;
          const addr = jl.address;
          if (addr && typeof addr === "object") {
            const a = addr as Record<string, unknown>;
            const parts = [a.addressLocality, a.addressRegion, a.addressCountry].filter(
              (x): x is string => typeof x === "string" && x.length > 0,
            );
            location = parts.join(", ");
          } else if (typeof jl.name === "string" && jl.name.trim()) {
            location = jl.name.trim();
          }
        }
        if (!location) {
          const empLoc = jp.employmentLocation;
          if (typeof empLoc === "string" && empLoc.trim()) location = empLoc.trim();
          else if (empLoc && typeof empLoc === "object") {
            const el = empLoc as Record<string, unknown>;
            const addr = el.address;
            if (addr && typeof addr === "object") {
              const a = addr as Record<string, unknown>;
              const parts = [a.addressLocality, a.addressRegion, a.addressCountry].filter(
                (x): x is string => typeof x === "string" && x.length > 0,
              );
              location = parts.join(", ");
            } else if (typeof el.name === "string" && el.name.trim()) {
              location = el.name.trim();
            }
          }
        }
        if (!location && Array.isArray(jp.applicantLocationRequirements)) {
          const reqs = jp.applicantLocationRequirements as unknown[];
          const names: string[] = [];
          for (const r of reqs) {
            if (r && typeof r === "object") {
              const nm = (r as Record<string, unknown>).name;
              if (typeof nm === "string" && nm.trim()) names.push(nm.trim());
            }
          }
          if (names.length) location = names.join("; ");
        }
        const jlt = jp.jobLocationType;
        const jltStr = typeof jlt === "string" ? jlt : "";
        const isTelecommute =
          jlt === "TELECOMMUTE" ||
          /TELECOMMUTE|schema\.org\/TELECOMMUTE/i.test(jltStr);
        if (isTelecommute) {
          location = location ? `Remote · ${location}` : "Remote";
        }
        let salary = "";
        const base = jp.baseSalary;
        if (base && typeof base === "object") {
          const b = base as Record<string, unknown>;
          const val = b.value;
          const cur = typeof b.currency === "string" ? b.currency : "";
          const unitOnBase = typeof (b as { unitText?: unknown }).unitText === "string"
            ? (b as { unitText: string }).unitText
            : "";
          if (val && typeof val === "object") {
            const v = val as Record<string, unknown>;
            const unitOnVal = typeof v.unitText === "string" ? v.unitText : "";
            const unit = unitOnVal || unitOnBase;
            if (typeof v.minValue === "number" && typeof v.maxValue === "number") {
              salary = `${v.minValue}–${v.maxValue} ${cur}${unit ? ` ${unit}` : ""}`.trim();
            } else if (typeof v.value === "number") {
              salary = `${v.value} ${cur}${unit ? ` ${unit}` : ""}`.trim();
            }
          }
        }
        return {
          company_name: company,
          job_title: title,
          job_description: desc,
          location,
          salary_range: salary,
        };
      }
    } catch {
      // skip invalid JSON
    }
  }
  return null;
}

function stripToText(html: string, max: number): string {
  const noScripts = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ");
  const text = noScripts.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, max);
}

/** Greenhouse job-board URLs are often empty SPAs; public API has title, company, offices, and HTML description. */
function parseGreenhouseBoardJobUrl(pageUrl: string): { token: string; jobId: string } | null {
  try {
    const u = new URL(pageUrl);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") {
      const m = u.pathname.match(/^\/([^/]+)\/jobs\/(\d+)\/?$/);
      if (m) return { token: m[1], jobId: m[2] };
    }
    if (host === "boards.greenhouse.io" && /\/embed\//i.test(u.pathname)) {
      const for_ = u.searchParams.get("for") || u.searchParams.get("board_token");
      const id =
        u.searchParams.get("id") ||
        u.searchParams.get("gh_jid") ||
        u.searchParams.get("jobId") ||
        (pageUrl.match(/[?&]gh_jid=(\d+)/)?.[1] ?? "");
      if (for_ && id && /^\d+$/.test(id)) return { token: for_, jobId: id };
    }
    return null;
  } catch {
    return null;
  }
}

function decodeEntitiesRepeated(s: string, maxPass = 5): string {
  let cur = s;
  for (let i = 0; i < maxPass; i++) {
    const next = decodeEntities(cur);
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

function greenhouseOfficesToString(offices: unknown): string {
  if (!Array.isArray(offices)) return "";
  const names: string[] = [];
  for (const o of offices) {
    if (o && typeof o === "object" && typeof (o as { name?: string }).name === "string") {
      const n = (o as { name: string }).name.trim();
      if (n) names.push(n);
    }
  }
  return names.join("; ");
}

function greenhouseMetadataLocations(metadata: unknown): string {
  if (!Array.isArray(metadata)) return "";
  const out: string[] = [];
  for (const item of metadata) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name : "";
    if (!/(posting location|job location|office location)/i.test(name)) continue;
    const v = o.value;
    if (typeof v === "string" && v.trim()) out.push(v.trim());
    else if (Array.isArray(v)) {
      for (const x of v) {
        if (typeof x === "string" && x.trim()) out.push(x.trim());
      }
    }
  }
  return [...new Set(out)].join("; ");
}

function locationFromGreenhouseJob(j: Record<string, unknown>): string {
  const officesStr = greenhouseOfficesToString(j.offices);
  const metaLoc = greenhouseMetadataLocations(j.metadata);
  let locName = "";
  const L = j.location;
  if (L && typeof L === "object" && typeof (L as { name?: string }).name === "string") {
    locName = (L as { name: string }).name.trim();
  }
  if (officesStr) return officesStr;
  if (metaLoc && (!locName || /^(Hybrid|Remote|Multiple|Flex|Unspecified|Any)$/i.test(locName))) {
    return locName ? `${locName} · ${metaLoc}` : metaLoc;
  }
  return locName || metaLoc;
}

async function fetchGreenhouseJobFromApi(
  token: string,
  jobId: string,
  headers: Record<string, string>,
): Promise<Partial<Parsed> | null> {
  const apiUrl =
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs/${encodeURIComponent(jobId)}`;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 22_000);
    const r = await fetch(apiUrl, {
      headers: { ...headers, Accept: "application/json" },
      redirect: "follow",
      signal: ctrl.signal,
    }).finally(() => clearTimeout(to));
    if (!r.ok) {
      console.error("Greenhouse API HTTP", r.status, token, jobId);
      return null;
    }
    const j = await r.json() as Record<string, unknown>;
    const title = typeof j.title === "string" ? j.title.trim() : "";
    const company_name = typeof j.company_name === "string" ? j.company_name.trim() : "";
    const location = locationFromGreenhouseJob(j);
    let job_description = "";
    if (typeof j.content === "string" && j.content.trim()) {
      const decoded = decodeEntitiesRepeated(j.content);
      job_description = stripToText(decoded, 50_000);
    }
    if (!title && !company_name && !job_description) return null;
    return {
      company_name,
      job_title: title,
      job_description,
      location,
      salary_range: "",
    };
  } catch (e) {
    console.error("Greenhouse API error", e);
    return null;
  }
}

function mergeGreenhouseApi(into: Parsed, api: Partial<Parsed> | null): Parsed {
  if (!api) return into;
  const out = { ...into };
  if (api.company_name?.trim()) out.company_name = api.company_name.trim();
  if (api.job_title?.trim()) out.job_title = api.job_title.trim();
  if (api.location?.trim()) out.location = api.location.trim();
  const apiDesc = api.job_description?.trim() || "";
  const intoDesc = into.job_description?.trim() || "";
  if (apiDesc && (apiDesc.length > intoDesc.length + 80 || intoDesc.length < 400)) {
    out.job_description = apiDesc;
  }
  return out;
}

async function withGreenhousePublicApi(
  parsed: Parsed,
  pageUrl: string,
  fetchHeaders: Record<string, string>,
): Promise<Parsed> {
  const ref = parseGreenhouseBoardJobUrl(pageUrl);
  if (!ref) return parsed;
  const api = await fetchGreenhouseJobFromApi(ref.token, ref.jobId, fetchHeaders);
  if (!api) return parsed;
  const merged = mergeGreenhouseApi(parsed, api);
  return enrichParsedFromDescription(merged);
}

// ---------------------------------------------------------------------------
// Ashby public posting API
// ---------------------------------------------------------------------------

/** jobs.ashbyhq.com/{orgSlug}/{jobId}[?...] → { orgSlug, jobId } or null */
function parseAshbyJobUrl(pageUrl: string): { orgSlug: string; jobId: string } | null {
  try {
    const u = new URL(pageUrl);
    if (!u.hostname.includes("ashbyhq.com")) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    // Expect /{orgSlug}/{uuid} with optional trailing segments
    if (parts.length < 2) return null;
    const orgSlug = parts[0];
    const jobId = parts[1];
    if (!/^[a-z0-9-]+$/i.test(orgSlug)) return null;
    // Ashby job IDs are UUIDs
    if (!/^[0-9a-f-]{32,}$/i.test(jobId)) return null;
    return { orgSlug, jobId };
  } catch {
    return null;
  }
}

/** Call Ashby posting API and find the specific job by ID. Returns parsed fields or null. */
async function fetchAshbyJobFromApi(
  orgSlug: string,
  jobId: string,
): Promise<Partial<Parsed> | null> {
  const apiUrl = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(orgSlug)}`;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 22_000);
    const r = await fetch(apiUrl, {
      headers: { Accept: "application/json" },
      redirect: "follow",
      signal: ctrl.signal,
    }).finally(() => clearTimeout(to));
    if (!r.ok) {
      console.error("Ashby API HTTP", r.status, orgSlug, jobId);
      return null;
    }
    const board = await r.json() as Record<string, unknown>;
    const postings = Array.isArray(board.jobPostings) ? board.jobPostings as Record<string, unknown>[] : [];
    // Match by id (UUID, case-insensitive)
    const job = postings.find(
      (p) => typeof p.id === "string" && p.id.toLowerCase() === jobId.toLowerCase(),
    );
    if (!job) {
      console.error("Ashby job not found in board listing", orgSlug, jobId);
      return null;
    }

    const job_title = typeof job.title === "string" ? job.title.trim() : "";

    // Company name: board-level organizationName or title-case org slug
    let company_name = "";
    if (typeof board.organizationName === "string" && board.organizationName.trim()) {
      company_name = board.organizationName.trim();
    } else {
      company_name = orgSlug
        .split(/[-_]+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(" ");
    }

    // Location: locationName or isRemote flag
    let location = "";
    if (typeof job.locationName === "string" && job.locationName.trim()) {
      location = job.locationName.trim();
    }
    if (!location && job.isRemote === true) {
      location = "Remote";
    }
    // secondaryLocations
    if (!location && Array.isArray(job.secondaryLocations)) {
      const names: string[] = (job.secondaryLocations as Record<string, unknown>[])
        .map((l) => (typeof l.locationName === "string" ? l.locationName.trim() : ""))
        .filter(Boolean);
      if (names.length) location = names.join(" · ");
    }

    // Description: descriptionPlain > descriptionHtml stripped
    let job_description = "";
    if (typeof job.descriptionPlain === "string" && job.descriptionPlain.trim()) {
      job_description = job.descriptionPlain.trim().slice(0, 50_000);
    } else if (typeof job.descriptionHtml === "string" && job.descriptionHtml.trim()) {
      job_description = stripToText(job.descriptionHtml, 50_000);
    }

    // Compensation
    let salary_range = "";
    const comp = job.compensation;
    if (comp && typeof comp === "object") {
      const c = comp as Record<string, unknown>;
      const summaryStr = typeof c.summary === "string" ? c.summary.trim() : "";
      if (summaryStr) salary_range = summaryStr;
    }

    if (!job_title && !company_name && !job_description) return null;
    return { company_name, job_title, job_description, location, salary_range };
  } catch (e) {
    console.error("Ashby API error", e);
    return null;
  }
}

/** Jina AI Reader: fetches pages from their edge (often succeeds when Supabase IPs are blocked). Optional JINA_API_KEY secret for higher limits. */
async function fetchViaJinaReader(pageUrl: string): Promise<string | null> {
  const endpoint = `https://r.jina.ai/${pageUrl}`;
  const headers: Record<string, string> = {
    Accept: "text/plain",
    "X-Return-Format": "markdown",
  };
  const apiKey = Deno.env.get("JINA_API_KEY");
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const jinaCtrl = new AbortController();
    const jinaT = setTimeout(() => jinaCtrl.abort(), 55_000);
    const r = await fetch(endpoint, {
      headers,
      redirect: "follow",
      signal: jinaCtrl.signal,
    }).finally(() => clearTimeout(jinaT));
    if (!r.ok) {
      console.error("Jina Reader HTTP", r.status, pageUrl.slice(0, 80));
      return null;
    }
    const text = await r.text();
    return text.trim().length > 80 ? text : null;
  } catch (e) {
    console.error("Jina Reader error", e);
    return null;
  }
}

/** Pull "Label: value" lines from markdown/plain job pages (Jina Reader, etc.). */
function extractLabeledField(text: string, labels: string[]): string {
  if (!text.trim()) return "";
  const alt = labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const sameLine = new RegExp(
    `(?:^|\\n)\\s*(?:\\*\\*)?(?:${alt})(?:\\*\\*)?\\s*:\\s*(.+?)(?=\\n|$)`,
    "im",
  );
  const sameLineValue = text.match(sameLine)?.[1]?.trim() ?? "";
  let v = sameLineValue;
  if (!v || v.length < 2) {
    const nextLine = new RegExp(
      `(?:^|\\n)\\s*(?:\\*\\*)?(?:${alt})(?:\\*\\*)?\\s*:?\\s*\\n+\\s*([^\\n#]{2,500})`,
      "im",
    );
    v = text.match(nextLine)?.[1]?.trim() ?? "";
  }
  v = v.replace(/^:\s*/, "").replace(/\s+/g, " ").trim();
  return v.length > 500 ? v.slice(0, 500) + "…" : v;
}

const CLIP = 400;

/** When JSON-LD / labeled lines miss location, pull it from prose (Jina markdown, ATS dumps, etc.). */
function inferLocationFromFreeText(text: string): string {
  if (!text || text.length < 3) return "";
  const candidates: RegExp[] = [
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
  for (const re of candidates) {
    const m = text.match(re);
    const v = (m && (m[1] ?? m[0]))?.trim();
    if (!v) continue;
    if (/^https?:\/\//i.test(v)) continue;
    if (v.length >= 2) {
      return v.length > CLIP ? `${v.slice(0, CLIP)}…` : v;
    }
  }
  return "";
}

/** Salary/compensation line often only appears in body text. */
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
  const md = text.match(
    /\*\*(?:Salary|Compensation)\*\*\s*:?\s*([^\n*]{3,200})/i,
  );
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

/** Title + body: location is often in the reader title line or first screenful, not only the long description. */
function inferenceCorpus(p: Parsed): string {
  return [p.job_title, p.job_description].filter(Boolean).join("\n").slice(0, 25_000);
}

const SENIORITY_TOKENS =
  /\b(Intern(?:ship)?|Junior|Jnr\.?|Associate|Mid[-\s]?Level|Mid|Intermediate|Senior|Sr\.?|Staff|Principal|Lead|Manager|Director|VP|Vice President|Executive|Head of)\b/i;

/** Prefer explicit ATS lines; avoids inventing "Senior" from prose. */
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

/** Flattened HTML often concatenates the next section on the same line (e.g. "Austin, TX About the role"). */
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

/** Well-known US cities that often appear without a state in ATS snippets. Keep in sync with src/lib/jobExtraction.ts */
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

/** Append ", ST" when value is a known US city (or trailing segment) and no state/DC is present. */
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

/** Trailing segment spelled as full state name → USPS abbreviation (e.g. California → CA). Keep in sync with src/lib/jobExtraction.ts */
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

/** og: / JSON-LD sometimes sets location to workplace category only — allow body inference to replace it. */
function isPlaceholderLocation(value: string): boolean {
  const t = value.trim();
  if (!t) return true;
  if (t.length <= 2) return true;
  if (/^(n\/?a|tbd|tbc|not specified|unspecified|see (the )?posting|various|multiple)$/i.test(t)) return true;
  if (/^(in[-\s]?office|on[-\s]?site)$/i.test(t)) return true;
  return false;
}

/** Fill structured fields from description when still empty (common on Greenhouse, LinkedIn, Jina). */
function enrichParsedFromDescription(p: Parsed): Parsed {
  const corpus = inferenceCorpus(p);
  const job_title = inferSeniorityForTitle(p.job_title, corpus);
  let location = (p.location || "").trim();
  let salary_range = (p.salary_range || "").trim();
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
  return { ...p, job_title, location, salary_range };
}

/** Parse r.jina.ai plain-text / markdown response into job fields. */
function parseJinaReaderText(raw: string, pageUrl: string): Parsed {
  const titleLine = raw.match(/^Title:\s*(.+)$/im);
  let job_title = titleLine?.[1]?.trim() || "";

  const mc = raw.match(/Markdown Content:\s*\n([\s\S]+)/i);
  let body = (mc?.[1] ?? raw).trim();
  body = body.replace(/^Warning:.*\n?/gim, "").trim();

  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) {
    if (!job_title) job_title = h1[1].trim();
    body = body.replace(/^#\s+.+\n?/m, "").trim();
  }

  const jobApp = job_title.match(/^Job Application for\s+(.+?)\s+at\s+(.+)$/i);
  let company_name = companyFromGreenhouseJobPath(pageUrl) || "";
  if (jobApp) {
    job_title = jobApp[1].trim();
    company_name = jobApp[2].replace(/\s*\([^)]*\)\s*$/, "").trim();
  }

  if (!company_name) {
    const fromAt = extractCompanyFromTitleAtSuffix(job_title);
    if (fromAt) company_name = fromAt;
    else company_name = organizationSlugFromAshbyJobUrl(pageUrl) || "";
  }
  if (!company_name) {
    try {
      company_name = guessCompanyFromHost(new URL(pageUrl).hostname);
    } catch {
      company_name = "Company";
    }
  }

  job_title = stripRoleAtCompanySuffix(job_title);
  if (!job_title) job_title = "Open role";

  const job_description = body.slice(0, 15_000) || raw.slice(0, 15_000) || `Source: ${pageUrl}`;

  const location = extractLabeledField(body, [
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
  ]);

  let salary_range = extractLabeledField(body, [
    "Salary",
    "Salary range",
    "Compensation",
    "Pay range",
    "Pay",
    "Base salary",
    "Estimated salary",
  ]);
  if (!salary_range) salary_range = inferSalaryFromFreeText(body);

  return enrichParsedFromDescription({
    company_name,
    job_title,
    job_description,
    location,
    salary_range,
  });
}

/** Remove trailing "| Greenhouse" / "| LinkedIn" or duplicate "| Company" when we already have company_name. */
function refineJobTitle(job_title: string, company_name: string): string {
  let t = job_title.replace(/\s+/g, " ").trim();
  if (!t) return t;
  const c = company_name.trim();
  if (c.length >= 2) {
    const esc = c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(`\\s*[|·]\\s*${esc}\\s*$`, "i"), "").trim();
    t = t.replace(new RegExp(`\\s+at\\s+${esc}\\s*$`, "i"), "").trim();
    t = t.replace(new RegExp(`\\s@\\s*${esc}\\s*$`, "i"), "").trim();
  }
  t = t.replace(/\s*(\||\u2013|-)\s*(Greenhouse|Lever|Workday|LinkedIn|Indeed|Glassdoor)\s*$/i, "").trim();
  return t || job_title;
}

function parseHtmlPage(html: string, pageUrl: string): Parsed {
  const ld = parseJsonLdJobPosting(html);
  const ogTitle = metaTag(html, "property", "og:title");
  const ogDesc = metaTag(html, "property", "og:description") || metaTag(html, "name", "description");
  const site = metaTag(html, "property", "og:site_name");
  const tit = titleTag(html);

  let job_title = ld?.job_title?.trim() || ogTitle?.trim() || "";
  if (!job_title && tit) {
    job_title = tit.replace(/\s*[|\u2013-]\s*.+$/, "").trim() || tit;
  }
  job_title = stripRoleAtCompanySuffix(job_title);
  if (!job_title) job_title = "Open role";

  let company_name = ld?.company_name?.trim() || site?.trim() || "";
  if (!company_name) {
    company_name = companyFromGreenhouseJobPath(pageUrl) || "";
  }
  if (!company_name) {
    company_name = companyFromAshbyPage(html, pageUrl) || organizationSlugFromAshbyJobUrl(pageUrl) || "";
  }
  if (!company_name) {
    try {
      company_name = guessCompanyFromHost(new URL(pageUrl).hostname);
    } catch {
      company_name = "Company";
    }
  }

  job_title = refineJobTitle(job_title, company_name);

  // Greenhouse often sets og:description to a short tagline ("In-Office"); prefer the richest source.
  const ldDesc = ld?.job_description?.trim() || "";
  const ogDescTrim = ogDesc?.trim() || "";
  const stripped = stripToText(html, 12000);
  const descCandidates = [ldDesc, ogDescTrim, stripped].filter((s) => s.length > 0);
  let job_description = descCandidates.reduce((best, cur) => (cur.length > best.length ? cur : best), "");
  if (!job_description) {
    job_description = `Source: ${pageUrl}`;
  }

  const location = ld?.location?.trim() || "";
  const salary_range = ld?.salary_range?.trim() || "";

  return enrichParsedFromDescription({
    company_name,
    job_title,
    job_description,
    location,
    salary_range,
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("authorization")?.trim();
    const bearer = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!bearer) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );

    // Pass JWT explicitly — global headers on the client are not always applied to getUser() in Edge.
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(bearer);
    if (authError || !user) {
      console.error("parse-job-url auth failed", authError?.message ?? "no user");
      return new Response(JSON.stringify({ error: "Invalid auth" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { url } = await req.json();
    if (!url || typeof url !== "string") {
      return new Response(JSON.stringify({ error: "Missing url" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let target: URL;
    try {
      target = new URL(url.trim());
    } catch {
      return new Response(JSON.stringify({ error: "Invalid URL" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return new Response(JSON.stringify({ error: "Only http(s) URLs" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 0) Ashby SPA — use the public posting API directly; HTML scraping yields nothing useful.
    const ashbyRef = parseAshbyJobUrl(target.href);
    if (ashbyRef) {
      const ashbyJob = await fetchAshbyJobFromApi(ashbyRef.orgSlug, ashbyRef.jobId);
      if (ashbyJob && (ashbyJob.job_title || ashbyJob.company_name)) {
        const full: Parsed = enrichParsedFromDescription({
          company_name: ashbyJob.company_name || "",
          job_title: ashbyJob.job_title || "",
          job_description: ashbyJob.job_description || "",
          location: ashbyJob.location || "",
          salary_range: ashbyJob.salary_range || "",
        });
        return new Response(serializeParsed(full), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // API failed — fall through to Jina Reader / generic scrape as best-effort
      console.warn("Ashby API returned no data for", ashbyRef.orgSlug, ashbyRef.jobId, "— falling back to Jina");
    }

    // 1) Direct fetch from Supabase edge (fast; often blocked by ATS / bot protection).
    // 2) Fallback: Jina Reader (r.jina.ai) fetches from their network — set secret JINA_API_KEY if you hit rate limits.
    const browserHeaders = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    };

    let res: Response;
    const directCtrl = new AbortController();
    const directT = setTimeout(() => directCtrl.abort(), 45_000);
    try {
      res = await fetch(target.href, {
        headers: browserHeaders,
        redirect: "follow",
        signal: directCtrl.signal,
      });
    } catch (e) {
      console.error("Direct fetch network error", e);
      const jina = await fetchViaJinaReader(target.href);
      if (jina) {
        const parsed = await withGreenhousePublicApi(parseJinaReaderText(jina, target.href), target.href, browserHeaders);
        return new Response(serializeParsed(parsed), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "Could not fetch URL (network). Try again or paste the description." }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } finally {
      clearTimeout(directT);
    }

    const ct = res.headers.get("content-type") || "";
    const isHtml = ct.includes("text/html") || ct.includes("application/xhtml");

    if (!res.ok || !isHtml) {
      const jina = await fetchViaJinaReader(target.href);
      if (jina) {
        const parsed = await withGreenhousePublicApi(parseJinaReaderText(jina, target.href), target.href, browserHeaders);
        return new Response(serializeParsed(parsed), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!res.ok) {
        return new Response(
          JSON.stringify({
            error: `Fetch failed: ${res.status}. Direct request blocked; Jina Reader fallback also failed. Add JINA_API_KEY or paste the posting manually.`,
          }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "URL did not return HTML" }), {
        status: 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const html = await res.text();
    if (html.length > 2_500_000) {
      return new Response(JSON.stringify({ error: "Page too large" }), {
        status: 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // SPA shells and bot challenges often yield almost no visible text after script strip.
    const visibleText = stripToText(html, 80_000);
    const thinPage = visibleText.length < 450;

    if (thinPage) {
      const jina = await fetchViaJinaReader(target.href);
      if (jina && jina.length > 200) {
        const parsed = await withGreenhousePublicApi(parseJinaReaderText(jina, target.href), target.href, browserHeaders);
        return new Response(serializeParsed(parsed), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const parsed = await withGreenhousePublicApi(parseHtmlPage(html, target.href), target.href, browserHeaders);

    return new Response(serializeParsed(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Parse failed" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
