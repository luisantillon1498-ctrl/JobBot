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
  /** Required fields detected on the form that were not filled by the automation. */
  unfilledRequired: Array<{ field: string; label: string; selector: string }>;
};

type FillAttemptResult = { matched: false } | { matched: true; selector: string; previousValue: string; overwritten: boolean };

export type SupportedFieldKey =
  | "full_name"
  | "first_name"
  | "last_name"
  | "email"
  | "phone"
  | "linkedin_url"
  | "resume_path"
  | "cover_letter_path"
  | "location"
  | "work_authorization"
  | "salary_expectations"
  | "gender"
  | "hispanic_ethnicity"
  | "race_ethnicity"
  | "veteran_status"
  | "disability_status"
  | "country";

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
  required: boolean;
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
  "full_name",
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
  "gender",
  "hispanic_ethnicity",
  "race_ethnicity",
  "veteran_status",
  "disability_status",
  "country",
];

const BASE_FIELD_PATTERNS: Record<SupportedFieldKey, RegExp[]> = {
  full_name: [
    /\bfull name\b/i, /\byour name\b/i, /\bname\b/i,
  ],
  first_name: [
    /\blegal first name\b/i, /\bfirst name\b/i, /\bgiven name\b/i,
    /\bforename\b/i, /\bpreferred name\b/i, /\bfirst\b/i,
  ],
  last_name: [
    /\blast name\b/i, /\bfamily name\b/i, /\bsurname\b/i, /\blast\b/i,
  ],
  email: [
    /\bemail address\b/i, /\bemail\b/i, /\be-mail\b/i,
    /\bcontact email\b/i, /\bwork email\b/i,
  ],
  phone: [
    /\bphone number\b/i, /\bphone\b/i, /\bmobile number\b/i,
    /\bmobile\b/i, /\bcell\b/i, /\btelephone\b/i, /\bcontact number\b/i,
  ],
  linkedin_url: [
    /\blinkedin profile url\b/i, /\blinkedin url\b/i, /\blinkedin\b/i,
    /\blinkedin profile\b/i, /\bportfolio url\b/i, /\bportfolio\b/i,
    /\bwebsite url\b/i, /\bpersonal website\b/i,
  ],
  resume_path: [
    /\bupload resume\b/i, /\bupload your resume\b/i, /\battach resume\b/i,
    /\bresume\b/i, /\bcv\b/i, /\bupload cv\b/i, /\battach cv\b/i,
    /\bupload file\b/i, /\bresume file\b/i,
  ],
  cover_letter_path: [
    /\bcover letter\b/i, /\bupload cover letter\b/i, /\battach cover letter\b/i,
    /\bcover letter file\b/i,
  ],
  location: [
    /\bcurrent location\b/i, /\bcity.*state\b/i, /\bcity\b/i,
    /\blocation\b/i, /\baddress\b/i, /\bwhere are you located\b/i,
  ],
  work_authorization: [
    /\bwork authorization\b/i, /\bauthorized to work\b/i,
    /\brequire.*sponsorship\b/i, /\bvisa sponsorship\b/i,
    /\bsponsorship required\b/i, /\blegally authorized\b/i,
    /\bwork.*permit\b/i, /\bright to work\b/i,
  ],
  salary_expectations: [
    /\bsalary expectations?\b/i, /\bdesired salary\b/i,
    /\bcompensation expectations?\b/i, /\bexpected salary\b/i,
    /\bpay expectations?\b/i,
  ],
  gender: [
    /\bgender\b/i, /\bgender identity\b/i, /\bsex\b/i,
  ],
  hispanic_ethnicity: [
    /\bhispanic\b/i, /\blatino\b/i, /\blatina\b/i,
    /\bare you hispanic\b/i, /\bhispanic.*latino\b/i,
  ],
  race_ethnicity: [
    /\brace\b/i, /\bethnicity\b/i, /\brace.*ethnicity\b/i,
    /\bethnic.*background\b/i, /\brace\/ethnicity\b/i,
  ],
  veteran_status: [
    /\bveteran status\b/i, /\bprotected veteran\b/i, /\bvevraa\b/i,
    /\bmilitary status\b/i, /\bveteran\b/i,
  ],
  disability_status: [
    /\bdisability status\b/i, /\bhave a disability\b/i,
    /\bdisabilit/i, /\baccommodation\b/i,
  ],
  country: [
    /\bcountry\b/i, /\bcountry of residence\b/i,
    /\bcountry where you live\b/i, /\bwhere do you (live|reside)\b/i,
  ],
};

