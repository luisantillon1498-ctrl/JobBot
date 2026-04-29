import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import {
  extractJobFromUrl,
  mergeExtractedJobFields,
  parseJobUrlsFromText,
  shouldAutoGenerateCoverLetter,
  type ExtractedJobFields,
} from "@/lib/jobExtraction";
import { invokeGenerateCoverLetter } from "@/lib/coverLetterGenerate";
import { getOrGenerateApplicationResumePath } from "@/lib/resumeForGeneration";
import { killRunnerSession } from "@/lib/runnerSession";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { PlusCircle, Briefcase, Clock, CheckCircle2, XCircle, Trash2, Loader2, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

const stageColors: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  applied: "bg-muted text-muted-foreground",
  not_started: "bg-muted text-muted-foreground",
  screening: "bg-warning/10 text-warning",
  first_round_interview: "bg-warning/10 text-warning",
  second_round_interview: "bg-warning/10 text-warning",
  final_round_interview: "bg-accent/10 text-accent-foreground",
};
const submissionStatusColors: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  submitted: "bg-primary/10 text-primary",
};

const outcomeColors: Record<string, string> = {
  rejected: "bg-destructive/10 text-destructive",
  withdrew: "bg-muted text-muted-foreground",
  offer_accepted: "bg-success/10 text-success",
  ghosted: "bg-muted text-muted-foreground/70",
};

const stageLabels: Record<string, string> = {
  draft: "Not Started",
  applied: "Not Started",
  not_started: "Not Started",
  screening: "Screening",
  first_round_interview: "1st Round",
  second_round_interview: "2nd Round",
  final_round_interview: "Final Round",
};
const submissionStatusLabels: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted",
};

const outcomeLabels: Record<string, string> = {
  rejected: "Rejected",
  withdrew: "Withdrew",
  offer_accepted: "Offer Accepted",
  ghosted: "Ghosted",
};

/** Grey: AI cover exists; gold: vault doc marked for submission came from that generation. */
type CoverSparkle = "grey" | "gold";

interface Application {
  id: string;
  company_name: string;
  job_title: string;
  application_status: string;
  submission_status: string;
  outcome: string | null;
  updated_at: string;
  applied_at: string | null;
  location: string | null;
  submitted_cover_document_id: string | null;
  automation_queue_state: string | null;
}

const ACTIVE_AUTOMATION_STATES = new Set(["autofilling", "waiting_for_human_action", "human_action_completed"]);

type ApplicationSortKey =
  | "job_title"
  | "company_name"
  | "location"
  | "submission_status"
  | "application_status"
  | "outcome"
  | "updated_at";

function compareApplications(
  a: Application,
  b: Application,
  key: ApplicationSortKey,
  dir: "asc" | "desc",
): number {
  const mul = dir === "asc" ? 1 : -1;
  if (key === "updated_at") {
    const ta = new Date(a.updated_at).getTime();
    const tb = new Date(b.updated_at).getTime();
    return (ta - tb) * mul;
  }
  if (key === "application_status") {
    const va = (stageLabels[a.application_status] || a.application_status).toLowerCase();
    const vb = (stageLabels[b.application_status] || b.application_status).toLowerCase();
    return va.localeCompare(vb, undefined, { sensitivity: "base" }) * mul;
  }
  if (key === "submission_status") {
    const va = (submissionStatusLabels[a.submission_status] || a.submission_status).toLowerCase();
    const vb = (submissionStatusLabels[b.submission_status] || b.submission_status).toLowerCase();
    return va.localeCompare(vb, undefined, { sensitivity: "base" }) * mul;
  }
  if (key === "outcome") {
    const va = (a.outcome ? outcomeLabels[a.outcome] || a.outcome : "").toLowerCase();
    const vb = (b.outcome ? outcomeLabels[b.outcome] || b.outcome : "").toLowerCase();
    return va.localeCompare(vb, undefined, { sensitivity: "base" }) * mul;
  }
  const va = key === "location" ? (a.location ?? "").toLowerCase() : String(a[key] ?? "").toLowerCase();
  const vb = key === "location" ? (b.location ?? "").toLowerCase() : String(b[key] ?? "").toLowerCase();
  return va.localeCompare(vb, undefined, { sensitivity: "base" }) * mul;
}

