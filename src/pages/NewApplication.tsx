import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import {
  extractJobFromUrl,
  enrichExtractedFromDescription,
  mergeExtractedJobFields,
  type ExtractedJobFields,
  type ExtractJobFromUrlResult,
} from "@/lib/jobExtraction";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle } from "lucide-react";
import { toast } from "sonner";

type FormState = {
  job_url: string;
  company_name: string;
  job_title: string;
  job_description: string;
  location: string;
  salary_range: string;
  notes: string;
};

const emptyForm = (): FormState => ({
  job_url: "",
  company_name: "",
  job_title: "",
  job_description: "",
  location: "",
  salary_range: "",
  notes: "",
});

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function mergeFormWithExtracted(into: FormState, extracted: ExtractedJobFields): FormState {
  const j = mergeExtractedJobFields(
    {
      company_name: into.company_name,
      job_title: into.job_title,
      job_description: into.job_description,
      location: into.location,
      salary_range: into.salary_range,
    },
    extracted,
  );
  return { ...into, ...j };
}

function loadListingErrorMessage(result: ExtractJobFromUrlResult): string {
  const detail = result.fallbackDetail?.trim();
  if (detail) return `Could not load this listing automatically. ${detail}`;
  return "Could not load this listing automatically. Paste the job description below or try again.";
}

export default function NewApplication() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [listingLoadError, setListingLoadError] = useState<string | null>(null);

  const set =
    (key: keyof FormState) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  const onJobUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setListingLoadError(null);
    setForm((f) => ({ ...f, job_url: e.target.value }));
  };

  const handleExtract = async () => {
    const url = form.job_url.trim();
    if (!isValidHttpUrl(url)) {
      toast.error("Enter a valid http(s) job URL first");
      return;
    }
    if (!user) return;

    setExtracting(true);
    try {
      const result = await extractJobFromUrl(supabase, url);
      const merged = mergeFormWithExtracted({ ...form, job_url: url }, result.fields);
      setForm(merged);

      if (result.usedFallback) {
        setListingLoadError(loadListingErrorMessage(result));
        return;
      }
      setListingLoadError(null);
      toast.success("Posting loaded into the form. Review the fields, then click Create application to save.");
    } finally {
      setExtracting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    const url = form.job_url.trim();
    if (!isValidHttpUrl(url)) {
      toast.error("Please enter a valid job posting URL");
      return;
    }

    setSaving(true);
    try {
      setListingLoadError(null);
      let row = { ...form, job_url: url };
      if (!row.company_name.trim() || !row.job_title.trim()) {
        const result = await extractJobFromUrl(supabase, url);
        row = mergeFormWithExtracted(row, result.fields);
        setForm((f) => ({ ...f, ...row }));
        if (result.usedFallback) {
          setListingLoadError(loadListingErrorMessage(result));
          return;
        }
        setListingLoadError(null);
      } else {
        const e = enrichExtractedFromDescription({
          company_name: row.company_name,
          job_title: row.job_title,
          job_description: row.job_description,
          location: row.location,
          salary_range: row.salary_range,
        });
        row = { ...row, ...e, job_url: url };
        setForm((f) => ({ ...f, ...row }));
      }

      const { data, error } = await supabase
        .from("applications")
        .insert({
          user_id: user.id,
          submission_status: "draft",
          application_status: "not_started",
          job_url: row.job_url,
          company_name: row.company_name.trim(),
          job_title: row.job_title.trim(),
          job_description: row.job_description.trim() || null,
          location: row.location.trim() || null,
          salary_range: row.salary_range.trim() || null,
          notes: row.notes.trim() || null,
        })
        .select("id")
        .single();

      if (error) {
        toast.error("Failed to create application");
        return;
      }

      await supabase.from("application_events").insert({
        application_id: data.id,
        user_id: user.id,
        event_type: "status_change",
        description: "Application created as draft (submission status)",
      });

      toast.success("Application created");

      // Fire-and-forget: generate a tailored resume in the background
      toast.info("Generating tailored resume in the background…");
      supabase.functions
        .invoke("generate-resume", { body: { application_id: data.id } })
        .catch(() => {/* non-fatal */});

      navigate(`/applications/${data.id}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppLayout>
      <div className="max-w-2xl animate-fade-in">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-foreground">New Application</h1>
          <p className="text-muted-foreground mt-1">
            Import from URL only fills the form from the posting. Nothing is saved until you click Create application.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>From job URL</CardTitle>
            <CardDescription>
              Import loads the listing into the fields below (no database record yet). If loading fails, fix the URL
              or paste details manually, then use Create application to save.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {listingLoadError ? (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{listingLoadError}</AlertDescription>
                </Alert>
              ) : null}
              <div className="space-y-2">
                <Label>Job posting URL *</Label>
                <Input
                  value={form.job_url}
                  onChange={onJobUrlChange}
                  type="url"
                  required
                  placeholder="https://careers.example.com/job/123"
                />
              </div>
              <Button type="button" variant="secondary" className="w-full" disabled={extracting} onClick={handleExtract}>
                {extracting ? "Importing…" : "Import from URL"}
              </Button>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                <div className="space-y-2">
                  <Label>Company name</Label>
                  <Input value={form.company_name} onChange={set("company_name")} placeholder="Filled by extract or type here" />
                </div>
                <div className="space-y-2">
                  <Label>Job title</Label>
                  <Input value={form.job_title} onChange={set("job_title")} placeholder="Filled by extract or type here" />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Location</Label>
                  <Input value={form.location} onChange={set("location")} placeholder="Remote / City" />
                </div>
                <div className="space-y-2">
                  <Label>Salary range</Label>
                  <Input value={form.salary_range} onChange={set("salary_range")} placeholder="$120k – $160k" />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Job description</Label>
                <Textarea
                  value={form.job_description}
                  onChange={set("job_description")}
                  rows={6}
                  placeholder="Populated by extract, or paste the posting…"
                />
              </div>
              <div className="space-y-2">
                <Label>Notes</Label>
                <Textarea value={form.notes} onChange={set("notes")} rows={3} placeholder="Personal notes…" />
              </div>
              <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  className="w-full sm:w-auto"
                  disabled={saving || extracting}
                  onClick={() => navigate("/dashboard")}
                >
                  Cancel
                </Button>
                <Button type="submit" className="w-full sm:min-w-[200px] sm:flex-1" disabled={saving || extracting}>
                  {saving ? "Creating…" : "Create application"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
