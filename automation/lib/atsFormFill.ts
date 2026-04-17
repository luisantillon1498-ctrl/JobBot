import * as fs from "node:fs";
import type { Page } from "@playwright/test";
import type { ApplicantPayload } from "../types";

/** ATS modules that share the same mapping/fill pipeline */
export type AtsPlanSite = "greenhouse" | "workday" | "ashby";

export type FillReport = {
  applied: Record<string, string>;
  skippedEmpty: string[];
  notFound: string[];
  filesUploaded: string[];
  fieldMappings: Record<string, string>;
  changeLog: Array<{
    field: string;
    selector: string;
    previousValue: string;
    nextValue: string;
    overwritten: boolean;
  }>;
  mappingPlan: FieldMappingPlan;
};

type FillAttemptResult = { matched: false } | { matched: true; selector: string; previousValue: string; overwritten: boolean };

export type SupportedFieldKey =
  | "first_name"
  | "last_name"
  | "email"
  | "phone"
  | "linkedin_url"
  | "resume_path"
  | "cover_letter_path"
  | "location"
  | "work_authorization"
  | "salary_expectations";

type CandidateField = {
  selector: string;
  tag: string;
  inputType: string;
  name: string;
  id: string;
  placeholder: string;
  ariaLabel: string;
  labelText: string;
  accept: string;
  contextText: string;
  dataAutomationId: string;
  title: string;
};

type MappedField = {
  target: SupportedFieldKey;
  selector: string;
  confidence: "high" | "medium";
  matchedBy: string[];
  candidateSummary: string;
};

type MappingIssue = {
  target: SupportedFieldKey;
  reason: "not_found" | "ambiguous" | "missing_payload" | "low_confidence";
  details: string;
  candidateSelectors?: string[];
};

export type FieldMappingPlan = {
  version: "1.0";
  site: AtsPlanSite;
  strategy: {
    normalization: string[];
    matching: string[];
    fallback: string;
  };
  extractedFields: Array<{
    selector: string;
    inputType: string;
    label: string;
    name: string;
    placeholder: string;
  }>;
  mapped: MappedField[];
  issues: MappingIssue[];
};

const ORDERED_TARGETS: SupportedFieldKey[] = [
  "first_name",
  "last_name",
  "email",
  "phone",
  "linkedin_url",
  "resume_path",
  "cover_letter_path",
  "location",
  "work_authorization",
  "salary_expectations",
];

const BASE_FIELD_PATTERNS: Record<SupportedFieldKey, RegExp[]> = {
  first_name: [/\blegal first name\b/i, /\bfirst name\b/i, /\bgiven name\b/i, /\bforename\b/i, /\bpreferred name\b/i],
  last_name: [/\blast name\b/i, /\bfamily name\b/i, /\bsurname\b/i],
  email: [/\bemail\b/i, /\be-mail\b/i],
  phone: [/\bphone number\b/i, /\bphone\b/i, /\bmobile number\b/i, /\bmobile\b/i, /\bcell\b/i],
  linkedin_url: [/\blinkedin\b/i, /\blinkedin profile\b/i, /\bportfolio\b/i, /\bwebsite\b/i],
  resume_path: [/\bresume\b/i, /\bcv\b/i, /\bupload resume\b/i, /\bupload cv\b/i, /\bupload file\b/i],
  cover_letter_path: [/\bcover letter\b/i, /\bupload cover letter\b/i],
  location: [/\blocation\b/i, /\bcity\b/i, /\baddress\b/i, /\bcurrent location\b/i],
  work_authorization: [/\bwork authorization\b/i, /\bauthorized to work\b/i, /\bvisa sponsorship\b/i, /\brequire sponsorship\b/i],
  salary_expectations: [/\bsalary expectations?\b/i, /\bdesired salary\b/i, /\bcompensation expectations?\b/i],
};

