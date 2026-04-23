import { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).href;
import { Link } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { ArrowUp, ArrowDown, Pencil, Trash2, X, Plus, Upload, FileText, CheckCircle2, AlertCircle, Download } from "lucide-react";
import { Badge } from "@/components/ui/badge";

// ─── Types ────────────────────────────────────────────────────────────────────

type FeatureType =
  | "professional_experience"
  | "academics"
  | "extracurriculars"
  | "skills_and_certifications"
  | "personal";

interface ResumeFeature {
  id: string;
  user_id: string;
  role_title: string;
  company: string;
  location: string;
  degree: string;
  major: string;
  from_date: string | null;
  to_date: string | null;
  feature_type: string;
  sort_order: number;
  description_lines: string[];
  created_at: string;
  updated_at: string;
}

interface Profile {
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  professional_email: string | null;
  phone: string | null;
  phone_country_code: string | null;
  linkedin_url: string | null;
  city: string | null;
  state_region: string | null;
  country: string | null;
}

// ─── Draft state for add/edit ─────────────────────────────────────────────────

interface FeatureDraft {
  id: string | null; // null = new
  role_title: string;
  company: string;
  location: string;
  degree: string;
  major: string;
  from_date: string; // "YYYY-MM" or ""
  to_date: string; // "YYYY-MM" or ""
  is_present: boolean;
  description_lines: string[];
}