type ApplicationColumnFilters = {
  job_title: string;
  company_name: string;
  location: string;
  submission_status: string;
  application_status: string;
  outcome: string;
  updated_at: string;
};

const EMPTY_COLUMN_FILTERS: ApplicationColumnFilters = {
  job_title: "",
  company_name: "",
  location: "",
  submission_status: "",
  application_status: "",
  outcome: "",
  updated_at: "",
};

function applicationMatchesColumnFilters(app: Application, f: ApplicationColumnFilters): boolean {
  const inc = (hay: string, needle: string) => {
    const n = needle.trim().toLowerCase();
    if (!n) return true;
    return hay.toLowerCase().includes(n);
  };

  if (!inc(app.job_title, f.job_title)) return false;
  if (!inc(app.company_name, f.company_name)) return false;
  if (!inc(app.location ?? "", f.location)) return false;

  if (f.submission_status.trim()) {
    const q = f.submission_status.trim().toLowerCase();
    const label = (submissionStatusLabels[app.submission_status] || app.submission_status).toLowerCase();
    if (!label.includes(q) && !app.submission_status.toLowerCase().includes(q)) return false;
  }

  if (f.application_status.trim()) {
    const q = f.application_status.trim().toLowerCase();
    const label = (stageLabels[app.application_status] || app.application_status).toLowerCase();
    if (!label.includes(q) && !app.application_status.toLowerCase().includes(q)) return false;
  }

  if (f.outcome.trim()) {
    const q = f.outcome.trim().toLowerCase();
    const label = app.outcome ? (outcomeLabels[app.outcome] || app.outcome).toLowerCase() : "";
    const raw = (app.outcome ?? "").toLowerCase();
    if (!label.includes(q) && !raw.includes(q)) return false;
  }

  if (f.updated_at.trim()) {
    const q = f.updated_at.trim().toLowerCase();
    const formatted = format(new Date(app.updated_at), "MMM d, yyyy").toLowerCase();
    if (!formatted.includes(q) && !app.updated_at.toLowerCase().includes(q)) return false;
  }

  return true;
}

function columnFiltersActive(f: ApplicationColumnFilters): boolean {
  return Object.values(f).some((v) => v.trim());
}

function FilterableSortableColumnHead({
  label,
  columnKey,
  activeKey,
  dir,
  onSort,
  filterValue,
  onFilterChange,
  filterPlaceholder = "Filter…",
  filterAriaLabel,
  className,
}: {
  label: string;
  columnKey: ApplicationSortKey;
  activeKey: ApplicationSortKey;
  dir: "asc" | "desc";
  onSort: (k: ApplicationSortKey) => void;
  filterValue: string;
  onFilterChange: (value: string) => void;
  filterPlaceholder?: string;
  filterAriaLabel: string;
  className?: string;
}) {
  const active = activeKey === columnKey;
  return (
    <TableHead className={cn("align-top min-w-0", className)}>
      <div className="flex flex-col gap-1.5 py-2 pr-1">
        <button
          type="button"
          onClick={() => onSort(columnKey)}
          className="inline-flex w-full min-w-0 items-center gap-1 font-medium text-muted-foreground hover:text-foreground transition-colors -mx-1 px-1 py-0.5 rounded-md hover:bg-muted/80 text-left"
        >
          <span className="truncate">{label}</span>
          {active ? (
            dir === "asc" ? (
              <ArrowUp className="h-3.5 w-3.5 shrink-0" aria-hidden />
            ) : (
              <ArrowDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
            )
          ) : (
            <ArrowUpDown className="h-3.5 w-3.5 shrink-0 opacity-35" aria-hidden />
          )}
        </button>
        <Input
          value={filterValue}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder={filterPlaceholder}
          aria-label={filterAriaLabel}
          className="h-8 text-xs px-2"
        />
      </div>
    </TableHead>
  );
}

const emptyJobFields = (): ExtractedJobFields => ({
  company_name: "",
  job_title: "",
  job_description: "",
  location: "",
  salary_range: "",
});