/** Extra positive signals per ATS (labels, data attrs, common vendor copy). */
const SITE_FIELD_PATTERN_EXTRA: Record<AtsPlanSite, Partial<Record<SupportedFieldKey, RegExp[]>>> = {
  greenhouse: {},
  workday: {
    first_name: [/\blegal name\b.*\bfirst\b/i, /\bfirst\b.*\blegal\b/i],
    last_name: [/\blegal name\b.*\blast\b/i, /\blast\b.*\blegal\b/i],
    email: [/\bcontact email\b/i],
    phone: [/\bphone device\b/i, /\bhome phone\b/i],
    resume_path: [/\battach\b.*\bresume\b/i, /\bcv\b.*\battach\b/i],
    linkedin_url: [/\blinkedin url\b/i],
    location: [/\bcountry phone code\b/i],
  },
  ashby: {
    first_name: [/\blegal first name\b/i],
    last_name: [/\blegal last name\b/i],
    email: [/\bemail address\b/i],
    phone: [/\bphone number\b/i],
    linkedin_url: [/\blinkedin profile url\b/i, /\blinkedin url\b/i],
    resume_path: [/\bresume file\b/i, /\bupload your resume\b/i],
    cover_letter_path: [/\bcover letter file\b/i],
    location: [/\blocation\b/i],
  },
};

const SITE_ID_BAG_EXTRA_SCORE: Partial<
  Record<AtsPlanSite, Partial<Record<SupportedFieldKey, RegExp[]>>>
> = {
  workday: {
    first_name: [/firstName/i, /legalName.*first/i, /candidateFirstName/i],
    last_name: [/lastName/i, /legalName.*last/i, /candidateLastName/i],
    email: [/candidateEmail/i, /emailAddress/i],
    phone: [/phoneNumber/i, /phoneDevice/i],
    resume_path: [/resume/i, /attachment/i],
    cover_letter_path: [/coverLetter/i],
    linkedin_url: [/linkedIn/i, /linkedin/i],
    location: [/location/i, /addressLine/i],
  },
  ashby: {
    first_name: [/firstName/i, /firstname/i],
    last_name: [/lastName/i, /lastname/i],
    email: [/email/i],
    phone: [/phone/i],
    resume_path: [/resume/i],
    cover_letter_path: [/cover/i],
    linkedin_url: [/linkedin/i],
  },
  greenhouse: {},
};

const NEGATIVE_PATTERNS: Partial<Record<SupportedFieldKey, RegExp[]>> = {
  first_name: [/\blast name\b/i, /\bsurname\b/i],
  last_name: [/\bfirst name\b/i, /\bgiven name\b/i, /\bpreferred name\b/i],
  phone: [/\bfax\b/i],
  resume_path: [/\bcover letter\b/i],
  cover_letter_path: [/\bresume\b/i, /\bcv\b/i],
};

function fieldPatternsForSite(site: AtsPlanSite, target: SupportedFieldKey): RegExp[] {
  const base = BASE_FIELD_PATTERNS[target] ?? [];
  const extra = SITE_FIELD_PATTERN_EXTRA[site]?.[target] ?? [];
  return [...base, ...extra];
}

function normalizeText(raw: string): string {
  return raw.toLowerCase().replace(/[_\-:/]+/g, " ").replace(/\s+/g, " ").trim();
}