/** Extra positive signals per ATS (labels, data attrs, common vendor copy). */
const SITE_FIELD_PATTERN_EXTRA: Record<AtsPlanSite, Partial<Record<SupportedFieldKey, RegExp[]>>> = {
  // Greenhouse label text is straightforward; ID patterns handle scoring (see SITE_ID_BAG_EXTRA_SCORE).
  greenhouse: {
    first_name:       [/\bfirst name\b/i, /\blegal first\b/i],
    last_name:        [/\blast name\b/i, /\blegal last\b/i],
    email:            [/\bemail\b/i],
    phone:            [/\bphone\b/i],
    resume_path:      [/\bresume\b/i],
    cover_letter_path:[/\bcover letter\b/i],
    location:         [/\blocation\b/i],
    linkedin_url:     [/\blinkedin\b/i, /\bwebsite\b/i],
    work_authorization:[/\bauthorized\b/i, /\bsponsorship\b/i, /\bwork authorization\b/i],
    veteran_status:    [/\bveteran\b/i, /\bprotected veteran\b/i, /\bself.identify.*veteran\b/i],
    disability_status: [/\bdisabilit/i, /\bself.identify.*disabilit\b/i],
    gender:            [/\bgender\b/i],
    hispanic_ethnicity:[/\bhispanic\b/i, /\blatino\b/i],
    race_ethnicity:    [/\brace\b/i, /\bethnicity\b/i],
    country:           [/\bcountry\b/i],
  },
  workday: {
    first_name:       [/\blegal name\b.*\bfirst\b/i, /\bfirst\b.*\blegal\b/i, /\bfirst name\b/i],
    last_name:        [/\blegal name\b.*\blast\b/i, /\blast\b.*\blegal\b/i, /\blast name\b/i],
    email:            [/\bcontact email\b/i, /\bemail address\b/i],
    phone:            [/\bphone device\b/i, /\bhome phone\b/i, /\bphone number\b/i],
    resume_path:      [/\battach\b.*\bresume\b/i, /\bcv\b.*\battach\b/i, /\bupload resume\b/i],
    cover_letter_path:[/\bcover letter\b/i, /\battach.*cover\b/i],
    linkedin_url:     [/\blinkedin url\b/i, /\blinkedin profile\b/i],
    location:         [/\bcity\b/i, /\bstate\b/i, /\baddress line\b/i],
    work_authorization:[/\bwork authorization\b/i, /\bauthorized to work\b/i, /\bvisa\b/i],
    salary_expectations:[/\bsalary\b/i, /\bcompensation\b/i],
    veteran_status:    [/\bveteran\b/i, /\bprotected veteran\b/i],
    disability_status: [/\bdisabilit/i],
    gender:            [/\bgender\b/i],
    country:           [/\bcountry\b/i],
  },
  ashby: {
    full_name:        [/\bfull name\b/i, /\byour name\b/i, /\bname\b/i],
    first_name:       [/\blegal first name\b/i, /\bfirst name\b/i],
    last_name:        [/\blegal last name\b/i, /\blast name\b/i],
    email:            [/\bemail address\b/i, /\bemail\b/i],
    phone:            [/\bphone number\b/i, /\bphone\b/i],
    linkedin_url:     [/\blinkedin profile url\b/i, /\blinkedin url\b/i, /\blinkedin\b/i],
    resume_path:      [/\bresume file\b/i, /\bupload your resume\b/i, /\bresume\b/i],
    cover_letter_path:[/\bcover letter file\b/i, /\bcover letter\b/i],
    location:         [/\blocation\b/i, /\bcity\b/i],
    work_authorization:[/\bwork authorization\b/i, /\bauthorized\b/i],
    race_ethnicity:   [/\brace\b/i, /\bethnicity\b/i],
    veteran_status:    [/\bveteran\b/i],
    disability_status: [/\bdisabilit/i],
    gender:            [/\bgender\b/i],
    hispanic_ethnicity:[/\bhispanic\b/i],
  },
};

