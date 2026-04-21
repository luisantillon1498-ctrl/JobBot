import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUp, Loader2, Play, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";
import { AppLayout } from "@/components/AppLayout";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { startApplyingQueue, startApplyingQueueSequential } from "@/lib/startApplyingQueue";
import { killRunnerSession } from "@/lib/runnerSession";

type QueueApplication = {
  id: string;
  company_name: string;
  job_title: string;
  job_url: string | null;
  submission_status: string;
  automation_queue_state: string;
  automation_queue_priority: number;
  automation_queue_excluded: boolean;
  submitted_resume_document_id: string | null;
  submitted_cover_document_id: string | null;
  automation_last_error: string | null;
  automation_last_context: Record<string, unknown> | null;
  automation_live_url: string | null;
};

type QueueRow = QueueApplication & {
  selected_resume_label: string;
  selected_cover_label: string;
};

const READY_TO_SUBMIT_QUEUE_STATE = "ready_to_submit";

/** States that appear in the User queue (review / handoff / final approval). */
const USER_QUEUE_STATES = new Set([
  "waiting_for_review",
  "waiting_for_human_action",
  "failed",
  READY_TO_SUBMIT_QUEUE_STATE,
]);

/** OR-clause for loading rows into either queue table (matches DB CHECK on automation_queue_state). */
const AUTOMATION_STATES = [
  "queued",
  "autofilling",
  "human_action_completed",
  READY_TO_SUBMIT_QUEUE_STATE,
  "waiting_for_review",
  "waiting_for_human_action",
  "failed",
];

function handoffCategoryFromRow(row: QueueApplication): string | null {
  const meta = row.automation_last_context;
  if (!meta || typeof meta !== "object") return null;
  const ctx = (meta as { context?: unknown }).context;
  if (!ctx || typeof ctx !== "object") return null;
  const cat = (ctx as { handoff_category?: unknown }).handoff_category;
  return typeof cat === "string" ? cat : null;
}

const statusLabel = (app: QueueApplication): string => {
  if (app.submission_status === "submitted") return "Submitted";
  if (app.automation_queue_state === READY_TO_SUBMIT_QUEUE_STATE) return "Ready to submit";
  if (app.automation_queue_state === "queued") return "Queued";
  if (app.automation_queue_state === "autofilling") return "Autofilling";
  if (app.automation_queue_state === "human_action_completed") return "Resuming…";
  if (app.automation_queue_state === "waiting_for_review") return "Waiting for review";
  if (app.automation_queue_state === "waiting_for_human_action") return "Waiting for human action";
  if (app.automation_queue_state === "failed") return "Failed";
  return app.automation_queue_state;
};

async function fetchQueueRows(userId: string): Promise<{ jobBotRows: QueueRow[]; userRows: QueueRow[] }> {
  const queueOrClause = [
    "submission_status.eq.draft",
    ...AUTOMATION_STATES.map((state) => `automation_queue_state.eq.${state}`),
  ].join(",");

  const { data, error } = await supabase
    .from("applications")
    .select(
      "id, company_name, job_title, job_url, submission_status, automation_queue_state, automation_queue_priority, automation_queue_excluded, submitted_resume_document_id, submitted_cover_document_id, automation_last_error, automation_last_context, automation_live_url",
    )
    .eq("user_id", userId)
    .neq("submission_status", "submitted")
    .or(queueOrClause)
    .order("automation_queue_priority", { ascending: true })
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  const apps = (data ?? []) as QueueApplication[];
  const docIds = [
    ...new Set(apps.flatMap((app) => [app.submitted_resume_document_id, app.submitted_cover_document_id]).filter(Boolean)),
  ] as string[];
  const docLabelById = new Map<string, string>();

  if (docIds.length > 0) {
    const { data: docs } = await supabase.from("documents").select("id, name, version").eq("user_id", userId).in("id", docIds);
    for (const doc of docs ?? []) {
      docLabelById.set(doc.id, `${doc.name} v${doc.version}`);
    }
  }

  const withLabels: QueueRow[] = apps.map((app, idx) => ({
    ...app,
    automation_queue_priority: app.automation_queue_priority > 0 ? app.automation_queue_priority : idx + 1,
    selected_resume_label: app.submitted_resume_document_id
      ? docLabelById.get(app.submitted_resume_document_id) ?? "Selected resume"
      : "None selected",
    selected_cover_label: app.submitted_cover_document_id
      ? docLabelById.get(app.submitted_cover_document_id) ?? "Selected cover letter"
      : "None selected",
  }));

  const userRows = withLabels
    .filter((row) => USER_QUEUE_STATES.has(row.automation_queue_state))
    .sort((a, b) => a.automation_queue_priority - b.automation_queue_priority);

  const jobBotRows = withLabels
    .filter((row) => !USER_QUEUE_STATES.has(row.automation_queue_state))
    .sort((a, b) => a.automation_queue_priority - b.automation_queue_priority)
    .map((row, idx) => ({ ...row, automation_queue_priority: idx + 1 }));

  return { jobBotRows, userRows };
}