function scoreCandidate(site: AtsPlanSite, target: SupportedFieldKey, c: CandidateField): { score: number; matchedBy: string[] } {
  let score = 0;
  const matchedBy: string[] = [];
  const bag = normalizeText(
    [c.labelText, c.placeholder, c.ariaLabel, c.name, c.id, c.contextText, c.accept, c.dataAutomationId, c.title].join(" "),
  );

  for (const pattern of fieldPatternsForSite(site, target)) {
    if (pattern.test(bag)) {
      score += 4;
      matchedBy.push(`pattern:${pattern.source}`);
    }
  }

  const idBag = `${c.id} ${c.name} ${c.dataAutomationId} ${c.title}`;
  for (const pattern of SITE_ID_BAG_EXTRA_SCORE[site]?.[target] ?? []) {
    if (pattern.test(idBag)) {
      score += 3;
      matchedBy.push(`id:${pattern.source}`);
    }
  }

  for (const pattern of NEGATIVE_PATTERNS[target] ?? []) {
    if (pattern.test(bag)) {
      score -= 5;
      matchedBy.push(`negative:${pattern.source}`);
    }
  }

  if (target === "resume_path" || target === "cover_letter_path") {
    if (c.tag === "input" && c.inputType === "file") score += 3;
  } else if (c.inputType === "file") {
    score -= 3;
  }

  if (target === "work_authorization" && (c.tag === "select" || c.inputType === "radio" || c.inputType === "checkbox")) {
    score += 1;
  }
  if (target === "salary_expectations" && (c.inputType === "number" || c.inputType === "text")) {
    score += 1;
  }

  return { score, matchedBy };
}

async function extractFieldCandidates(page: Page): Promise<CandidateField[]> {
  return page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll("input, textarea, select"));
    return controls.map((el, idx) => {
      const tag = el.tagName.toLowerCase();
      const input = el as HTMLInputElement;
      const inputType = tag === "input" ? (input.type || "text").toLowerCase() : tag;
      const id = el.id || "";
      const name = el.getAttribute("name") ?? "";
      const ariaLabel = el.getAttribute("aria-label") ?? "";
      const dataAutomationId = el.getAttribute("data-automation-id") ?? "";
      const title = el.getAttribute("title") ?? "";
      const placeholder = (el as HTMLInputElement).placeholder ?? "";
      const accept = input.accept ?? "";
      const labelFromFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent ?? "" : "";
      const wrappingLabel = el.closest("label")?.textContent ?? "";
      const contextText = el.closest("fieldset, .field, .form-field, .question, [data-automation-id]")?.textContent ?? "";

      if (!id && !name) el.setAttribute("data-jobbot-idx", String(idx));
      const selector = id ? `${tag}#${id}` : name ? `${tag}[name="${name}"]` : `${tag}[data-jobbot-idx="${idx}"]`;

      return {
        selector,
        tag,
        inputType,
        name,
        id,
        placeholder,
        ariaLabel,
        labelText: `${labelFromFor} ${wrappingLabel}`.trim(),
        accept,
        contextText: contextText.slice(0, 280),
        dataAutomationId,
        title,
      };
    });
  });
}

function payloadValueForTarget(payload: ApplicantPayload, target: SupportedFieldKey): string | undefined {
  return payload[target];
}

