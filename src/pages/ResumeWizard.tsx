import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { ArrowUp, ArrowDown, Pencil, Trash2, X, Plus } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type FeatureType =
  | "professional_experience"
  | "academics"
  | "extracurriculars"
  | "skills_and_certifications";

interface ResumeFeature {
  id: string;
  user_id: string;
  role_title: string;
  company: string;
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
  from_date: string; // "YYYY-MM" or ""
  to_date: string; // "YYYY-MM" or ""
  is_present: boolean;
  description_lines: string[];
}

const emptyDraft = (): FeatureDraft => ({
  id: null,
  role_title: "",
  company: "",
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
    from_date: toMonth(f.from_date),
    to_date: f.to_date ? toMonth(f.to_date) : "",
    is_present: f.to_date === null,
    description_lines: f.description_lines.length > 0 ? [...f.description_lines] : [""],
  };
}

// ─── Section config ───────────────────────────────────────────────────────────

const SECTIONS: { type: FeatureType; label: string }[] = [
  { type: "professional_experience", label: "Professional Experience" },
  { type: "academics", label: "Academics" },
  { type: "extracurriculars", label: "Extracurriculars" },
  { type: "skills_and_certifications", label: "Skills & Certifications" },
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
  onChange: (d: FeatureDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}

function FeatureForm({ draft, onChange, onSave, onCancel, saving }: FeatureFormProps) {
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

interface SectionCardProps {
  label: string;
  featureType: FeatureType;
  features: ResumeFeature[];
  onSaved: () => void;
  userId: string;
}

function SectionCard({ label, featureType, features, onSaved, userId }: SectionCardProps) {
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
    if (!draft.role_title.trim() && !draft.company.trim()) {
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
    if (!window.confirm(`Delete "${f.role_title || f.company}"? This cannot be undone.`)) return;
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

                {/* Feature content */}
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium text-foreground text-sm">
                      {f.role_title || <span className="italic text-muted-foreground">Untitled</span>}
                    </span>
                    {f.company && (
                      <span className="text-muted-foreground text-sm">{f.company}</span>
                    )}
                  </div>
                  {(f.from_date || f.to_date !== undefined) && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatMonthYear(f.from_date)}
                      {f.from_date || f.to_date !== null ? " – " : ""}
                      {f.to_date === null ? "Present" : formatMonthYear(f.to_date)}
                    </p>
                  )}
                  {f.description_lines.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5">
                      {f.description_lines.map((line, li) => (
                        <li key={li} className="text-sm text-muted-foreground flex gap-1.5">
                          <span className="shrink-0 mt-px">•</span>
                          <span>{line}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

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

  return (
    <AppLayout>
      <div className="space-y-6 max-w-3xl">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Resume Wizard</h1>
          <p className="text-muted-foreground mt-1">
            Build your structured resume content. This data can be used to tailor applications.
          </p>
        </div>

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
              />
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