const SITE_ID_BAG_EXTRA_SCORE: Partial<
  Record<AtsPlanSite, Partial<Record<SupportedFieldKey, RegExp[]>>>
> = {
  // Greenhouse IDs are the POST param names — exact matches give a big score boost.
  greenhouse: {
    first_name:        [/^first_name$/i, /^first\.?name$/i],
    last_name:         [/^last_name$/i,  /^last\.?name$/i],
    email:             [/^email$/i],
    phone:             [/\bphone\b/i],
    resume_path:       [/^resume$/i],
    cover_letter_path: [/^cover_letter$/i],
    location:          [/^(candidate[_-]?)?location$/i],
    linkedin_url:      [/linkedin/i],
    work_authorization:[/work_?auth/i, /sponsorship/i],
    veteran_status:     [/^veteran_status$/i, /veteran/i],
    disability_status:  [/^disability_status$/i, /disability/i],
    gender:             [/^gender$/i],
    hispanic_ethnicity: [/^hispanic_ethnicity$/i, /^hispanic$/i],
    race_ethnicity:     [/^race$/i, /race_ethnicity/i],
    country:            [/^country$/i],
  },
  // Workday uses data-automation-id starting with "formField-" and camelCase suffixes.
  workday: {
    first_name:        [/firstName/i, /legalName.*first/i, /candidateFirstName/i, /formField.*first/i],
    last_name:         [/lastName/i, /legalName.*last/i, /candidateLastName/i, /formField.*last/i],
    email:             [/candidateEmail/i, /emailAddress/i, /formField.*email/i],
    phone:             [/phoneNumber/i, /phoneDevice/i, /formField.*phone/i],
    resume_path:       [/resume/i, /attachment/i, /file-upload/i],
    cover_letter_path: [/coverLetter/i, /cover.*letter/i],
    linkedin_url:      [/linkedIn/i, /linkedin/i],
    location:          [/location/i, /addressLine/i, /formField.*location/i],
    work_authorization:[/workAuth/i, /authorization/i, /sponsorship/i],
    salary_expectations:[/salary/i, /compensation/i],
  },
  // Ashby uses _systemfield_* names in their API; DOM IDs vary but follow similar patterns.
  ashby: {
    full_name:         [/_systemfield_name/i, /^name$/i],
    first_name:        [/firstName/i, /firstname/i],
    last_name:         [/lastName/i, /lastname/i],
    email:             [/email/i, /_systemfield_email/i],
    phone:             [/phone/i, /_systemfield_phone/i],
    resume_path:       [/resume/i, /_systemfield_resume/i],
    cover_letter_path: [/cover/i],
    linkedin_url:      [/linkedin/i, /_systemfield_linkedin/i],
    location:          [/location/i, /_systemfield_location/i],
    race_ethnicity:    [/_systemfield_race/i, /race/i],
  },
};