function buildMappingPlan(site: AtsPlanSite, candidates: CandidateField[], payload: ApplicantPayload): FieldMappingPlan {
  const mapped: MappedField[] = [];
  const issues: MappingIssue[] = [];

  for (const target of ORDERED_TARGETS) {
    const scored = candidates
      .map((candidate) => ({ candidate, ...scoreCandidate(site, target, candidate) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      issues.push({ target, reason: "not_found", details: "No candidate fields matched normalized aliases." });
      continue;
    }

    const top = scored[0];
    const runnerUp = scored[1];
    if (runnerUp && runnerUp.score === top.score) {
      issues.push({
        target,
        reason: "ambiguous",
        details: "Multiple top-scoring candidate selectors found.",
        candidateSelectors: [top.candidate.selector, runnerUp.candidate.selector],
      });
      continue;
    }

    const confidence: "high" | "medium" = top.score >= 7 ? "high" : "medium";
    mapped.push({
      target,
      selector: top.candidate.selector,
      confidence,
      matchedBy: top.matchedBy,
      candidateSummary: [top.candidate.labelText, top.candidate.placeholder, top.candidate.name, top.candidate.id]
        .filter(Boolean)
        .join(" | "),
    });

    const payloadValue = payloadValueForTarget(payload, target)?.trim();
    if (!payloadValue) {
      issues.push({
        target,
        reason: "missing_payload",
        details: "Mapped field has no payload value.",
        candidateSelectors: [top.candidate.selector],
      });
    } else if (confidence !== "high") {
      issues.push({
        target,
        reason: "low_confidence",
        details: "Mapped candidate exists but confidence is below auto-fill threshold.",
        candidateSelectors: [top.candidate.selector],
      });
    }
  }

  return {
    version: "1.0",
    site,
    strategy: {
      normalization: [
        "Normalize label/name/id/placeholder/aria/context text to lowercase with punctuation collapsed.",
        "Include data-automation-id and title where present (Workday / vendor widgets).",
        "Apply alias dictionary across common field variants (e.g., legal first name, preferred name, mobile, CV, upload file).",
      ],
      matching: [
        "Score each candidate with target-specific positive and negative regex patterns.",
        "Use element type hints (file input for uploads, select/radio/checkbox hints for authorization).",
        "Require unique top-scoring candidate for deterministic mapping.",
      ],
      fallback:
        "If ambiguous, missing, or low confidence, keep the field unmapped for auto-fill and emit issue metadata for manual review/approval.",
    },
    extractedFields: candidates.map((c) => ({
      selector: c.selector,
      inputType: c.inputType,
      label: c.labelText,
      name: c.name,
      placeholder: c.placeholder,
    })),
    mapped,
    issues,
  };
}

async function fillWithPlan(page: Page, mapped: MappedField, value: string): Promise<FillAttemptResult> {
  const loc = page.locator(mapped.selector).first();
  if ((await loc.count()) === 0) return { matched: false };
  const previousValue = ((await loc.inputValue().catch(() => "")) ?? "").trim();
  const overwritten = previousValue.length > 0 && previousValue !== value;

  if (mapped.target === "resume_path" || mapped.target === "cover_letter_path") {
    if (!fs.existsSync(value)) return { matched: false };
    await loc.setInputFiles(value);
  } else {
    await loc.fill(value);
  }

  return { matched: true, selector: mapped.selector, previousValue, overwritten };
}

/**
 * Best-effort fill for supported ATS job forms. Does not submit.
 * High-confidence matches only; skips missing fields without throwing.
 */
export async function fillAtsApplicationForm(page: Page, payload: ApplicantPayload, site: AtsPlanSite): Promise<FillReport> {
  const applied: Record<string, string> = {};
  const skippedEmpty: string[] = [];
  const notFound: string[] = [];
  const filesUploaded: string[] = [];
  const fieldMappings: Record<string, string> = {};
  const changeLog: FillReport["changeLog"] = [];
  const candidates = await extractFieldCandidates(page);
  const mappingPlan = buildMappingPlan(site, candidates, payload);
  const mappedByTarget = new Map<SupportedFieldKey, MappedField>(mappingPlan.mapped.map((m) => [m.target, m]));

  for (const target of ORDERED_TARGETS) {
    const value = payloadValueForTarget(payload, target)?.trim();
    if (!value) {
      skippedEmpty.push(target);
      continue;
    }

    const mapped = mappedByTarget.get(target);
    if (!mapped || mapped.confidence !== "high") {
      notFound.push(target);
      continue;
    }

    const result = await fillWithPlan(page, mapped, value);
    if (!result.matched) {
      notFound.push(target);
      continue;
    }

    applied[target] = value;
    fieldMappings[target] = result.selector;
    if (target === "resume_path" || target === "cover_letter_path") {
      filesUploaded.push(value);
    }
    changeLog.push({
      field: target,
      selector: result.selector,
      previousValue: result.previousValue,
      nextValue: value,
      overwritten: result.overwritten,
    });
  }

  return { applied, skippedEmpty, notFound, filesUploaded, fieldMappings, changeLog, mappingPlan };
}