async function loadApplicationsAndSparkle(userId: string): Promise<{
  list: Application[];
  sparkle: Record<string, CoverSparkle>;
}> {
  const { data: apps, error: appsError } = await supabase
    .from("applications")
    .select(
      "id, company_name, job_title, submission_status, application_status, outcome, updated_at, applied_at, location, submitted_cover_document_id, automation_queue_state",
    )
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });

  if (appsError) console.error(appsError);
  const list = (apps as Application[]) || [];
  const sparkle: Record<string, CoverSparkle> = {};
  const appIds = list.map((a) => a.id);

  if (appIds.length > 0) {
    const { data: artifacts } = await supabase
      .from("generated_artifacts")
      .select("id, application_id")
      .eq("user_id", userId)
      .eq("type", "cover_letter")
      .in("application_id", appIds);

    const artifactIdsByApp = new Map<string, Set<string>>();
    for (const row of artifacts ?? []) {
      const aid = row.application_id as string;
      if (!artifactIdsByApp.has(aid)) artifactIdsByApp.set(aid, new Set());
      artifactIdsByApp.get(aid)!.add(row.id as string);
    }

    const submittedIds = [
      ...new Set(list.map((a) => a.submitted_cover_document_id).filter((x): x is string => Boolean(x))),
    ];

    const docById: Record<string, { source_generated_artifact_id: string | null }> = {};
    if (submittedIds.length > 0) {
      const { data: docs } = await supabase
        .from("documents")
        .select("id, source_generated_artifact_id")
        .eq("user_id", userId)
        .in("id", submittedIds);
      for (const d of docs ?? []) {
        docById[d.id] = { source_generated_artifact_id: d.source_generated_artifact_id };
      }
    }

    for (const app of list) {
      const artifactIds = artifactIdsByApp.get(app.id);
      if (!artifactIds?.size) continue;
      const subId = app.submitted_cover_document_id;
      const src = subId ? docById[subId]?.source_generated_artifact_id : null;
      const gold = Boolean(src && artifactIds.has(src));
      sparkle[app.id] = gold ? "gold" : "grey";
    }
  }

  return { list, sparkle };
}