const NEGATIVE_PATTERNS: Partial<Record<SupportedFieldKey, RegExp[]>> = {
  full_name: [/\bfirst\b/i, /\blast\b/i, /\bfamily\b/i, /\bgiven\b/i, /\bpreferred\b/i],
  first_name: [/\blast name\b/i, /\bsurname\b/i],
  last_name: [/\bfirst name\b/i, /\bgiven name\b/i, /\bpreferred name\b/i],
  phone: [/\bfax\b/i],
  resume_path: [/\bcover letter\b/i],
  cover_letter_path: [/\bresume\b/i, /\bcv\b/i],
  race_ethnicity: [/\bhispanic\b/i, /\blatino\b/i, /\blatina\b/i],
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

  // Type hints only sharpen the decision between already-matched candidates.
  // Guard score > 0 prevents every bare text input from creating a false-positive tie.
  if (score > 0 && target === "work_authorization" && (c.tag === "select" || c.inputType === "radio" || c.inputType === "radio_group" || c.inputType === "checkbox")) {
    score += 1;
  }
  if (score > 0 && target === "salary_expectations" && (c.inputType === "number" || c.inputType === "text")) {
    score += 1;
  }
  if (score > 0 && target === "race_ethnicity" && (c.tag === "select" || c.inputType === "radio_group")) {
    score += 1;
  }
  if (score > 0 && (target === "veteran_status" || target === "disability_status" || target === "gender" || target === "hispanic_ethnicity") && (c.tag === "select" || c.inputType === "radio_group")) {
    score += 1;
  }

  return { score, matchedBy };
}

async function extractFieldCandidates(page: Page): Promise<CandidateField[]> {
  return page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll("input, textarea, select"));
    const mapped = controls.map((el, idx) => {
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
      const escapedId = id.replace(/"/g, '\\"');
      const labelFromFor = id ? (document.querySelector('label[for="' + escapedId + '"]')?.textContent ?? "") : "";
      const wrappingLabel = el.closest("label")?.textContent ?? "";
      const contextText = el.closest("fieldset, .field, .form-field, .question, [data-automation-id]")?.textContent ?? "";

      if (!id && !name) el.setAttribute("data-jobbot-idx", String(idx));
      // CSS IDs starting with a digit (e.g. UUIDs from Ashby) are invalid in CSS selectors.
      // Use attribute selector form [id="..."] for any such ID to avoid SyntaxError.
      const safeIdSelector = id
        ? (/^\d/.test(id) ? `${tag}[id="${id.replace(/"/g, '\\"')}"]` : `${tag}#${id}`)
        : null;
      const selector = safeIdSelector ?? (name ? `${tag}[name="${name}"]` : `${tag}[data-jobbot-idx="${idx}"]`);

      const computedLabelText = `${labelFromFor} ${wrappingLabel}`.trim();
      // Detect required: native required attr, aria-required="true", or label contains asterisk
      const isRequired =
        (el as HTMLInputElement).required ||
        el.getAttribute("aria-required") === "true" ||
        computedLabelText.includes("*") ||
        (contextText.match(/\*\s*(required)?/i) !== null &&
          !contextText.match(/\*\s*(optional)/i));

      return {
        selector,
        tag,
        inputType,
        name,
        id,
        placeholder,
        ariaLabel,
        labelText: computedLabelText,
        accept,
        contextText: contextText.slice(0, 280),
        dataAutomationId,
        title,
        required: isRequired,
      };
    });

    // Deduplicate radio groups — keep only the first radio of each name group,
    // collecting all sibling option labels into contextText.
    const seenRadioNames = new Set<string>();
    const result: typeof mapped = [];
    for (const field of mapped) {
      if (field.inputType === "radio") {
        if (!field.name || seenRadioNames.has(field.name)) continue;
        seenRadioNames.add(field.name);
        // Collect all option labels for this group
        const escapedName = field.name.replace(/"/g, '\\"');
        const groupOptions = Array.from(
          document.querySelectorAll('input[type="radio"][name="' + escapedName + '"]')
        ).map((r) => {
          const rid = (r as HTMLInputElement).id;
          const escapedRid = rid.replace(/"/g, '\\"');
          const labelFor = rid ? (document.querySelector('label[for="' + escapedRid + '"]')?.textContent ?? "") : "";
          const wrap = r.closest("label")?.textContent ?? "";
          return (labelFor || wrap).trim();
        }).filter(Boolean);
        field.inputType = "radio_group";
        field.contextText = (field.contextText + " Options: " + groupOptions.join(", ")).slice(0, 280);
      }
      result.push(field);
    }
    return result;
  });
}