interface ParsedEntry {
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

type ImportState =
  | { status: "idle" }
  | { status: "parsing" }
  | { status: "preview"; entries: ParsedEntry[] }
  | { status: "saving" }
  | { status: "error"; message: string };

const emptyDraft = (): FeatureDraft => ({
  id: null,
  role_title: "",
  company: "",
  location: "",
  degree: "",
  major: "",
  from_date: "",
  to_date: "",
  is_present: false,
  description_lines: [""],
});

function draftFromFeature(f: ResumeFeature): FeatureDraft {
  // Convert "YYYY-MM-DD" → "YYYY-MM" for <input type="month">
  const toMonth = (d: string | null) => (d ? d.slice(0, 7) : "");
  return {
    id: f.id,
    role_title: f.role_title,
    company: f.company,
    location: f.location ?? "",
    degree: f.degree ?? "",
    major: f.major ?? "",
    from_date: toMonth(f.from_date),
    to_date: f.to_date ? toMonth(f.to_date) : "",
    is_present: f.to_date === null,
    description_lines: f.description_lines.length > 0 ? [...f.description_lines] : [""],
  };
}

// ─── Export helpers ───────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Section display labels match the original resume style (lowercase)
const SECTION_DISPLAY_LABELS: Record<FeatureType, string> = {
  academics: "education",
  professional_experience: "experience",
  extracurriculars: "community",
  skills_and_certifications: "technical skills",
  personal: "personal",
};

// Section render order: education first, then experience (matches Luis's format)
const EXPORT_SECTION_ORDER: FeatureType[] = [
  "academics",
  "professional_experience",
  "extracurriculars",
  "skills_and_certifications",
  "personal",
];

function buildResumeHtml(profile: Profile | null, features: ResumeFeature[]): string {
  const name =
    [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") ||
    profile?.full_name || "";

  // Contact: each item on its own centered line
  const contactLines = [
    profile?.professional_email,
    [profile?.phone_country_code, profile?.phone].filter(Boolean).join(" ") || null,
    profile?.linkedin_url,
    [profile?.city, profile?.state_region, profile?.country].filter(Boolean).join(", ") || null,
  ].filter(Boolean) as string[];

  // Year-only dates for the left column (e.g. "2023 - 2025")
  const fmtYear = (d: string | null) => (d ? d.split("-")[0] : "");
  const fmtDateRange = (from: string | null, to: string | null) => {
    const f = fmtYear(from);
    const t = to === null ? "Present" : fmtYear(to);
    if (!f && !t) return "";
    if (!f) return t;
    if (f === t) return f;
    return `${f} - ${t}`;
  };

  // Auto-italicize "Key Term: rest of bullet" pattern (experience style)
  const fmtBullet = (text: string): string => {
    const m = text.match(/^([^:]{1,50}):\s(.+)/s);
    return m
      ? `<em><strong>${escapeHtml(m[1])}</strong></em>: ${escapeHtml(m[2])}`
      : escapeHtml(text);
  };

  let body = "";

  for (const type of EXPORT_SECTION_ORDER) {
    const entries = features.filter((f) => f.feature_type === type);
    if (!entries.length) continue;
    const label = SECTION_DISPLAY_LABELS[type];

    if (type === "academics" || type === "professional_experience") {
      // Two-column layout: section label row, then per-entry date + content rows
      body += `<div class="shead"><div class="lc"><strong>${escapeHtml(label)}</strong></div><div class="rc"></div></div>`;

      for (const f of entries) {
        const dateStr = fmtDateRange(f.from_date, f.to_date);
        const coName = (f.company || "").toUpperCase();
        const loc = (f.location || "").toUpperCase();

        let subtitle = "";
        if (type === "academics") {
          const deg = [f.degree, f.major ? `in ${f.major}` : ""].filter(Boolean).join(" ");
          if (deg) subtitle = `<div class="sub">${escapeHtml(deg)}</div>`;
        } else {
          if (f.role_title) subtitle = `<div class="role">${escapeHtml(f.role_title)}</div>`;
        }

        const bullets = f.description_lines.length
          ? `<ul>${f.description_lines.map((l) => `<li>${fmtBullet(l)}</li>`).join("")}</ul>`
          : "";

        body += `<div class="erow"><div class="lc date">${escapeHtml(dateStr)}</div><div class="rc entry"><div class="corow"><span class="co">${escapeHtml(coName)}</span><span class="loc">${escapeHtml(loc)}</span></div>${subtitle}${bullets}</div></div>`;
      }
    } else if (type === "extracurriculars") {
      // Paragraph format: "Role, Org (dates) - description"
      const paras = entries.map((f) => {
        const dateStr = fmtDateRange(f.from_date, f.to_date);
        const who = [
          f.role_title,
          f.company ? `, ${f.company}` : "",
          dateStr ? ` (${dateStr})` : "",
        ].join("");
        const desc = f.description_lines.join("; ");
        return `<p>${escapeHtml(who)}${desc ? ` - ${escapeHtml(desc)}` : ""}</p>`;
      }).join("");
      body += `<div class="shead"><div class="lc"><strong>${escapeHtml(label)}</strong></div><div class="rc inline">${paras}</div></div>`;
    } else if (type === "skills_and_certifications") {
      // Inline: "Category: skill1, skill2" joined with semi-colons
      const text = entries.map((f) =>
        f.description_lines.length
          ? `${escapeHtml(f.role_title)}: ${f.description_lines.map(escapeHtml).join(", ")}`
          : escapeHtml(f.role_title)
      ).join("; ");
      body += `<div class="shead"><div class="lc"><strong>${escapeHtml(label)}</strong></div><div class="rc inline"><p>${text}</p></div></div>`;
    } else if (type === "personal") {
      const text = entries.map((f) => f.role_title).filter(Boolean).join(", ");
      body += `<div class="shead"><div class="lc"><strong>${escapeHtml(label)}</strong></div><div class="rc inline"><p>${escapeHtml(text)}</p></div></div>`;
    }
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${name ? escapeHtml(name) + " – Resume" : "Resume"}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Times New Roman',Times,serif;font-size:10pt;line-height:1.2;color:#000}
.page{max-width:7.5in;margin:0 auto}
.name{text-align:center;font-size:10pt;font-weight:bold;text-transform:uppercase;letter-spacing:.04em;margin-bottom:1pt}
.cl{text-align:center;font-size:10pt;margin-bottom:0}
/* Two-column rows */
.shead,.erow{display:flex}
.shead{margin-top:7pt}
.erow{margin-top:3pt}
.lc{width:82pt;flex-shrink:0;padding-right:6pt;font-size:10pt}
.rc{flex:1;min-width:0}
.date{font-size:10pt}
.entry{margin-bottom:3pt}
/* Company row */
.corow{display:flex;justify-content:space-between;align-items:baseline}
.co{font-weight:bold;font-size:10pt}
.loc{font-weight:bold;font-size:10pt}
/* Role / degree subtitle */
.role{font-weight:bold;font-size:10pt;margin-top:0}
.sub{font-size:10pt;margin-top:0}
/* Inline sections (community / skills / personal) */
.inline p{font-size:10pt;line-height:1.2;margin-bottom:1pt}
/* Bullets */
ul{margin:1pt 0 0 13pt}
ul li{font-size:10pt;line-height:1.2;margin-bottom:0;list-style-type:disc}
@page{size:letter;margin:.5in}
@media print{.page{max-width:100%}}
</style>
</head>
<body>
<div class="page">
${name ? `<div class="name">${escapeHtml(name)}</div>` : ""}
${contactLines.map((l) => `<div class="cl">${escapeHtml(l)}</div>`).join("")}
${body}
</div>
<script>
window.onload=function(){
  /* Letter page = 11in. At 96px/in = 1056px total. Warn if content overflows. */
  var pages=document.body.scrollHeight/(11*96);
  var go=true;
  if(pages>1.05){
    go=window.confirm(
      '\u26A0\uFE0F Your resume is approximately '+pages.toFixed(1)+' pages long.\n\n'+
      'Close this window, uncheck some items in the Resume Wizard, and export again — or click OK to print anyway.'
    );
  }
  if(go)window.print();
};
</script>
</body>
</html>`;
}

// ─── Section config ───────────────────────────────────────────────────────────

const SECTIONS: { type: FeatureType; label: string }[] = [
  { type: "professional_experience", label: "Professional Experience" },
  { type: "academics", label: "Academics" },
  { type: "extracurriculars", label: "Extracurriculars" },
  { type: "skills_and_certifications", label: "Skills & Certifications" },
  { type: "personal", label: "Personal" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatMonthYear(dateStr: string | null): string {
  if (!dateStr) return "";
  const [year, month] = dateStr.split("-");
  if (!year || !month) return dateStr;
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function locationString(p: Profile): string {
  return [p.city, p.state_region, p.country].filter(Boolean).join(", ");
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function BioCard({ profile }: { profile: Profile | null }) {
  if (!profile) return null;
  const name = [profile.first_name, profile.last_name].filter(Boolean).join(" ") || profile.full_name || "—";
  const phone = [profile.phone_country_code, profile.phone].filter(Boolean).join(" ") || null;
  const loc = locationString(profile);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-xl">{name}</CardTitle>
            <div className="mt-2 space-y-0.5 text-sm text-muted-foreground">
              {profile.professional_email && <p>{profile.professional_email}</p>}
              {phone && <p>{phone}</p>}
              {profile.linkedin_url && (
                <p>
                  <a href={profile.linkedin_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                    {profile.linkedin_url}
                  </a>
                </p>
              )}
              {loc && <p>{loc}</p>}
            </div>
          </div>
          <Link to="/settings" className="shrink-0 text-xs text-primary hover:underline">
            Edit in Settings
          </Link>
        </div>
      </CardHeader>
    </Card>
  );
}

interface FeatureFormProps {
  draft: FeatureDraft;
  featureType: FeatureType;
  onChange: (d: FeatureDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}

function FeatureForm({ draft, featureType, onChange, onSave, onCancel, saving }: FeatureFormProps) {
  const set = (patch: Partial<FeatureDraft>) => onChange({ ...draft, ...patch });

  const updateLine = (i: number, value: string) => {
    const lines = [...draft.description_lines];
    lines[i] = value;
    set({ description_lines: lines });
  };

  const addLine = () => set({ description_lines: [...draft.description_lines, ""] });

  const removeLine = (i: number) => {
    const lines = draft.description_lines.filter((_, idx) => idx !== i);
    set({ description_lines: lines.length > 0 ? lines : [""] });
  };

  // ── personal: single interests field only ────────────────────────────────
  if (featureType === "personal") {
    return (
      <div className="border border-border rounded-lg p-4 mt-3 space-y-4 bg-muted/30">
        <div className="space-y-1.5">
          <Label htmlFor="rw-role-title">Interests</Label>
          <Input
            id="rw-role-title"
            value={draft.role_title}
            onChange={(e) => set({ role_title: e.target.value })}
            placeholder="Skiing, Tennis, Hiking…"
          />
        </div>
        <div className="flex items-center gap-2 pt-1">
          <Button type="button" onClick={onSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  // ── skills_and_certifications: category + bullets only ───────────────────
  if (featureType === "skills_and_certifications") {
    return (
      <div className="border border-border rounded-lg p-4 mt-3 space-y-4 bg-muted/30">
        <div className="space-y-1.5">
          <Label htmlFor="rw-role-title">Category</Label>
          <Input
            id="rw-role-title"
            value={draft.role_title}
            onChange={(e) => set({ role_title: e.target.value })}
            placeholder="Technical Skills"
          />
        </div>

        <div className="space-y-2">
          <Label>Description bullets</Label>
          <div className="space-y-2">
            {draft.description_lines.map((line, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-muted-foreground shrink-0 select-none">•</span>
                <Input
                  value={line}
                  onChange={(e) => updateLine(i, e.target.value)}
                  placeholder="Describe what you did…"
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => removeLine(i)}
                  aria-label="Remove bullet"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
          <Button type="button" variant="outline" size="sm" onClick={addLine}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add bullet
          </Button>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Button type="button" onClick={onSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  // ── academics: degree/major instead of role_title, school, location ──────
  if (featureType === "academics") {
    return (
      <div className="border border-border rounded-lg p-4 mt-3 space-y-4 bg-muted/30">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="rw-degree">Degree</Label>
            <Input
              id="rw-degree"
              value={draft.degree}
              onChange={(e) => set({ degree: e.target.value })}
              placeholder="Master of Business Administration"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rw-major">Major / Field of Study</Label>
            <Input
              id="rw-major"
              value={draft.major}
              onChange={(e) => set({ major: e.target.value })}
              placeholder="Mechanical Engineering, Computer Science"
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="rw-company">School / Institution</Label>
            <Input
              id="rw-company"
              value={draft.company}
              onChange={(e) => set({ company: e.target.value })}
              placeholder="Harvard University"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rw-location">Location</Label>
            <Input
              id="rw-location"
              value={draft.location}
              onChange={(e) => set({ location: e.target.value })}
              placeholder="Boston, MA"
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="rw-from-date">From</Label>
            <input
              id="rw-from-date"
              type="month"
              value={draft.from_date}
              onChange={(e) => set({ from_date: e.target.value })}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rw-to-date">To</Label>
            <div className="space-y-2">
              <input
                id="rw-to-date"
                type="month"
                value={draft.is_present ? "" : draft.to_date}
                onChange={(e) => set({ to_date: e.target.value })}
                disabled={draft.is_present}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <label className="flex items-center gap-2 cursor-pointer text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={draft.is_present}
                  onChange={(e) => set({ is_present: e.target.checked, to_date: e.target.checked ? "" : draft.to_date })}
                  className="h-4 w-4 rounded border-input accent-primary"
                />
                Present
              </label>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <Label>Description bullets</Label>
          <div className="space-y-2">
            {draft.description_lines.map((line, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-muted-foreground shrink-0 select-none">•</span>
                <Input
                  value={line}
                  onChange={(e) => updateLine(i, e.target.value)}
                  placeholder="Describe what you did…"
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => removeLine(i)}
                  aria-label="Remove bullet"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
          <Button type="button" variant="outline" size="sm" onClick={addLine}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add bullet
          </Button>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Button type="button" onClick={onSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  // ── professional_experience / extracurriculars: role, company, location ──
  return (
    <div className="border border-border rounded-lg p-4 mt-3 space-y-4 bg-muted/30">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="rw-role-title">Role / Title</Label>
          <Input
            id="rw-role-title"
            value={draft.role_title}
            onChange={(e) => set({ role_title: e.target.value })}
            placeholder="Product Manager"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rw-company">Company / Organization</Label>
          <Input
            id="rw-company"
            value={draft.company}
            onChange={(e) => set({ company: e.target.value })}
            placeholder="Acme Corp"
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="rw-location">Location</Label>
          <Input
            id="rw-location"
            value={draft.location}
            onChange={(e) => set({ location: e.target.value })}
            placeholder="San Francisco, CA"
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="rw-from-date">From</Label>
          <input
            id="rw-from-date"
            type="month"
            value={draft.from_date}
            onChange={(e) => set({ from_date: e.target.value })}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rw-to-date">To</Label>
          <div className="space-y-2">
            <input
              id="rw-to-date"
              type="month"
              value={draft.is_present ? "" : draft.to_date}
              onChange={(e) => set({ to_date: e.target.value })}
              disabled={draft.is_present}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <label className="flex items-center gap-2 cursor-pointer text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={draft.is_present}
                onChange={(e) => set({ is_present: e.target.checked, to_date: e.target.checked ? "" : draft.to_date })}
                className="h-4 w-4 rounded border-input accent-primary"
              />
              Present
            </label>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <Label>Description bullets</Label>
        <div className="space-y-2">
          {draft.description_lines.map((line, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-muted-foreground shrink-0 select-none">•</span>
              <Input
                value={line}
                onChange={(e) => updateLine(i, e.target.value)}
                placeholder="Describe what you did…"
                className="flex-1"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => removeLine(i)}
                aria-label="Remove bullet"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={addLine}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Add bullet
        </Button>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Button type="button" onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ─── Feature row (read-only display) ─────────────────────────────────────────

interface FeatureRowDisplayProps {
  f: ResumeFeature;
  featureType: FeatureType;
  isHeaderChecked: boolean;
  isBulletChecked: (i: number) => boolean;
  onToggleBullet: (i: number) => void;
}

function FeatureRowDisplay({ f, featureType, isHeaderChecked, isBulletChecked, onToggleBullet }: FeatureRowDisplayProps) {
  // Determine primary label
  let primaryLabel: React.ReactNode;
  if (featureType === "academics") {
    const degreeAndMajor = [f.degree, f.major].filter(Boolean).join(" — ");
    primaryLabel = degreeAndMajor || <span className="italic text-muted-foreground">Untitled</span>;
  } else {
    primaryLabel = f.role_title || <span className="italic text-muted-foreground">Untitled</span>;
  }

  // Secondary label (company / school)
  const showCompany = featureType !== "personal" && featureType !== "skills_and_certifications";
  const companyLabel =
    featureType === "academics"
      ? f.company // school name
      : f.company;

  // Show dates? Not for personal or skills
  const showDates = featureType !== "personal" && featureType !== "skills_and_certifications";

  return (
    <div className="flex-1 min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium text-foreground text-sm">{primaryLabel}</span>
        {showCompany && companyLabel && (
          <span className="text-muted-foreground text-sm">{companyLabel}</span>
        )}
      </div>
      {f.location && (
        <p className="text-xs text-muted-foreground mt-0.5">{f.location}</p>
      )}
      {showDates && (f.from_date || f.to_date !== undefined) && (
        <p className="text-xs text-muted-foreground mt-0.5">
          {formatMonthYear(f.from_date)}
          {f.from_date || f.to_date !== null ? " – " : ""}
          {f.to_date === null ? "Present" : formatMonthYear(f.to_date)}
        </p>
      )}
      {f.description_lines.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 list-none">
          {f.description_lines.map((line, li) => (
            <li key={li} className="text-sm text-muted-foreground flex gap-1.5 items-start">
              <input
                type="checkbox"
                checked={isHeaderChecked && isBulletChecked(li)}
                disabled={!isHeaderChecked}
                onChange={() => onToggleBullet(li)}
                className="mt-0.5 h-3 w-3 shrink-0 cursor-pointer accent-primary disabled:cursor-default disabled:opacity-40"
                onClick={(e) => e.stopPropagation()}
              />
              <span className="shrink-0 mt-px">•</span>
              <span className={!isHeaderChecked || !isBulletChecked(li) ? "opacity-40 line-through" : ""}>{line}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface SectionCardProps {
  label: string;
  featureType: FeatureType;
  features: ResumeFeature[];
  onSaved: () => void;
  userId: string;
  isHeaderChecked: (id: string) => boolean;
  isBulletChecked: (id: string, i: number) => boolean;
  onToggleHeader: (f: ResumeFeature) => void;
  onToggleBullet: (id: string, i: number) => void;
}

function SectionCard({ label, featureType, features, onSaved, userId, isHeaderChecked, isBulletChecked, onToggleHeader, onToggleBullet }: SectionCardProps) {
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<FeatureDraft>(emptyDraft());
  const [saving, setSaving] = useState(false);
  const [movingId, setMovingId] = useState<string | null>(null);

  const startNew = () => {
    setDraft(emptyDraft());
    setEditingId("new");
  };

  const startEdit = (f: ResumeFeature) => {
    setDraft(draftFromFeature(f));
    setEditingId(f.id);
  };

  const cancel = () => {
    setEditingId(null);
    setDraft(emptyDraft());
  };

  const save = async () => {
    // Validation: personal only needs role_title; academics needs degree or company; others need role or company
    if (featureType === "personal" && !draft.role_title.trim()) {
      toast.error("Enter at least one interest.");
      return;
    }
    if (featureType === "academics" && !draft.degree.trim() && !draft.company.trim()) {
      toast.error("Enter at least a degree or school name.");
      return;
    }
    if (
      featureType !== "personal" &&
      featureType !== "academics" &&
      !draft.role_title.trim() &&
      !draft.company.trim()
    ) {
      toast.error("Enter at least a role title or company name.");
      return;
    }

    setSaving(true);

    // "YYYY-MM" → "YYYY-MM-01" for the DB date column
    const toDateStr = (m: string) => (m ? `${m}-01` : null);
    const cleanLines = draft.description_lines.map((l) => l.trim()).filter(Boolean);
    const nextSortOrder =
      features.length > 0 ? Math.max(...features.map((f) => f.sort_order)) + 1 : 0;

    const payload = {
      user_id: userId,
      role_title: draft.role_title.trim(),
      company: draft.company.trim(),
      location: draft.location.trim(),
      degree: draft.degree.trim(),
      major: draft.major.trim(),
      from_date: toDateStr(draft.from_date),
      to_date: draft.is_present ? null : toDateStr(draft.to_date),
      feature_type: featureType,
      description_lines: cleanLines,
    };

    let error: { message: string } | null = null;

    if (draft.id) {
      // Update existing
      const res = await supabase
        .from("resume_features")
        .update(payload)
        .eq("id", draft.id);
      error = res.error;
    } else {
      // Insert new
      const res = await supabase
        .from("resume_features")
        .insert({ ...payload, sort_order: nextSortOrder });
      error = res.error;
    }

    setSaving(false);

    if (error) {
      console.error(error);
      toast.error(error.message || "Could not save entry.");
      return;
    }

    toast.success(draft.id ? "Entry updated." : "Entry added.");
    cancel();
    onSaved();
  };

  const deleteFeature = async (f: ResumeFeature) => {
    const label =
      featureType === "academics"
        ? f.degree || f.company || "this entry"
        : f.role_title || f.company || "this entry";
    if (!window.confirm(`Delete "${label}"? This cannot be undone.`)) return;
    const { error } = await supabase.from("resume_features").delete().eq("id", f.id);
    if (error) {
      toast.error(error.message || "Could not delete entry.");
      return;
    }
    toast.success("Entry deleted.");
    onSaved();
  };

  const move = async (f: ResumeFeature, direction: "up" | "down") => {
    const idx = features.findIndex((x) => x.id === f.id);
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= features.length) return;
    const neighbor = features[swapIdx];
    setMovingId(f.id);

    const aOrder = f.sort_order;
    const bOrder = neighbor.sort_order;

    // If sort_orders are equal or in wrong direction, just swap them explicitly
    const newAOrder = bOrder;
    const newBOrder = aOrder !== bOrder ? aOrder : aOrder + (direction === "up" ? 1 : -1);

    const [resA, resB] = await Promise.all([
      supabase.from("resume_features").update({ sort_order: newAOrder }).eq("id", f.id),
      supabase.from("resume_features").update({ sort_order: newBOrder }).eq("id", neighbor.id),
    ]);

    setMovingId(null);

    if (resA.error || resB.error) {
      toast.error("Could not reorder entries.");
      return;
    }
    onSaved();
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{label}</CardTitle>
          <Button type="button" variant="outline" size="sm" onClick={startNew} disabled={editingId === "new"}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add Entry
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-0">
        {features.length === 0 && editingId !== "new" && (
          <p className="text-sm text-muted-foreground py-2">No entries yet. Click "Add Entry" to get started.</p>
        )}

        {features.map((f, idx) => (
          <div key={f.id}>
            {/* Feature row */}
            <div className="py-3 border-t border-border first:border-t-0">
              <div className="flex items-start gap-3">
                {/* Export checkbox */}
                <input
                  type="checkbox"
                  checked={isHeaderChecked(f.id)}
                  onChange={() => onToggleHeader(f)}
                  className="mt-1.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-primary"
                  onClick={(e) => e.stopPropagation()}
                />
                {/* Reorder arrows */}
                <div className="flex flex-col gap-0.5 shrink-0 mt-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground hover:text-foreground"
                    disabled={idx === 0 || movingId === f.id}
                    onClick={() => move(f, "up")}
                    aria-label="Move up"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground hover:text-foreground"
                    disabled={idx === features.length - 1 || movingId === f.id}
                    onClick={() => move(f, "down")}
                    aria-label="Move down"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </Button>
                </div>

                {/* Feature content (read-only) */}
                <FeatureRowDisplay
                  f={f}
                  featureType={featureType}
                  isHeaderChecked={isHeaderChecked(f.id)}
                  isBulletChecked={(i) => isBulletChecked(f.id, i)}
                  onToggleBullet={(i) => onToggleBullet(f.id, i)}
                />

                {/* Action buttons */}
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-foreground"
                    onClick={() => (editingId === f.id ? cancel() : startEdit(f))}
                    aria-label="Edit entry"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    onClick={() => deleteFeature(f)}
                    aria-label="Delete entry"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              {/* Inline edit form for existing feature */}
              {editingId === f.id && (
                <FeatureForm
                  draft={draft}
                  featureType={featureType}
                  onChange={setDraft}
                  onSave={save}
                  onCancel={cancel}
                  saving={saving}
                />
              )}
            </div>
          </div>
        ))}

        {/* Inline form for new entry */}
        {editingId === "new" && (
          <div className={features.length > 0 ? "border-t border-border" : ""}>
            <FeatureForm
              draft={draft}
              featureType={featureType}
              onChange={setDraft}
              onSave={save}
              onCancel={cancel}
              saving={saving}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ResumeWizard() {
  const { user } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [features, setFeatures] = useState<ResumeFeature[]>([]);
  const [featuresLoading, setFeaturesLoading] = useState(true);

  const loadProfile = useCallback(async () => {
    if (!user) return;
    setProfileLoading(true);
    const { data, error } = await supabase
      .from("profiles")
      .select(
        "full_name, first_name, last_name, professional_email, phone, phone_country_code, linkedin_url, city, state_region, country",
      )
      .eq("user_id", user.id)
      .single();

    if (error) {
      console.error(error);
      toast.error("Could not load profile.");
    } else {
      setProfile(data as Profile);
    }
    setProfileLoading(false);
  }, [user]);

  const loadFeatures = useCallback(async () => {
    if (!user) return;
    setFeaturesLoading(true);
    const { data, error } = await supabase
      .from("resume_features")
      .select("*")
      .eq("user_id", user.id)
      .order("sort_order", { ascending: true });

    if (error) {
      console.error(error);
      toast.error("Could not load resume features.");
    } else {
      setFeatures((data as ResumeFeature[]) ?? []);
    }
    setFeaturesLoading(false);
  }, [user]);

  useEffect(() => {
    loadProfile();
    loadFeatures();
  }, [loadProfile, loadFeatures]);

  const featuresForType = (type: FeatureType) =>
    features.filter((f) => f.feature_type === type);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importState, setImportState] = useState<ImportState>({ status: "idle" });

  // ── Export selection (empty set = everything checked by default) ─────────────
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const isHeaderChecked = (id: string) => !unchecked.has(`h:${id}`);
  const isBulletChecked = (id: string, i: number) => !unchecked.has(`b:${id}:${i}`);

  const onToggleHeader = (f: ResumeFeature) => {
    setUnchecked((prev) => {
      const next = new Set(prev);
      const hKey = `h:${f.id}`;
      if (next.has(hKey)) {
        next.delete(hKey);
        f.description_lines.forEach((_, i) => next.delete(`b:${f.id}:${i}`));
      } else {
        next.add(hKey);
        f.description_lines.forEach((_, i) => next.add(`b:${f.id}:${i}`));
      }
      return next;
    });
  };

  const onToggleBullet = (featureId: string, i: number) => {
    setUnchecked((prev) => {
      const next = new Set(prev);
      const key = `b:${featureId}:${i}`;
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const exportResume = () => {
    const selected = features
      .filter((f) => isHeaderChecked(f.id))
      .map((f) => ({
        ...f,
        description_lines: f.description_lines.filter((_, i) => isBulletChecked(f.id, i)),
      }));
    if (selected.length === 0) {
      toast.error("No items selected. Check at least one entry to export.");
      return;
    }
    const html = buildResumeHtml(profile, selected);
    const win = window.open("", "_blank");
    if (win) {
      win.document.write(html);
      win.document.close();
    }
  };

  const handleImportClick = () => fileInputRef.current?.click();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset input so same file can be re-selected
    if (e.target) e.target.value = "";
    if (!file) return;
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      toast.error("Please select a PDF file.");
      return;
    }

    setImportState({ status: "parsing" });

    try {
      // Extract text client-side — avoids sending binary to the Edge Function
      // and lets Gemini work with clean text (same path as cover letter generation).
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const pageTexts: string[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => ("str" in item ? (item as { str: string }).str : ""))
          .join(" ")
          .trim();
        if (text) pageTexts.push(text);
      }
      const pdfText = pageTexts.join("\n\n");

      if (!pdfText.trim()) {
        throw new Error(
          "No text could be extracted from this PDF. It may be a scanned image — try copying your resume to a Word doc and saving as PDF."
        );
      }

      const { data, error } = await supabase.functions.invoke("parse-resume", {
        body: { pdf_text: pdfText },
      });

      if (error) {
        console.error("[parse-resume] invoke error:", error);
        throw new Error(error.message ?? "Edge Function returned an error");
      }
      if (!data?.ok) throw new Error(data?.error || "Parse failed");

      setImportState({ status: "preview", entries: data.entries as ParsedEntry[] });
    } catch (err) {
      setImportState({
        status: "error",
        message: err instanceof Error ? err.message : "An unexpected error occurred.",
      });
    }
  };

  const handleConfirmImport = async () => {
    if (importState.status !== "preview") return;
    const entries = importState.entries;
    if (entries.length === 0) {
      setImportState({ status: "idle" });
      return;
    }

    setImportState({ status: "saving" });

    // Compute starting sort_order for each type (append after existing)
    const maxSortByType: Record<string, number> = {};
    for (const f of features) {
      const cur = maxSortByType[f.feature_type] ?? -1;
      if (f.sort_order > cur) maxSortByType[f.feature_type] = f.sort_order;
    }

    const rows = entries.map((entry) => {
      const base = maxSortByType[entry.feature_type] ?? -1;
      const newOrder = base + 1 + entry.sort_order;
      return {
        user_id: user!.id,
        feature_type: entry.feature_type,
        role_title: entry.role_title,
        company: entry.company,
        location: entry.location,
        degree: entry.degree,
        major: entry.major,
        from_date: entry.from_date,
        to_date: entry.to_date,
        description_lines: entry.description_lines,
        sort_order: newOrder,
      };
    });

    const { error } = await supabase.from("resume_features").insert(rows);

    if (error) {
      toast.error(error.message || "Could not save imported entries.");
      setImportState({ status: "preview", entries });
      return;
    }

    toast.success(`${entries.length} entries imported successfully.`);
    setImportState({ status: "idle" });
    loadFeatures();
  };

  const handleCancelImport = () => setImportState({ status: "idle" });

  return (
    <AppLayout>
      <div className="space-y-6 max-w-3xl">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Resume Wizard</h1>
            <p className="text-muted-foreground mt-1">
              Build your structured resume content. Check items to include in your exported resume.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={exportResume}
            disabled={featuresLoading || features.length === 0}
            className="shrink-0"
          >
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Export PDF
          </Button>
        </div>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={handleFileChange}
        />

        {/* Import banner / status */}
        {importState.status === "idle" && (
          <div className="flex items-center justify-between rounded-lg border border-dashed border-border px-4 py-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <FileText className="h-4 w-4" />
              <span>Have an existing resume? Import it automatically.</span>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={handleImportClick}>
              <Upload className="h-3.5 w-3.5 mr-1.5" />
              Import from PDF
            </Button>
          </div>
        )}

        {importState.status === "parsing" && (
          <div className="flex items-center gap-3 rounded-lg border border-border px-4 py-3 bg-muted/40">
            <div className="h-4 w-4 rounded-full border-2 border-primary border-t-transparent animate-spin shrink-0" />
            <p className="text-sm text-muted-foreground">Reading your resume with AI… this may take 15–30 seconds.</p>
          </div>
        )}

        {importState.status === "error" && (
          <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-destructive">Import failed</p>
              <p className="text-sm text-muted-foreground mt-0.5">{importState.message}</p>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={handleCancelImport}>Dismiss</Button>
            <Button type="button" variant="outline" size="sm" onClick={handleImportClick}>Try again</Button>
          </div>
        )}

        {(importState.status === "preview" || importState.status === "saving") && (
          <div className="rounded-lg border border-border bg-muted/20">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                <span className="text-sm font-medium">
                  {importState.status === "preview"
                    ? `${importState.entries.length} entries ready to import`
                    : "Saving…"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleCancelImport}
                  disabled={importState.status === "saving"}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleConfirmImport}
                  disabled={importState.status === "saving"}
                >
                  {importState.status === "saving" ? "Importing…" : "Confirm Import"}
                </Button>
              </div>
            </div>
            {importState.status === "preview" && (
              <div className="divide-y divide-border">
                {SECTIONS.map((section) => {
                  const sectionEntries = importState.entries.filter((e) => e.feature_type === section.type);
                  if (sectionEntries.length === 0) return null;
                  return (
                    <div key={section.type} className="px-4 py-3">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{section.label}</span>
                        <Badge variant="secondary" className="text-xs">{sectionEntries.length}</Badge>
                      </div>
                      <div className="space-y-2">
                        {sectionEntries.map((entry, i) => {
                          const primary =
                            section.type === "academics"
                              ? [entry.degree, entry.major].filter(Boolean).join(" — ") || entry.company
                              : entry.role_title;
                          const secondary =
                            section.type === "academics" ? entry.company : entry.company;
                          return (
                            <div key={i} className="text-sm">
                              <span className="font-medium">{primary}</span>
                              {secondary && <span className="text-muted-foreground"> · {secondary}</span>}
                              {entry.location && <span className="text-muted-foreground"> · {entry.location}</span>}
                              {entry.description_lines.length > 0 && (
                                <ul className="mt-1 space-y-0.5 ml-3">
                                  {entry.description_lines.slice(0, 3).map((line, li) => (
                                    <li key={li} className="text-muted-foreground text-xs flex gap-1">
                                      <span>•</span><span>{line}</span>
                                    </li>
                                  ))}
                                  {entry.description_lines.length > 3 && (
                                    <li className="text-muted-foreground text-xs italic">
                                      +{entry.description_lines.length - 3} more bullets…
                                    </li>
                                  )}
                                </ul>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {profileLoading ? (
          <p className="text-sm text-muted-foreground">Loading profile…</p>
        ) : (
          <BioCard profile={profile} />
        )}

        {featuresLoading ? (
          <p className="text-sm text-muted-foreground">Loading resume entries…</p>
        ) : (
          <div className="space-y-6">
            {SECTIONS.map((section) => (
              <SectionCard
                key={section.type}
                label={section.label}
                featureType={section.type}
                features={featuresForType(section.type)}
                onSaved={loadFeatures}
                userId={user?.id ?? ""}
                isHeaderChecked={isHeaderChecked}
                isBulletChecked={isBulletChecked}
                onToggleHeader={onToggleHeader}
                onToggleBullet={onToggleBullet}
              />
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