function summarizeHandoff(rows: QueueRow[]): string {
  const cats = new Set(rows.map((r) => handoffCategoryFromRow(r)).filter(Boolean));
  if (cats.has("captcha")) return "Captcha or bot check detected on one or more applications.";
  if (cats.has("runner_unreachable")) return "JobBot could not reach the browser runner. Check deployment and secrets.";
  if (cats.has("unanswered_question")) return "An eligibility or form question needs your answer.";
  if (cats.size > 0) return "A manual step is required before autofill can continue.";
  return "Open the job link and complete the required step in your browser, then use Resume queue to retry automation.";
}

export default function ApplicationQueue() {
  const { user } = useAuth();
  const [jobBotRows, setJobBotRows] = useState<QueueRow[]>([]);
  const [userRows, setUserRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [runningApplicationId, setRunningApplicationId] = useState<string | null>(null);
  const [initialSnapshot, setInitialSnapshot] = useState<string>("[]");
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [killingSessionId, setKillingSessionId] = useState<string | null>(null);

  const humanActionRows = useMemo(
    () => [...jobBotRows, ...userRows].filter((r) => r.automation_queue_state === "waiting_for_human_action"),
    [jobBotRows, userRows],
  );

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const { jobBotRows: loadedJobBotRows, userRows: loadedUserRows } = await fetchQueueRows(user.id);
        if (!cancelled) {
          setJobBotRows(loadedJobBotRows);
          setUserRows(loadedUserRows);
          const snapshot = JSON.stringify(
            loadedJobBotRows.map((row) => ({
              id: row.id,
              priority: row.automation_queue_priority,
              excluded: row.automation_queue_excluded,
            })),
          );
          setInitialSnapshot(snapshot);
          setLoading(false);
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "Could not load queue";
          toast.error(message);
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const moveRow = (index: number, direction: "up" | "down") => {
    setJobBotRows((prev) => {
      const target = direction === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next.map((row, idx) => ({ ...row, automation_queue_priority: idx + 1 }));
    });
  };

  const toggleExcluded = (id: string, excluded: boolean) => {
    setJobBotRows((prev) => prev.map((row) => (row.id === id ? { ...row, automation_queue_excluded: excluded } : row)));
  };

  const hasChanges = useMemo(() => {
    const current = JSON.stringify(
      jobBotRows.map((row) => ({
        id: row.id,
        priority: row.automation_queue_priority,
        excluded: row.automation_queue_excluded,
      })),
    );
    return current !== initialSnapshot;
  }, [jobBotRows, initialSnapshot]);

  const saveQueue = async (): Promise<boolean> => {
    if (!user || !hasChanges) return false;
    setSaving(true);
    try {
      await Promise.all(
        jobBotRows.map((row) =>
          supabase
            .from("applications")
            .update({
              automation_queue_priority: row.automation_queue_priority,
              automation_queue_excluded: row.automation_queue_excluded,
            })
            .eq("id", row.id)
            .eq("user_id", user.id),
        ),
      );
      setInitialSnapshot(
        JSON.stringify(
          jobBotRows.map((row) => ({
            id: row.id,
            priority: row.automation_queue_priority,
            excluded: row.automation_queue_excluded,
          })),
        ),
      );
      toast.success("Queue saved");
      return true;
    } catch (error) {
      console.error(error);
      toast.error("Could not save queue");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const loadQueue = async (opts?: { silent?: boolean }) => {
    if (!user) return;
    if (!opts?.silent) setLoading(true);
    try {
      const { jobBotRows: loadedJobBotRows, userRows: loadedUserRows } = await fetchQueueRows(user.id);
      setJobBotRows(loadedJobBotRows);
      setUserRows(loadedUserRows);
      setInitialSnapshot(
        JSON.stringify(
          loadedJobBotRows.map((row) => ({
            id: row.id,
            priority: row.automation_queue_priority,
            excluded: row.automation_queue_excluded,
          })),
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load queue";
      toast.error(message);
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  };

  const orderedSelectableIds = (): string[] =>
    jobBotRows.filter((row) => !row.automation_queue_excluded && Boolean(row.job_url?.trim())).map((row) => row.id);

  const handleStartApplying = async () => {
    if (!user) return;
    const jobBotAllExcluded = jobBotRows.length > 0 && jobBotRows.every((row) => row.automation_queue_excluded);
    if (jobBotAllExcluded) {
      toast.error("No applications selected. Uncheck Exclude on at least one item in JobBot's queue.");
      return;
    }
    if (jobBotRows.length === 0 && userRows.length === 0) {
      toast.error("Nothing in your queue. Add a draft application or fix items missing a job URL.");
      return;
    }
    const applicationIds = orderedSelectableIds();
    if (applicationIds.length === 0) {
      toast.error("No runnable applications. Add a job URL and ensure at least one row is not excluded.");
      return;
    }

    setStarting(true);
    try {
      if (hasChanges) {
        const saved = await saveQueue();
        if (!saved) return;
      }
      const result = await startApplyingQueueSequential(applicationIds, { resume: false }, (id) => {
        setRunningApplicationId(id);
        if (id) {
          setJobBotRows((prev) => prev.map((r) => (r.id === id ? { ...r, automation_queue_state: "autofilling" } : r)));
        }
      });
      const waiting = result.outcomes.filter((o) => o.state === "waiting_for_review").length;
      const handoff = result.outcomes.filter((o) => o.state === "waiting_for_human_action").length;
      const failed = result.outcomes.filter((o) => o.state === "failed").length;
      toast.success(
        `Processed ${result.processed} application${result.processed === 1 ? "" : "s"}: ${waiting} waiting for review, ${handoff} need human action, ${failed} failed.`,
      );
      if (result.stopped_by_hard_blocker) {
        toast.message("Queue paused by a hard blocker. Fix the issue, then use Start Applying or Resume queue.");
      }
    } catch (error) {
      console.error(error);
      const msg = error instanceof Error ? error.message : "Could not start applying queue.";
      toast.error(msg);
    } finally {
      setRunningApplicationId(null);
      setStarting(false);
      await loadQueue({ silent: true });
    }
  };

  const resumeApplicationIds = (): string[] => {
    const combined = [...jobBotRows, ...userRows].filter((r) => r.automation_queue_state === "waiting_for_human_action");
    const sorted = [...combined].sort((a, b) => a.automation_queue_priority - b.automation_queue_priority);
    return [...new Set(sorted.map((r) => r.id))];
  };

  const handleResumeQueue = async () => {
    if (!user) return;
    const applicationIds = resumeApplicationIds();
    if (applicationIds.length === 0) {
      toast.error("Nothing to resume. No applications are waiting for human action.");
      return;
    }
    setStarting(true);
    try {
      const result = await startApplyingQueueSequential(applicationIds, { resume: true }, (id) => {
        setRunningApplicationId(id);
        if (id) {
          setJobBotRows((prev) => prev.map((r) => (r.id === id ? { ...r, automation_queue_state: "autofilling" } : r)));
          setUserRows((prev) => prev.map((r) => (r.id === id ? { ...r, automation_queue_state: "autofilling" } : r)));
        }
      });
      const waiting = result.outcomes.filter((o) => o.state === "waiting_for_review").length;
      const handoff = result.outcomes.filter((o) => o.state === "waiting_for_human_action").length;
      const failed = result.outcomes.filter((o) => o.state === "failed").length;
      toast.success(
        `Resumed ${result.processed} application${result.processed === 1 ? "" : "s"}: ${waiting} waiting for review, ${handoff} still need action, ${failed} failed.`,
      );
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : "Could not resume queue.");
    } finally {
      setRunningApplicationId(null);
      setStarting(false);
      await loadQueue({ silent: true });
    }
  };

  const handleResume = async (applicationId: string) => {
    setResumingId(applicationId);
    try {
      await startApplyingQueue({ applicationIds: [applicationId], resume: true });
      toast.success("Automation resumed");
      await loadQueue({ silent: true });
    } catch (err) {
      toast.error("Failed to resume automation");
    } finally {
      setResumingId(null);
    }
  };

  const handleEndSession = async (applicationId: string) => {
    setKillingSessionId(applicationId);
    try {
      await killRunnerSession(applicationId);
      toast.success("Session ended — runner is now free to start another application");
      await loadQueue({ silent: true });
    } catch {
      toast.error("Could not end session — the runner may already be free");
    } finally {
      setKillingSessionId(null);
    }
  };

  return (
    <AppLayout>
      <div className="space-y-6 animate-fade-in">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Application Queue</h1>
            <p className="text-muted-foreground mt-1">
              JobBot runs items in list order (non-excluded, with a job URL). Captcha and other checks pause the run until you resume.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => void handleStartApplying()} disabled={starting || loading || saving}>
              <Play className="h-4 w-4 mr-2" />
              {starting ? "Running…" : "Start Applying"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void handleResumeQueue()}
              disabled={starting || loading || saving || humanActionRows.length === 0}
            >
              <RotateCcw className="h-4 w-4 mr-2" />
              Resume queue
            </Button>
            <Button type="button" onClick={() => void saveQueue()} disabled={saving || !hasChanges || loading}>
              <Save className="h-4 w-4 mr-2" />
              {saving ? "Saving…" : "Save Queue"}
            </Button>
          </div>
        </div>

        {/* ── Your Queue (human attention required) ─────────────────────── */}
        {(loading || userRows.length > 0) && (
          <Card className="border-amber-500/60 bg-amber-500/5">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-2 w-2 rounded-full bg-amber-500 animate-pulse" aria-hidden />
                <CardTitle className="text-amber-700 dark:text-amber-400">Your Queue</CardTitle>
              </div>
              <CardDescription>
                These applications need your attention. If a filled form is shown below, review it and submit, then click{" "}
                <strong>Resume Automation</strong>. If a verification step is blocking, complete it first.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <p className="text-muted-foreground py-8 text-center">Loading queue...</p>
              ) : (
                <div className="rounded-md border border-amber-500/30">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Company</TableHead>
                        <TableHead>Role Title</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Selected Resume</TableHead>
                        <TableHead>Selected Cover Letter</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {userRows.map((row) => (
                        <React.Fragment key={row.id}>
                          <TableRow className="bg-amber-500/5 hover:bg-amber-500/10">
                            <TableCell className="font-medium">
                              <Link to={`/applications/${row.id}`} state={{ fromPage: "queue" }} className="text-primary hover:underline">
                                {row.company_name}
                              </Link>
                            </TableCell>
                            <TableCell>
                              <Link to={`/applications/${row.id}`} state={{ fromPage: "queue" }} className="text-primary hover:underline">
                                {row.job_title}
                              </Link>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                {runningApplicationId === row.id && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />}
                                <Badge
                                  variant="secondary"
                                  className={
                                    row.automation_queue_state === "waiting_for_human_action"
                                      ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                                      : ""
                                  }
                                >
                                  {statusLabel(row)}
                                </Badge>
                              </div>
                            </TableCell>
                            <TableCell className="text-muted-foreground">{row.selected_resume_label}</TableCell>
                            <TableCell className="text-muted-foreground">{row.selected_cover_label}</TableCell>
                          </TableRow>
                          {row.automation_queue_state === "waiting_for_human_action" && (
                            <TableRow key={`${row.id}-live`}>
                              <TableCell colSpan={5} className="p-0">
                                <div className="mt-2 space-y-3 px-4 pb-4">
                                  <Alert variant="default" className="border-amber-500/50 bg-amber-500/5 py-2">
                                    <AlertDescription className="text-sm space-y-1">
                                      <p>{summarizeHandoff([row])}</p>
                                      {row.automation_last_error && (
                                        <p className="text-xs text-muted-foreground">Detail: {row.automation_last_error}</p>
                                      )}
                                    </AlertDescription>
                                  </Alert>
                                  {row.automation_live_url ? (
                                    /* noVNC live browser — user interacts directly in this iframe */
                                    <div className="rounded-lg border border-amber-500/40 overflow-hidden">
                                      <div className="bg-amber-500/10 px-3 py-1.5 flex items-center justify-between border-b border-amber-500/30">
                                        <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
                                          Live browser — review or complete any steps below, then click Resume Automation
                                        </span>
                                        <a
                                          href={row.automation_live_url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-xs text-amber-700 dark:text-amber-400 underline underline-offset-2 hover:text-amber-600"
                                        >
                                          Open in new tab ↗
                                        </a>
                                      </div>
                                      <iframe
                                        src={row.automation_live_url}
                                        className="w-full border-0"
                                        style={{ height: "480px" }}
                                        title={`Live browser for ${row.company_name} — ${row.job_title}`}
                                        allow="clipboard-read; clipboard-write; fullscreen"
                                        allowFullScreen
                                      />
                                    </div>
                                  ) : (
                                    /* Fallback when noVNC URL not yet available */
                                    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 space-y-2">
                                      <p className="text-sm text-muted-foreground">
                                        Open the job page in your browser, complete the verification, then click <strong>Resume Automation</strong>.
                                      </p>
                                      {row.job_url && (
                                        <a
                                          href={row.job_url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-700 dark:text-amber-400 underline underline-offset-2 hover:text-amber-600"
                                        >
                                          Open job page ↗
                                        </a>
                                      )}
                                    </div>
                                  )}
                                  <div className="flex gap-2">
                                    <Button
                                      onClick={() => void handleResume(row.id)}
                                      disabled={resumingId === row.id || killingSessionId === row.id}
                                      className="flex-1 bg-amber-600 hover:bg-amber-700 text-white"
                                    >
                                      {resumingId === row.id ? "Resuming…" : "Resume Automation"}
                                    </Button>
                                    <Button
                                      variant="outline"
                                      onClick={() => void handleEndSession(row.id)}
                                      disabled={killingSessionId === row.id || resumingId === row.id}
                                      className="border-amber-500/50 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10"
                                      title="End the active browser session and free the runner for other applications"
                                    >
                                      {killingSessionId === row.id ? "Ending…" : "End Session"}
                                    </Button>
                                  </div>
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </React.Fragment>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* ── Bot Queue ─────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle>JobBot&apos;s Queue</CardTitle>
            <CardDescription>Rank with arrows, exclude items to skip, save, then Start Applying.</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-muted-foreground py-8 text-center">Loading queue...</p>
            ) : jobBotRows.length === 0 ? (
              <p className="text-muted-foreground py-8 text-center">
                {userRows.length > 0 ? (
                  <>
                    Nothing listed here while everything is in your queue below. Use{" "}
                    <span className="font-medium text-foreground">Resume queue</span> if an item is waiting for human action.
                  </>
                ) : (
                  <>
                    No draft applications in JobBot&apos;s queue yet. Add one from{" "}
                    <Link to="/applications/new" className="text-primary hover:underline">
                      New Application
                    </Link>
                    .
                  </>
                )}
              </p>
            ) : (
              <div className="rounded-md border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-20">Priority</TableHead>
                      <TableHead>Company</TableHead>
                      <TableHead>Role Title</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Selected Resume</TableHead>
                      <TableHead>Selected Cover Letter</TableHead>
                      <TableHead className="w-24">Exclude</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {jobBotRows.map((row, index) => (
                      <React.Fragment key={row.id}>
                        <TableRow>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <span className="min-w-5 text-sm tabular-nums">{row.automation_queue_priority}</span>
                              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => moveRow(index, "up")} disabled={index === 0 || starting}>
                                <ArrowUp className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7"
                                onClick={() => moveRow(index, "down")}
                                disabled={index === jobBotRows.length - 1 || starting}
                              >
                                <ArrowDown className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </TableCell>
                          <TableCell className="font-medium">
                            <Link to={`/applications/${row.id}`} state={{ fromPage: "queue" }} className="text-primary hover:underline">
                              {row.company_name}
                            </Link>
                          </TableCell>
                          <TableCell>
                            <Link to={`/applications/${row.id}`} state={{ fromPage: "queue" }} className="text-primary hover:underline">
                              {row.job_title}
                            </Link>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              {runningApplicationId === row.id && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />}
                              <Badge variant="secondary">{statusLabel(row)}</Badge>
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground">{row.selected_resume_label}</TableCell>
                          <TableCell className="text-muted-foreground">{row.selected_cover_label}</TableCell>
                          <TableCell>
                            <Checkbox
                              checked={row.automation_queue_excluded}
                              onCheckedChange={(checked) => {
                                if (checked === "indeterminate") return;
                                toggleExcluded(row.id, checked === true);
                              }}
                              disabled={starting}
                              aria-label={`Exclude ${row.job_title} at ${row.company_name}`}
                            />
                          </TableCell>
                        </TableRow>
                      </React.Fragment>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