/**
 * Human-readable labels for enum values stored in the DB.
 * Used when filling free-text inputs (not selects/radios) so the form shows
 * "Prefer not to say" rather than the raw "prefer_not_to_say" enum string.
 */
const HUMAN_READABLE: Partial<Record<string, string>> = {
  // gender
  man:                         "Man",
  male:                        "Male",
  woman:                       "Woman",
  female:                      "Female",
  non_binary:                  "Non-Binary",
  other:                       "Other",
  prefer_not_to_say:           "Prefer not to say",
  // hispanic_ethnicity
  yes:                         "Yes",
  no:                          "No",
  // veteran_status
  not_a_protected_veteran:     "I am not a protected veteran",
  protected_veteran:           "I am a protected veteran",
  decline_to_answer:           "I prefer not to answer",
  // disability_status
  no_disability:               "No, I do not have a disability",
  has_disability:              "Yes, I have a disability",
};

function payloadValueForTarget(payload: ApplicantPayload, target: SupportedFieldKey): string | undefined {
  if (target === "full_name") {
    return [payload.first_name, payload.last_name].filter(Boolean).join(" ") || payload.full_name;
  }
  const raw = payload[target];
  if (!raw) return raw;
  // Return the human-readable label so free-text inputs get readable values;
  // selects/radios use matchesOption which handles both raw and label forms.
  return HUMAN_READABLE[raw] ?? raw;
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
    const tagName = await loc.evaluate((el) => el.tagName.toLowerCase()).catch(() => "input");
    const rawInputType = await loc.evaluate((el) => {
      if (el.tagName.toLowerCase() === "input") return (el as HTMLInputElement).type.toLowerCase();
      return "";
    }).catch(() => "");

    if (rawInputType === "radio") {
      // Radio group — click the option whose label best matches the value
      const radioName = await loc.evaluate((el) => el.getAttribute("name") ?? "").catch(() => "");
      if (radioName) {
        const clicked = await page.evaluate(({ name, val }) => {
          function matchesOption(rawVal: string, rawOptionText: string): boolean {
            const norm = (s: string) =>
              s.toLowerCase().replace(/_/g, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
            const v = norm(rawVal);
            const o = norm(rawOptionText);
            if (!v || !o) return false;
            if (o.includes(v) || v.includes(o)) return true;
            if ((v === "man" || v === "male") && (o === "male" || o === "man" || o.startsWith("male"))) return true;
            if ((v === "woman" || v === "female") && (o.includes("female") || o.includes("woman"))) return true;
            if (v.includes("non binary") && (o.includes("non binary") || o.includes("nonbinary"))) return true;
            const declineTerms = ["decline", "prefer not", "choose not", "do not wish", "don t wish", "not to answer"];
            const vIsDecline = declineTerms.some((t) => v.includes(t));
            const oIsDecline = declineTerms.some((t) => o.includes(t));
            if (vIsDecline && oIsDecline) return true;
            if (v === "yes" && (o === "yes" || o.startsWith("yes "))) return true;
            if (v === "no" && (o === "no" || o.startsWith("no ") || o.startsWith("no,"))) return true;
            if (v.includes("has disability") && (o.includes("yes") || o.includes("i have"))) return true;
            if (v.includes("no disability") && o.includes("no") && (o.includes("don") || o.includes("not have"))) return true;
            if (v.includes("not a protected") && o.includes("not a protected")) return true;
            if (v.includes("protected veteran") && !v.includes("not") && o.includes("protected veteran") && !o.includes("not")) return true;
            return false;
          }
          const escapedName = name.replace(/"/g, '\\"');
          const radios = Array.from(
            document.querySelectorAll('input[type="radio"][name="' + escapedName + '"]'),
          ) as HTMLInputElement[];
          for (const radio of radios) {
            const rid = radio.id;
            const escapedRid = rid.replace(/"/g, '\\"');
            const labelFor = rid ? (document.querySelector('label[for="' + escapedRid + '"]')?.textContent ?? "") : "";
            const wrap = radio.closest("label")?.textContent ?? "";
            const optionText = (labelFor || wrap).trim();
            if (matchesOption(val, optionText)) {
              radio.click();
              radio.dispatchEvent(new Event("change", { bubbles: true }));
              return true;
            }
          }
          return false;
        }, { name: radioName, val: value }).catch(() => false);

        if (!clicked) {
          // Playwright fallback — click first radio of the group
          await page.locator(`input[type="radio"][name="${radioName}"]`).first().click().catch(() => {});
        }
      }
    } else if (tagName === "select") {
      // Try exact value match first, then robust label match
      const filled = await loc.evaluate((el, val) => {
        function matchesOption(rawVal: string, rawOptionText: string): boolean {
          const norm = (s: string) =>
            s.toLowerCase().replace(/_/g, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
          const v = norm(rawVal);
          const o = norm(rawOptionText);
          if (!v || !o) return false;
          if (o.includes(v) || v.includes(o)) return true;
          if ((v === "man" || v === "male") && (o === "male" || o === "man" || o.startsWith("male"))) return true;
          if ((v === "woman" || v === "female") && (o.includes("female") || o.includes("woman"))) return true;
          if (v.includes("non binary") && (o.includes("non binary") || o.includes("nonbinary"))) return true;
          const declineTerms = ["decline", "prefer not", "choose not", "do not wish", "don t wish", "not to answer"];
          const vIsDecline = declineTerms.some((t) => v.includes(t));
          const oIsDecline = declineTerms.some((t) => o.includes(t));
          if (vIsDecline && oIsDecline) return true;
          if (v === "yes" && (o === "yes" || o.startsWith("yes "))) return true;
          if (v === "no" && (o === "no" || o.startsWith("no ") || o.startsWith("no,"))) return true;
          if (v.includes("has disability") && (o.includes("yes") || o.includes("i have"))) return true;
          if (v.includes("no disability") && o.includes("no") && (o.includes("don") || o.includes("not have"))) return true;
          if (v.includes("not a protected") && o.includes("not a protected")) return true;
          if (v.includes("protected veteran") && !v.includes("not") && o.includes("protected veteran") && !o.includes("not")) return true;
          return false;
        }
        const select = el as HTMLSelectElement;
        // 1. Exact value match
        for (const opt of Array.from(select.options)) {
          if (opt.value === val) {
            select.value = opt.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
          }
        }
        // 2. Robust text match
        for (const opt of Array.from(select.options)) {
          if (matchesOption(val, opt.text)) {
            select.value = opt.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
          }
        }
        return false;
      }, value).catch(() => false);

      if (!filled) {
        await loc.selectOption({ label: value }).catch(() => loc.selectOption(value).catch(() => {}));
      }
    } else {
      await loc.fill(value);
    }
  }

  return { matched: true, selector: mapped.selector, previousValue, overwritten };
}

async function fillAshbyCustomDropdowns(page: Page, payload: ApplicantPayload): Promise<void> {
  // Map of field names to search for in labels → payload value
  const eeoFields: Array<{ labelPattern: RegExp; value: string | undefined }> = [
    { labelPattern: /\bgender\b/i, value: payload.gender },
    { labelPattern: /\brace\b|\bethnicity\b/i, value: payload.race_ethnicity },
    { labelPattern: /\bhispanic\b|\blatino\b/i, value: payload.hispanic_ethnicity },
    { labelPattern: /\bveteran\b/i, value: payload.veteran_status },
    { labelPattern: /\bdisabilit/i, value: payload.disability_status },
  ];

  for (const { labelPattern, value } of eeoFields) {
    if (!value) continue;
    try {
      // Find a label matching this field
      const labelEls = await page.locator("label, legend, [class*=\"label\"], [class*=\"Label\"]").all();
      let triggerEl: any = null;

      for (const labelEl of labelEls) {
        const text = await labelEl.textContent().catch(() => "");
        if (!text || !labelPattern.test(text)) continue;

        // Look for a combobox/listbox trigger near this label
        const parent = labelEl.locator("xpath=..");
        const trigger = parent.locator("[role=\"combobox\"], [aria-haspopup], button[aria-expanded]").first();
        if ((await trigger.count()) > 0) {
          triggerEl = trigger;
          break;
        }
        // Try siblings/nearby divs with dropdown characteristics
        const nearbyTrigger = page.locator("[data-testid*=\"select\"], [class*=\"Select\"], [class*=\"dropdown\"]").first();
        if ((await nearbyTrigger.count()) > 0) {
          triggerEl = nearbyTrigger;
          break;
        }
      }

      if (!triggerEl) continue;

      await triggerEl.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(300);

      // Find matching option
      const lower = value.toLowerCase();
      const options = await page.locator("[role=\"option\"], [role=\"listbox\"] li, [role=\"menu\"] [role=\"menuitem\"]").all();
      for (const opt of options) {
        const optText = await opt.textContent().catch(() => "");
        if (!optText) continue;
        const optLower = optText.trim().toLowerCase();
        if (optLower.includes(lower) || lower.includes(optLower)) {
          await opt.click({ timeout: 3000 }).catch(() => {});
          break;
        }
      }

      await page.waitForTimeout(200);
    } catch {
      // Non-fatal: custom dropdown filling is best-effort
    }
  }
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
  console.log("[fill] candidates found:", candidates.length);
  console.log("[fill] mapped fields:", mappingPlan.mapped.map(m => `${m.target}(${m.confidence},score?): ${m.candidateSummary}`));
  console.log("[fill] issues:", mappingPlan.issues.map(i => `${i.target}: ${i.reason}`));
  const mappedByTarget = new Map<SupportedFieldKey, MappedField>(mappingPlan.mapped.map((m) => [m.target, m]));

  for (const target of ORDERED_TARGETS) {
    const value = payloadValueForTarget(payload, target)?.trim();
    if (!value) {
      console.log(`[fill] EMPTY ${target}: no payload value`);
      skippedEmpty.push(target);
      continue;
    }

    const mapped = mappedByTarget.get(target);
    if (!mapped || mapped.confidence !== "high") {
      console.log(`[fill] SKIP ${target}: ${!mapped ? "not_mapped" : "low_confidence"} value="${value}"`);
      notFound.push(target);
      continue;
    }

    const result = await fillWithPlan(page, mapped, value);
    if (!result.matched) {
      console.log(`[fill] NOMATCH ${target}: selector=${mapped.selector}`);
      notFound.push(target);
      continue;
    }
    console.log(`[fill] OK ${target}: "${value}" → ${mapped.selector}`);

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

  if (site === "ashby") {
    await fillAshbyCustomDropdowns(page, payload);
  }

  // Detect required fields that were not filled by the automation.
  // Only considers high-confidence mapped fields — if the form had a required field
  // that was clearly identified but we couldn't fill it (no payload value or selector
  // failed), surface it so the UI can warn the user.
  const candidateBySelector = new Map<string, CandidateField>(
    candidates.map((c) => [c.selector, c])
  );
  const unfilledRequired: Array<{ field: string; label: string; selector: string }> = [];
  for (const mapped of mappingPlan.mapped) {
    if (mapped.target in applied) continue; // successfully filled — skip
    const candidate = candidateBySelector.get(mapped.selector);
    if (candidate?.required) {
      unfilledRequired.push({
        field: mapped.target,
        label: candidate.labelText || candidate.placeholder || mapped.target,
        selector: mapped.selector,
      });
    }
  }
  if (unfilledRequired.length > 0) {
    console.log("[fill] unfilledRequired:", unfilledRequired.map((u) => `${u.field}(${u.selector})`));
  }

  return { applied, skippedEmpty, notFound, filesUploaded, fieldMappings, changeLog, mappingPlan, unfilledRequired };
}