export default function Dashboard() {
  const { user } = useAuth();
  const [applications, setApplications] = useState<Application[]>([]);
  const [coverSparkleByAppId, setCoverSparkleByAppId] = useState<Record<string, CoverSparkle>>({});
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<Application | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [batchUrlText, setBatchUrlText] = useState("");
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchQueueMeta, setBatchQueueMeta] = useState<{ total: number; remaining: number } | null>(null);
  const [columnFilters, setColumnFilters] = useState<ApplicationColumnFilters>(() => ({ ...EMPTY_COLUMN_FILTERS }));
  const [sortKey, setSortKey] = useState<ApplicationSortKey>("updated_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const setColumnFilter = (key: keyof ApplicationColumnFilters, value: string) => {
    setColumnFilters((prev) => ({ ...prev, [key]: value }));
  };

  const clearAllTableFilters = () => {
    setColumnFilters({ ...EMPTY_COLUMN_FILTERS });
  };

  const handleApplicationSort = (key: ApplicationSortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "updated_at" ? "desc" : "asc");
    }
  };

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoading(true);
    loadApplicationsAndSparkle(user.id).then(({ list, sparkle }) => {
      if (cancelled) return;
      setApplications(list);
      setCoverSparkleByAppId(sparkle);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const runBatchImport = async () => {
    if (!user) return;
    const urls = parseJobUrlsFromText(batchUrlText);
    if (!urls.length) {
      toast.error("Add one valid http(s) job URL per line.");
      return;
    }
    setBatchRunning(true);
    let created = 0;
    let failed = 0;
    let coversOk = 0;
    let coversSkipped = 0;
    let coverGenFailed = 0;
    try {
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        setBatchQueueMeta({ total: urls.length, remaining: urls.length - i });
        try {
          const scrape = await extractJobFromUrl(supabase, url);
          const fields = mergeExtractedJobFields(emptyJobFields(), scrape.fields);
          const { data, error } = await supabase
            .from("applications")
            .insert({
              user_id: user.id,
              submission_status: "draft",
              application_status: "not_started",
              job_url: url,
              company_name: fields.company_name.trim(),
              job_title: fields.job_title.trim(),
              job_description: fields.job_description.trim() || null,
              location: fields.location.trim() || null,
              salary_range: fields.salary_range.trim() || null,
              notes: null,
            })
            .select("id")
            .single();
          if (error || !data) {
            failed++;
            toast.error(error?.message ?? "Could not save an application for one URL in the batch.");
            setBatchQueueMeta({ total: urls.length, remaining: urls.length - i - 1 });
            continue;
          }
          created++;
          await supabase.from("application_events").insert({
            application_id: data.id,
            user_id: user.id,
            event_type: "status_change",
            description: scrape.usedFallback
              ? "Application created from batch import as draft (listing data was limited)"
              : "Application created from batch import as draft",
          });
          if (shouldAutoGenerateCoverLetter(scrape, fields)) {
            try {
              // Generate (or reuse) the tailored resume for this application first,
              // then use its path when generating the cover letter.
              const resumePath = await getOrGenerateApplicationResumePath(supabase, data.id);
              await invokeGenerateCoverLetter({
                application_id: data.id,
                job_title: fields.job_title,
                company_name: fields.company_name,
                job_description: fields.job_description,
                resume_path: resumePath,
              });
              coversOk++;
            } catch (clErr) {
              console.error(clErr);
              coverGenFailed++;
            }
          } else {
            coversSkipped++;
          }
        } catch (e) {
          failed++;
          console.error(e);
          toast.error(e instanceof Error ? e.message : "Batch item failed.");
        }
        setBatchQueueMeta({ total: urls.length, remaining: urls.length - i - 1 });
      }
      const parts = [
        `${created} application${created === 1 ? "" : "s"} created`,
        failed ? `${failed} failed` : null,
        coversOk ? `${coversOk} cover letter${coversOk === 1 ? "" : "s"} generated` : null,
        coversSkipped ? `${coversSkipped} without auto cover (thin or failed scrape)` : null,
        coverGenFailed ? `${coverGenFailed} cover generation error${coverGenFailed === 1 ? "" : "s"}` : null,
      ].filter(Boolean);
      toast.success(parts.join(" · "));
    } finally {
      setBatchRunning(false);
      setBatchQueueMeta(null);
      setBatchUrlText("");
      const { list, sparkle } = await loadApplicationsAndSparkle(user.id);
      setApplications(list);
      setCoverSparkleByAppId(sparkle);
    }
  };

  const confirmDeleteApplication = async () => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setDeleting(true);

    // 0. If automation is running for this app, kill the runner session first (best-effort).
    //    This frees the single-session lock so other apps can start.
    killRunnerSession(id).catch(() => {/* non-fatal — runner may already be free */});

    // 1. Find all documents linked to this application
    const { data: linkedDocs } = await supabase
      .from("application_documents")
      .select("document_id, documents(id, file_path)")
      .eq("application_id", id);

    // 2. Delete storage files for linked documents
    if (linkedDocs && linkedDocs.length > 0) {
      const filePaths = linkedDocs
        .map((row: { documents: { file_path: string } | null }) => row.documents?.file_path)
        .filter(Boolean) as string[];
      if (filePaths.length > 0) {
        await supabase.storage.from("documents").remove(filePaths);
      }

      // 3. Delete the document rows (application_documents rows cascade automatically)
      const docIds = linkedDocs
        .map((row: { document_id: string }) => row.document_id)
        .filter(Boolean) as string[];
      if (docIds.length > 0) {
        await supabase.from("documents").delete().in("id", docIds);
      }
    }

    // 4. Delete the application (cascades: application_events, application_documents, generated_artifacts)
    const { error } = await supabase.from("applications").delete().eq("id", id);
    setDeleting(false);
    setDeleteTarget(null);
    if (error) {
      toast.error(error.message || "Could not delete application");
      return;
    }
    toast.success("Application deleted");
    setApplications((prev) => prev.filter((a) => a.id !== id));
    setCoverSparkleByAppId((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const batchDetectedUrlCount = useMemo(() => parseJobUrlsFromText(batchUrlText).length, [batchUrlText]);

  const filteredSortedApplications = useMemo(() => {
    const filtered = applications.filter((app) => applicationMatchesColumnFilters(app, columnFilters));
    return [...filtered].sort((a, b) => compareApplications(a, b, sortKey, sortDir));
  }, [applications, columnFilters, sortKey, sortDir]);

  const stats = {
    total: applications.length,
    active: applications.filter(a => !a.outcome && a.submission_status === "submitted").length,
    accepted: applications.filter(a => a.outcome === "offer_accepted").length,
    rejected: applications.filter(a => a.outcome === "rejected").length,
  };

  return (
    <AppLayout>
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && !deleting && setDeleteTarget(null)}
      >
        {deleteTarget ? (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this application?</AlertDialogTitle>
              <AlertDialogDescription>
                {`"${deleteTarget.job_title}" at ${deleteTarget.company_name} will be permanently removed, including all linked documents, generated cover letters, resumes, and storage files. This cannot be undone.`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={deleting}
                onClick={(e) => {
                  e.preventDefault();
                  void confirmDeleteApplication();
                }}
              >
                {deleting ? "Deleting…" : "Delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>

      <div className="space-y-8 animate-fade-in">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Dashboard</h1>
            <p className="text-muted-foreground mt-1">Track your job applications</p>
          </div>
          <Button asChild className="w-full sm:w-auto">
            <Link to="/applications/new"><PlusCircle className="h-4 w-4 mr-2" />New Application</Link>
          </Button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: "Total", value: stats.total, icon: Briefcase, color: "text-foreground" },
            { label: "Active", value: stats.active, icon: Clock, color: "text-primary" },
            { label: "Accepted", value: stats.accepted, icon: CheckCircle2, color: "text-success" },
            { label: "Rejected", value: stats.rejected, icon: XCircle, color: "text-destructive" },
          ].map(s => (
            <Card key={s.label}>
              <CardContent className="p-4 sm:pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">{s.label}</p>
                    <p className={`text-3xl font-bold ${s.color}`}>{s.value}</p>
                  </div>
                  <s.icon className={`h-8 w-8 ${s.color} opacity-20`} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Batch import from URLs</CardTitle>
            <CardDescription>
              Put one job URL per line. The queue runs top to bottom: scrape each listing, create a draft application, then
              generate a cover letter only when the scrape succeeds and the posting has enough text to tailor from.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="batch-job-urls">Job posting URLs</Label>
              <Textarea
                id="batch-job-urls"
                rows={8}
                placeholder={"https://careers.example.com/jobs/123\nhttps://boards.greenhouse.io/…"}
                value={batchUrlText}
                onChange={(e) => setBatchUrlText(e.target.value)}
                disabled={batchRunning}
                className="font-mono text-sm min-h-[180px]"
              />
              {!batchRunning && batchUrlText.trim() ? (
                <p className="text-xs text-muted-foreground">
                  {batchDetectedUrlCount} valid URL{batchDetectedUrlCount === 1 ? "" : "s"} detected
                </p>
              ) : null}
            </div>
            {batchQueueMeta ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Queue</span>
                  <span className="font-medium tabular-nums">
                    {batchQueueMeta.remaining} remaining
                    {batchQueueMeta.total ? ` of ${batchQueueMeta.total}` : ""}
                  </span>
                </div>
                <Progress
                  value={
                    batchQueueMeta.total > 0
                      ? ((batchQueueMeta.total - batchQueueMeta.remaining) / batchQueueMeta.total) * 100
                      : 0
                  }
                />
              </div>
            ) : null}
            <Button type="button" disabled={batchRunning || !user} onClick={() => void runBatchImport()}>
              {batchRunning ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Processing queue…
                </>
              ) : (
                "Start batch import"
              )}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle>Applications</CardTitle>
                <CardDescription className="mt-1.5">
                  Sort with column headers. Use the field under each header to filter that column (substring match; date
                  columns also match formatted text such as Jan or 2026).
                </CardDescription>
              </div>
              {!loading && applications.length > 0 && columnFiltersActive(columnFilters) ? (
                <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={clearAllTableFilters}>
                  Clear column filters
                </Button>
              ) : null}
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="text-center py-12 text-muted-foreground">Loading...</div>
            ) : applications.length === 0 ? (
              <div className="text-center py-12">
                <Briefcase className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
                <p className="text-muted-foreground">No applications yet</p>
                <Button asChild className="mt-4" variant="outline">
                  <Link to="/applications/new">Add your first application</Link>
                </Button>
              </div>
            ) : filteredSortedApplications.length === 0 ? (
              <div className="text-center py-12 space-y-3">
                <p className="text-muted-foreground">No applications match your column filters.</p>
                <Button type="button" variant="outline" size="sm" onClick={clearAllTableFilters}>
                  Clear column filters
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Showing {filteredSortedApplications.length} of {applications.length} application
                  {applications.length === 1 ? "" : "s"}
                </p>
                <div className="md:hidden space-y-2">
                  {filteredSortedApplications.map((app) => (
                    <div key={app.id} className="rounded-lg border border-border bg-card p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 mb-0.5">
                            {coverSparkleByAppId[app.id] && (
                              <span className={coverSparkleByAppId[app.id] === "gold"
                                ? "text-sm leading-none drop-shadow-[0_0_3px_rgba(234,179,8,0.75)] saturate-150"
                                : "text-sm leading-none grayscale opacity-[0.55]"}>✨</span>
                            )}
                            <Link
                              to={`/applications/${app.id}`}
                              state={{ fromPage: "dashboard" }}
                              className="text-primary hover:underline font-medium text-sm truncate block"
                            >
                              {app.job_title}
                            </Link>
                          </div>
                          <p className="text-xs text-muted-foreground truncate">{app.company_name}{app.location ? ` · ${app.location}` : ""}</p>
                          <div className="flex flex-wrap items-center gap-1.5 mt-2">
                            <Badge className={submissionStatusColors[app.submission_status]} variant="secondary">
                              {submissionStatusLabels[app.submission_status] || app.submission_status}
                            </Badge>
                            <Badge className={stageColors[app.application_status]} variant="secondary">
                              {stageLabels[app.application_status] || app.application_status}
                            </Badge>
                            {app.outcome && (
                              <Badge className={outcomeColors[app.outcome]} variant="secondary">
                                {outcomeLabels[app.outcome] || app.outcome}
                              </Badge>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <span className="text-xs text-muted-foreground whitespace-nowrap">
                            {format(new Date(app.updated_at), "MMM d")}
                          </span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground hover:text-destructive h-7 w-7"
                            onClick={() => setDeleteTarget(app)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="hidden md:block rounded-md border border-border overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="w-8 min-w-[2rem] max-w-[2rem] px-0 text-center py-2 align-middle">
                          <span className="sr-only">AI-generated cover</span>
                        </TableHead>
                        <FilterableSortableColumnHead
                          label="Job title"
                          columnKey="job_title"
                          activeKey={sortKey}
                          dir={sortDir}
                          onSort={handleApplicationSort}
                          filterValue={columnFilters.job_title}
                          onFilterChange={(v) => setColumnFilter("job_title", v)}
                          filterPlaceholder="Filter title…"
                          filterAriaLabel="Filter by job title"
                          className="min-w-[130px]"
                        />
                        <FilterableSortableColumnHead
                          label="Company"
                          columnKey="company_name"
                          activeKey={sortKey}
                          dir={sortDir}
                          onSort={handleApplicationSort}
                          filterValue={columnFilters.company_name}
                          onFilterChange={(v) => setColumnFilter("company_name", v)}
                          filterPlaceholder="Filter company…"
                          filterAriaLabel="Filter by company"
                          className="min-w-[110px]"
                        />
                        <FilterableSortableColumnHead
                          label="Location"
                          columnKey="location"
                          activeKey={sortKey}
                          dir={sortDir}
                          onSort={handleApplicationSort}
                          filterValue={columnFilters.location}
                          onFilterChange={(v) => setColumnFilter("location", v)}
                          filterPlaceholder="Filter location…"
                          filterAriaLabel="Filter by location"
                          className="min-w-[90px]"
                        />
                        <FilterableSortableColumnHead
                          label="Status"
                          columnKey="submission_status"
                          activeKey={sortKey}
                          dir={sortDir}
                          onSort={handleApplicationSort}
                          filterValue={columnFilters.submission_status}
                          onFilterChange={(v) => setColumnFilter("submission_status", v)}
                          filterPlaceholder="e.g. Submitted"
                          filterAriaLabel="Filter by submission status"
                          className="min-w-[90px]"
                        />
                        <FilterableSortableColumnHead
                          label="Stage"
                          columnKey="application_status"
                          activeKey={sortKey}
                          dir={sortDir}
                          onSort={handleApplicationSort}
                          filterValue={columnFilters.application_status}
                          onFilterChange={(v) => setColumnFilter("application_status", v)}
                          filterPlaceholder="e.g. Screening"
                          filterAriaLabel="Filter by application stage"
                          className="min-w-[90px]"
                        />
                        <FilterableSortableColumnHead
                          label="Outcome"
                          columnKey="outcome"
                          activeKey={sortKey}
                          dir={sortDir}
                          onSort={handleApplicationSort}
                          filterValue={columnFilters.outcome}
                          onFilterChange={(v) => setColumnFilter("outcome", v)}
                          filterPlaceholder="e.g. Rejected"
                          filterAriaLabel="Filter by outcome"
                        />
                        <FilterableSortableColumnHead
                          label="Last updated"
                          columnKey="updated_at"
                          activeKey={sortKey}
                          dir={sortDir}
                          onSort={handleApplicationSort}
                          filterValue={columnFilters.updated_at}
                          onFilterChange={(v) => setColumnFilter("updated_at", v)}
                          filterPlaceholder="e.g. Apr 2026"
                          filterAriaLabel="Filter by last updated date"
                        />
                        <TableHead className="align-top w-12 p-2" aria-label="Actions" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredSortedApplications.map((app) => (
                        <TableRow key={app.id} className="group">
                          <TableCell className="w-8 min-w-[2rem] max-w-[2rem] px-0 text-center align-middle">
                            {coverSparkleByAppId[app.id] ? (
                              <span
                                role="img"
                                className={
                                  coverSparkleByAppId[app.id] === "gold"
                                    ? "inline-block text-sm leading-none drop-shadow-[0_0_3px_rgba(234,179,8,0.75)] saturate-150"
                                    : "inline-block text-sm leading-none grayscale opacity-[0.55]"
                                }
                                title={
                                  coverSparkleByAppId[app.id] === "gold"
                                    ? "Generated cover letter is marked for submission"
                                    : "AI-generated cover letter available"
                                }
                                aria-label={
                                  coverSparkleByAppId[app.id] === "gold"
                                    ? "Generated cover letter is marked for submission"
                                    : "AI-generated cover letter available"
                                }
                              >
                                ✨
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell className="font-medium max-w-[220px]">
                            <Link
                              to={`/applications/${app.id}`}
                              state={{ fromPage: "dashboard" }}
                              className="text-primary hover:underline truncate block"
                              title={app.job_title}
                            >
                              {app.job_title}
                            </Link>
                          </TableCell>
                          <TableCell className="text-muted-foreground max-w-[180px]">
                            <span className="truncate block" title={app.company_name}>
                              {app.company_name}
                            </span>
                          </TableCell>
                          <TableCell className="text-muted-foreground max-w-[160px]">
                            <span className="truncate block" title={app.location ?? undefined}>
                              {app.location ?? "—"}
                            </span>
                          </TableCell>
                          <TableCell>
                            <Badge className={submissionStatusColors[app.submission_status]} variant="secondary">
                              {submissionStatusLabels[app.submission_status] || app.submission_status}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge className={stageColors[app.application_status]} variant="secondary">
                              {stageLabels[app.application_status] || app.application_status}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {app.outcome ? (
                              <Badge className={outcomeColors[app.outcome]} variant="secondary">
                                {outcomeLabels[app.outcome] || app.outcome}
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums text-xs sm:text-sm">
                            {format(new Date(app.updated_at), "MMM d, yyyy")}
                          </TableCell>
                          <TableCell className="text-right pr-2">
                            <div className="flex items-center justify-end gap-1">
                              {app.automation_queue_state && ACTIVE_AUTOMATION_STATES.has(app.automation_queue_state) && (
                                <span title="Automation running" className="inline-flex h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
                              )}
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="text-muted-foreground hover:text-destructive h-8 w-8"
                                title={
                                  app.automation_queue_state && ACTIVE_AUTOMATION_STATES.has(app.automation_queue_state)
                                    ? "Automation is running — deleting will stop it"
                                    : "Delete application"
                                }
                                aria-label={`Delete ${app.job_title} at ${app.company_name}`}
                                onClick={() => setDeleteTarget(app)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
