import { useEffect, useRef, useState } from "react";
import { useParams, Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { invokeGenerateCoverLetter } from "@/lib/coverLetterGenerate";
import { getOrGenerateApplicationResumePath } from "@/lib/resumeForGeneration";
import { ensureGeneratedCoverLetterInVault } from "@/lib/saveGeneratedCoverToVault";
import { AppLayout } from "@/components/AppLayout";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { ArrowLeft, ChevronDown, ExternalLink, Sparkles, Clock, FileText, Paperclip, X, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn, sanitizeStorageFileName } from "@/lib/utils";
import { killRunnerSession } from "@/lib/runnerSession";
import type { Database, DocumentType } from "@/integrations/supabase/types";

const PG_INT_MAX = 2147483647;

const UPLOAD_RESUME_KEY = "__upload_resume__";
const UPLOAD_COVER_KEY = "__upload_cover__";
const UPLOAD_OTHER_KEY = "__upload_other__";

const applicationStages = ["not_started", "screening", "first_round_interview", "second_round_interview", "final_round_interview"];
const submissionStatuses = ["draft", "submitted"];
const outcomes = ["rejected", "withdrew", "offer_accepted", "ghosted"];

const stageLabels: Record<string, string> = {
  draft: "Not Started",
  applied: "Not Started",
  not_started: "Not Started", screening: "Screening",
  first_round_interview: "1st Round Interview", second_round_interview: "2nd Round Interview",
  final_round_interview: "Final Round Interview",
};
const submissionStatusLabels: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted",
};
const outcomeLabels: Record<string, string> = {
  rejected: "Rejected", withdrew: "Withdrew", offer_accepted: "Offer Accepted", ghosted: "Ghosted",
};

const stageColors: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  applied: "bg-muted text-muted-foreground",
  not_started: "bg-muted text-muted-foreground",
  screening: "bg-warning/10 text-warning", first_round_interview: "bg-warning/10 text-warning",
  second_round_interview: "bg-warning/10 text-warning", final_round_interview: "bg-accent/10 text-accent-foreground",
};
const submissionStatusColors: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  submitted: "bg-primary/10 text-primary",
};
const outcomeColors: Record<string, string> = {
  rejected: "bg-destructive/10 text-destructive", withdrew: "bg-muted text-muted-foreground",
  offer_accepted: "bg-success/10 text-success", ghosted: "bg-muted text-muted-foreground/70",
};

type DeleteDialog =
  | { kind: "application" }
  | { kind: "artifact"; artifactId: string }
  | { kind: "vaultDocument"; docId: string; filePath: string; displayName: string };

type ApplicationRow = Database["public"]["Tables"]["applications"]["Row"];
type ApplicationEventRow = Database["public"]["Tables"]["application_events"]["Row"];
type GeneratedArtifactRow = Database["public"]["Tables"]["generated_artifacts"]["Row"];
type ApplicationDocumentRow = Database["public"]["Tables"]["application_documents"]["Row"];
type DocumentRow = Database["public"]["Tables"]["documents"]["Row"];
type LinkedDocumentRow = ApplicationDocumentRow & { documents: DocumentRow | null };

export default function ApplicationDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const fromPage =
    location.state && typeof location.state === "object" && "fromPage" in location.state
      ? (location.state as { fromPage?: string }).fromPage
      : undefined;
  const backHref = fromPage === "queue" ? "/applications/queue" : "/dashboard";
  const backLabel = fromPage === "queue" ? "Back to Application Queue" : "Back to Dashboard";

  const [app, setApp] = useState<ApplicationRow | null>(null);
  const [events, setEvents] = useState<ApplicationEventRow[]>([]);
  const [artifacts, setArtifacts] = useState<GeneratedArtifactRow[]>([]);
  const [linkedDocs, setLinkedDocs] = useState<LinkedDocumentRow[]>([]);
  const [allDocs, setAllDocs] = useState<DocumentRow[]>([]);
  const [generating, setGenerating] = useState(false);
  const [generatingResume, setGeneratingResume] = useState(false);
  const [loading, setLoading] = useState(true);
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialog | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [artifactExpanded, setArtifactExpanded] = useState<Record<string, boolean>>({});
  const [submissionBusy, setSubmissionBusy] = useState(false);
  const [markReadyBusy, setMarkReadyBusy] = useState(false);
  const [editingArtifactId, setEditingArtifactId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editFeedback, setEditFeedback] = useState("");
  const [savingEditedArtifact, setSavingEditedArtifact] = useState(false);
  const [attachSelectValue, setAttachSelectValue] = useState<string | undefined>(undefined);
  const [attachUploading, setAttachUploading] = useState(false);
  const attachFileInputRef = useRef<HTMLInputElement>(null);
  const pendingUploadDocType = useRef<DocumentType | null>(null);

  const fetchData = async () => {
    if (!user || !id) return;
    // Avoid PostgREST embed `documents(*)` on application_documents — it can 404 (PGRST205) when the
    // relationship is not exposed as expected. Merge link rows with the parallel documents query instead.
    const [appRes, eventsRes, artifactsRes, linkedRes, docsRes] = await Promise.all([
      supabase.from("applications").select("*").eq("id", id).single(),
      supabase.from("application_events").select("*").eq("application_id", id).order("created_at", { ascending: false }),
      supabase.from("generated_artifacts").select("*").eq("application_id", id).order("created_at", { ascending: false }),
      supabase.from("application_documents").select("*").eq("application_id", id),
      supabase.from("documents").select("*").eq("user_id", user.id).order("created_at", { ascending: false }),
    ]);
    const allDocsList = (docsRes.data || []) as DocumentRow[];
    const docById = new Map(allDocsList.map((d) => [d.id, d]));
    const linkedMerged: LinkedDocumentRow[] = ((linkedRes.data || []) as ApplicationDocumentRow[]).map((row) => ({
      ...row,
      documents: docById.get(row.document_id) ?? null,
    }));

    setApp(appRes.data);
    setEvents(eventsRes.data || []);
    setArtifacts(artifactsRes.data || []);
    setLinkedDocs(linkedMerged);
    setAllDocs(allDocsList);
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, [user, id]);

  const updateStage = async (newStage: string) => {
    if (!user || !id) return;
    const oldStage = app.application_status;
    await supabase.from("applications").update({
      application_status: newStage,
    }).eq("id", id);
    await supabase.from("application_events").insert({
      application_id: id, user_id: user.id, event_type: "status_change",
      description: `Application stage changed from ${stageLabels[oldStage] || oldStage} to ${stageLabels[newStage] || newStage}`,
    });
    toast.success("Application stage updated");
    fetchData();
  };

  const updateSubmissionStatus = async (newSubmissionStatus: string) => {
    if (!user || !id || !app) return;
    const oldSubmissionStatus = app.submission_status;
    const now = new Date().toISOString();
    const appliedPatch =
      newSubmissionStatus === "submitted" && !app.applied_at ? { applied_at: now } : {};

    const automationPatch =
      newSubmissionStatus === "submitted"
        ? {
            automation_queue_state: "submitted" as const,
            automation_last_outcome: "submitted" as const,
            automation_last_run_at: now,
            automation_last_error: null,
            automation_last_context: {
              queue_state: "submitted",
              lifecycle_phase: "submitted",
              source: "user_submission_status",
              session_id: app.automation_active_session_id,
            },
          }
        : {};

    const { error: updateError } = await supabase
      .from("applications")
      .update({
        submission_status: newSubmissionStatus,
        ...appliedPatch,
        ...automationPatch,
      })
      .eq("id", id);
    if (updateError) {
      toast.error(updateError.message);
      return;
    }

    await supabase.from("application_events").insert({
      application_id: id, user_id: user.id, event_type: "status_change",
      description: `Submission status changed from ${submissionStatusLabels[oldSubmissionStatus] || oldSubmissionStatus} to ${submissionStatusLabels[newSubmissionStatus] || newSubmissionStatus}`,
    });
    if (newSubmissionStatus === "submitted") {
      await supabase.from("application_events").insert({
        application_id: id,
        user_id: user.id,
        event_type: "automation_status",
        description: "Marked submitted — JobBot queue state aligned with submission",
        metadata: {
          queue_state: "submitted",
          lifecycle_phase: "submitted",
          session_id: app.automation_active_session_id,
          pause: false,
        },
      });
      if (app.automation_active_session_id) {
        await supabase
          .from("application_automation_sessions")
          .update({ ended_at: now })
          .eq("id", app.automation_active_session_id)
          .eq("user_id", user.id);
      }
    }
    toast.success("Submission status updated");
    fetchData();
  };

  const markReadyToSubmitAfterReview = async () => {
    if (!user || !id || !app) return;
    setMarkReadyBusy(true);
    const now = new Date().toISOString();
    const metadata = {
      queue_state: "ready_to_submit" as const,
      context: { source: "user_review_complete" },
      session_id: app.automation_active_session_id,
      pause: false,
    };
    const { error } = await supabase
      .from("applications")
      .update({
        automation_queue_state: "ready_to_submit",
        automation_last_outcome: "ready_to_submit",
        automation_last_run_at: now,
        automation_last_error: null,
        automation_last_context: metadata,
      })
      .eq("id", id)
      .eq("user_id", user.id);
    if (error) {
      toast.error(error.message);
      setMarkReadyBusy(false);
      return;
    }
    await supabase.from("application_events").insert({
      application_id: id,
      user_id: user.id,
      event_type: "automation_status",
      description: "User marked application ready to submit after reviewing JobBot output",
      metadata,
    });
    toast.success("Marked ready to submit");
    setMarkReadyBusy(false);
    fetchData();
  };

  const updateOutcome = async (newOutcome: string) => {
    if (!user || !id) return;
    const value = newOutcome === "none" ? null : newOutcome;
    await supabase.from("applications").update({ outcome: value }).eq("id", id);
    if (value) {
      await supabase.from("application_events").insert({
        application_id: id, user_id: user.id, event_type: "outcome_change",
        description: `Outcome set to ${outcomeLabels[value] || value}`,
      });
    }
    toast.success("Outcome updated");
    fetchData();
  };

  const linkDocument = async (docId: string) => {
    if (!user || !id) return;
    const { error } = await supabase.from("application_documents").insert({
      application_id: id, document_id: docId, user_id: user.id,
    });
    if (error) { toast.error("Already linked or failed"); return; }
    toast.success("Document linked");
    setAttachSelectValue(undefined);
    fetchData();
  };

  const handleAttachSelectChange = (value: string) => {
    setAttachSelectValue(undefined);
    if (value === UPLOAD_RESUME_KEY) {
      pendingUploadDocType.current = "resume";
      setTimeout(() => attachFileInputRef.current?.click(), 0);
      return;
    }
    if (value === UPLOAD_COVER_KEY) {
      pendingUploadDocType.current = "cover_letter_template";
      setTimeout(() => attachFileInputRef.current?.click(), 0);
      return;
    }
    if (value === UPLOAD_OTHER_KEY) {
      pendingUploadDocType.current = "other";
      setTimeout(() => attachFileInputRef.current?.click(), 0);
      return;
    }
    void linkDocument(value);
  };

  const handleAttachFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    const docType = pendingUploadDocType.current;
    pendingUploadDocType.current = null;
    input.value = "";
    if (!file || !user || !id || !docType) return;

    setAttachUploading(true);
    try {
      const safeSegment = sanitizeStorageFileName(file.name);
      const filePath = `${user.id}/${Date.now()}_${safeSegment}`;
      const { error: uploadError } = await supabase.storage.from("documents").upload(filePath, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
      if (uploadError) {
        toast.error(uploadError.message || `Upload failed: ${file.name}`);
        return;
      }

      const file_size =
        file.size > PG_INT_MAX ? null : Number.isFinite(file.size) ? Math.floor(file.size) : null;

      const { data: doc, error: insertErr } = await supabase
        .from("documents")
        .insert({
          user_id: user.id,
          name: file.name,
          type: docType,
          file_path: filePath,
          file_size,
        })
        .select("id")
        .single();

      if (insertErr || !doc) {
        await supabase.storage.from("documents").remove([filePath]);
        toast.error(insertErr?.message || "Could not save document");
        return;
      }

      const { error: linkErr } = await supabase.from("application_documents").insert({
        application_id: id,
        document_id: doc.id,
        user_id: user.id,
      });
      if (linkErr && linkErr.code !== "23505") {
        toast.error(linkErr.message || "Saved to vault but could not attach to this application");
        fetchData();
        return;
      }

      toast.success("Saved to Document Vault and attached");
      fetchData();
    } finally {
      setAttachUploading(false);
    }
  };

  const handleDownloadDoc = async (filePath: string) => {
    const { data, error } = await supabase.storage
      .from("documents")
      .createSignedUrl(filePath, 3600);
    if (error || !data?.signedUrl) {
      toast.error("Could not generate download link.");
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  };

  const unlinkDocument = async (linkId: string) => {
    const { error } = await supabase.from("application_documents").delete().eq("id", linkId);
    if (error) {
      toast.error("Could not remove document from this application");
      return;
    }
    toast.success("Removed from this application");
    fetchData();
  };

  const runConfirmedDelete = async () => {
    if (!deleteDialog || !user || !id) return;
    setDeleting(true);
    try {
      if (deleteDialog.kind === "application") {
        // Best-effort: kill any active VNC/Playwright session before deleting
        // so the runner doesn't stay locked on a deleted application.
        try { await killRunnerSession(id!); } catch { /* non-fatal */ }

        // Load linked document ids first (without relying on embeds), then fetch
        // document rows separately for reliable deletion across schema states.
        const { data: linkedRows, error: linkedErr } = await supabase
          .from("application_documents")
          .select("document_id")
          .eq("application_id", id);
        if (linkedErr) {
          toast.error(linkedErr.message || "Could not load documents linked to this application");
          return;
        }

        const linkedIds = (linkedRows ?? [])
          .map((row: { document_id: string | null }) => row.document_id)
          .filter(Boolean) as string[];
        const submittedIds = [app.submitted_resume_document_id, app.submitted_cover_document_id].filter(Boolean) as string[];
        const candidateIds = [...new Set([...linkedIds, ...submittedIds])];

        const linkedDocs = candidateIds.length > 0
          ? await supabase
              .from("documents")
              .select("id, file_path")
              .in("id", candidateIds)
              .eq("user_id", user.id)
          : { data: [], error: null };
        if (linkedDocs.error) {
          toast.error(linkedDocs.error.message || "Could not load linked document records");
          return;
        }

        // Catch orphaned generated docs that may not be linked due prior failures.
        const appPrefixes = [`${user.id}/resumes/${id}/`, `${user.id}/covers/${id}/`];
        const { data: appScopedDocs, error: scopedErr } = await supabase
          .from("documents")
          .select("id, file_path")
          .eq("user_id", user.id)
          .or(appPrefixes.map((p) => `file_path.like.${p}%`).join(","));
        if (scopedErr) {
          toast.error(scopedErr.message || "Could not load generated docs for this application");
          return;
        }

        const docsToDelete = [
          ...(linkedDocs.data ?? []),
          ...(appScopedDocs ?? []),
        ];
        const uniqueById = new Map(docsToDelete.map((d) => [d.id, d]));
        const docRows = [...uniqueById.values()];

        if (docRows.length > 0) {
          const filePaths = docRows.map((row) => row.file_path).filter(Boolean) as string[];
          if (filePaths.length > 0) {
            const { error: storageErr } = await supabase.storage.from("documents").remove(filePaths);
            if (storageErr) {
              toast.error(storageErr.message || "Could not remove linked document files");
              return;
            }
          }

          const docIds = docRows.map((row) => row.id);
          if (docIds.length > 0) {
            const { error: docsErr } = await supabase.from("documents").delete().in("id", docIds);
            if (docsErr) {
              toast.error(docsErr.message || "Could not remove linked document records");
              return;
            }
          }
        }

        const { error } = await supabase.from("applications").delete().eq("id", id);
        if (error) {
          toast.error(error.message || "Could not delete application");
          return;
        }
        toast.success("Application deleted");
        navigate("/dashboard");
        return;
      }
      if (deleteDialog.kind === "artifact") {
        const { error } = await supabase.from("generated_artifacts").delete().eq("id", deleteDialog.artifactId);
        if (error) {
          toast.error(error.message || "Could not delete generated document");
          return;
        }
        toast.success("Generated document deleted");
        fetchData();
        return;
      }
      const { docId, filePath } = deleteDialog;
      const { error: dbErr } = await supabase.from("documents").delete().eq("id", docId);
      if (dbErr) {
        toast.error(dbErr.message || "Could not delete document");
        return;
      }
      const { error: stErr } = await supabase.storage.from("documents").remove([filePath]);
      if (stErr) console.warn("Storage delete after DB row removed:", stErr);
      toast.success("Document deleted from vault");
      fetchData();
    } finally {
      setDeleting(false);
      setDeleteDialog(null);
    }
  };

  const updateSubmissionDocs = async (patch: {
    submitted_resume_document_id?: string | null;
    submitted_cover_document_id?: string | null;
  }) => {
    if (!user || !id) return;
    setSubmissionBusy(true);
    // Controlled Radix Checkbox needs parent state to update immediately or the click appears to do nothing.
    setApp((p) => (p ? { ...p, ...patch } : p));
    try {
      const { error } = await supabase.from("applications").update(patch).eq("id", id);
      if (error) {
        console.error("updateSubmissionDocs", error);
        toast.error(
          error.message ||
            "Could not update submission documents. If this persists, apply the latest database migration (submitted_* columns on applications).",
        );
        await fetchData();
        return;
      }
      await fetchData();
    } finally {
      setSubmissionBusy(false);
    }
  };

  const toggleSubmittedResume = async (documentId: string, checked: boolean) => {
    if (!checked) {
      if (String(app?.submitted_resume_document_id ?? "") === String(documentId)) {
        await updateSubmissionDocs({ submitted_resume_document_id: null });
      }
      return;
    }
    await updateSubmissionDocs({ submitted_resume_document_id: documentId });
  };

  const toggleSubmittedCoverFromVault = async (documentId: string, checked: boolean) => {
    if (!checked) {
      if (String(app?.submitted_cover_document_id ?? "") === String(documentId)) {
        await updateSubmissionDocs({ submitted_cover_document_id: null });
      }
      return;
    }
    await updateSubmissionDocs({ submitted_cover_document_id: documentId });
  };

  const toggleSubmittedCoverFromArtifact = async (artifact: { id: string; content: string }, checked: boolean) => {
    if (!user || !id || !app) return;
    if (!checked) {
      const coverId = app.submitted_cover_document_id;
      if (!coverId) return;
      const doc = allDocs.find((d) => d.id === coverId);
      if (doc?.source_generated_artifact_id === artifact.id) {
        await updateSubmissionDocs({ submitted_cover_document_id: null });
      }
      return;
    }
    setSubmissionBusy(true);
    try {
      const result = await ensureGeneratedCoverLetterInVault(supabase, {
        userId: user.id,
        applicationId: id,
        artifact,
        companyName: app.company_name || "Company",
        jobTitle: app.job_title || "Role",
      });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      setApp((p) => (p ? { ...p, submitted_cover_document_id: result.documentId } : p));
      const { error } = await supabase
        .from("applications")
        .update({ submitted_cover_document_id: result.documentId })
        .eq("id", id);
      if (error) {
        console.error("submitted_cover_document_id update", error);
        toast.error(error.message || "Could not mark cover letter for submission");
        await fetchData();
        return;
      }
      toast.success("Cover letter saved to Document Vault and marked for submission");
      await fetchData();
    } finally {
      setSubmissionBusy(false);
    }
  };

  const generateResume = async () => {
    if (!user || !app) return;
    setGeneratingResume(true);
    try {
      const { data, error } = await supabase.functions.invoke("generate-resume", {
        body: { application_id: id },
      });
      if (error) throw new Error(error.message ?? "Failed to generate resume");
      const result = data as { ok?: boolean; error?: string; code?: string } | null;
      if (!result?.ok) {
        if (result?.code === "no_resume_data") {
          throw new Error(
            "Resume data is missing for this account. Add experience/education/skills in Resume Wizard, then try again.",
          );
        }
        throw new Error(result?.error ?? "Failed to generate resume");
      }
      toast.success("Resume generated and saved to documents!");
      fetchData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate resume");
    }
    setGeneratingResume(false);
  };

  const generateCoverLetter = async () => {
    if (!user || !app || !id) return;
    setGenerating(true);
    try {
      // Ensure a tailored resume exists for this application; generate one if not.
      toast.info("Preparing tailored resume…");
      const resumePath = await getOrGenerateApplicationResumePath(supabase, id);
      if (!resumePath) {
        toast.error(
          "Could not generate a resume for this application. Check that your Resume Wizard is filled in and the runner is online.",
        );
        setGenerating(false);
        return;
      }
      await invokeGenerateCoverLetter({
        application_id: id,
        job_title: app.job_title,
        company_name: app.company_name,
        job_description: app.job_description || "",
        resume_path: resumePath,
      });
      toast.success("Cover letter generated!");
      fetchData();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to generate cover letter";
      toast.error(message);
    }
    setGenerating(false);
  };

  const startEditingArtifact = (artifact: GeneratedArtifactRow) => {
    setEditingArtifactId(artifact.id);
    setEditContent(artifact.content ?? "");
    setEditFeedback("");
    setArtifactExpanded((prev) => ({ ...prev, [artifact.id]: true }));
  };

  const cancelEditingArtifact = () => {
    setEditingArtifactId(null);
    setEditContent("");
    setEditFeedback("");
  };

  const saveEditedCoverLetterVersion = async (artifact: GeneratedArtifactRow) => {
    if (!user || !id) return;
    const trimmed = editContent.trim();
    if (!trimmed) {
      toast.error("Cover letter text cannot be empty.");
      return;
    }
    setSavingEditedArtifact(true);
    try {
      const feedback = editFeedback.trim();
      const promptUsed = [
        "USER_EDIT_VERSION",
        `source_artifact_id=${artifact.id}`,
        `source_created_at=${artifact.created_at}`,
        feedback ? `feedback=${feedback}` : "feedback=",
      ].join("\n");
      const { error } = await supabase.from("generated_artifacts").insert({
        application_id: id,
        user_id: user.id,
        type: "cover_letter",
        content: trimmed,
        prompt_used: promptUsed,
        generator_version: "user-edit.1",
      });
      if (error) {
        toast.error(error.message || "Could not save edited version");
        return;
      }
      await supabase.from("application_events").insert({
        application_id: id,
        user_id: user.id,
        event_type: "document_generated",
        description: "Cover letter edited and saved as new version",
        metadata: feedback ? { feedback } : null,
      });
      toast.success("Edited cover letter saved as a new version.");
      cancelEditingArtifact();
      fetchData();
    } finally {
      setSavingEditedArtifact(false);
    }
  };

  if (loading) return <AppLayout><div className="text-muted-foreground py-12 text-center">Loading...</div></AppLayout>;
  if (!app) return <AppLayout><div className="text-muted-foreground py-12 text-center">Application not found</div></AppLayout>;

  const linkedDocIds = new Set(linkedDocs.map((ld) => ld.document_id));
  const availableDocs = allDocs.filter(d => !linkedDocIds.has(d.id));

  return (
    <AppLayout>
      <AlertDialog open={deleteDialog !== null} onOpenChange={(open) => !open && !deleting && setDeleteDialog(null)}>
        {deleteDialog ? (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {deleteDialog.kind === "application" && "Delete this application?"}
                {deleteDialog.kind === "artifact" && "Delete this generated document?"}
                {deleteDialog.kind === "vaultDocument" && "Delete document from vault?"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {deleteDialog.kind === "application" &&
                  "This removes the application, timeline, generated documents, and all documents tied to this application (including submitted resume/cover files) from your Document Vault and storage."}
                {deleteDialog.kind === "artifact" && "This permanently removes the generated text. This cannot be undone."}
                {deleteDialog.kind === "vaultDocument" &&
                  `"${deleteDialog.displayName}" will be removed from the vault and unlinked from all applications.`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={deleting}
                onClick={(e) => {
                  e.preventDefault();
                  runConfirmedDelete();
                }}
              >
                {deleting ? "Deleting…" : "Delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>

      <div className="space-y-6 animate-fade-in">
        <button
          type="button"
          onClick={() => navigate(backHref)}
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors bg-transparent p-0 border-0"
        >
          <ArrowLeft className="h-4 w-4" />
          {backLabel}
        </button>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl sm:text-3xl font-bold text-foreground break-words">{app.job_title}</h1>
            <p className="text-base sm:text-lg text-muted-foreground mt-1 break-words">
              {app.company_name}{app.location ? ` · ${app.location}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <Badge className={`${submissionStatusColors[app.submission_status]} text-sm px-3 py-1`} variant="secondary">
              {submissionStatusLabels[app.submission_status] || app.submission_status}
            </Badge>
            <Badge className={`${stageColors[app.application_status]} text-sm px-3 py-1`} variant="secondary">
              {stageLabels[app.application_status] || app.application_status}
            </Badge>
            {app.outcome && (
              <Badge className={`${outcomeColors[app.outcome]} text-sm px-3 py-1`} variant="secondary">
                {outcomeLabels[app.outcome] || app.outcome}
              </Badge>
            )}
          </div>
        </div>

        {app.automation_queue_state === "waiting_for_review" && app.submission_status !== "submitted" && (
          <Alert className="border-primary/30 bg-primary/5">
            <AlertTitle>Review JobBot autofill</AlertTitle>
            <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-sm">
                Confirm resumes, cover letters, and field mappings look correct before marking this application ready to
                submit.
              </span>
              <Button type="button" size="sm" onClick={() => void markReadyToSubmitAfterReview()} disabled={markReadyBusy}>
                {markReadyBusy ? "Saving…" : "Mark ready to submit"}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <Card>
              <CardHeader><CardTitle>Job posting</CardTitle></CardHeader>
              <CardContent className="space-y-6">
                <div className="rounded-lg border border-border bg-muted/20">
                  {(
                    [
                      { label: "Job title", value: app.job_title },
                      { label: "Company", value: app.company_name },
                      { label: "Location", value: app.location },
                      { label: "Salary range", value: app.salary_range },
                    ] as const
                  ).map(({ label, value }) => (
                    <div
                      key={label}
                      className="grid grid-cols-1 gap-0.5 px-4 py-3 sm:grid-cols-[10rem_1fr] sm:gap-4 sm:items-start border-b border-border last:border-b-0"
                    >
                      <span className="text-sm text-muted-foreground shrink-0">{label}</span>
                      <span className="text-sm font-medium text-foreground break-words">
                        {typeof value === "string" && value.trim() ? value : "—"}
                      </span>
                    </div>
                  ))}
                  <div className="grid grid-cols-1 gap-0.5 px-4 py-3 sm:grid-cols-[10rem_1fr] sm:gap-4 sm:items-start border-b border-border last:border-b-0">
                    <span className="text-sm text-muted-foreground shrink-0">Job posting URL</span>
                    <span className="text-sm break-all">
                      {app.job_url?.trim() ? (
                        <a
                          href={app.job_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                        >
                          {app.job_url}
                          <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                        </a>
                      ) : (
                        <span className="font-medium text-foreground">—</span>
                      )}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 gap-0.5 px-4 py-3 sm:grid-cols-[10rem_1fr] sm:gap-4 sm:items-start">
                    <span className="text-sm text-muted-foreground shrink-0">Applied</span>
                    <span className="text-sm font-medium text-foreground">
                      {app.applied_at ? new Date(app.applied_at).toLocaleString() : "—"}
                    </span>
                  </div>
                </div>

                <div>
                  <p className="text-sm text-muted-foreground mb-2">Job description</p>
                  {app.job_description?.trim() ? (
                    <p className="text-sm whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-4">{app.job_description}</p>
                  ) : (
                    <p className="text-sm text-muted-foreground">No description saved.</p>
                  )}
                </div>

                {app.notes?.trim() ? (
                  <div>
                    <p className="text-sm text-muted-foreground mb-2">Your notes</p>
                    <p className="text-sm whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-4">{app.notes}</p>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            {/* Linked Documents */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>Attached Documents</CardTitle>
                  <p className="text-sm text-muted-foreground mt-1 font-normal">
                    One resume and one cover letter can be marked as used when you applied.
                  </p>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {linkedDocs.length > 0 && (
                  <div className="space-y-2">
                    {linkedDocs.map((ld) => (
                      <div key={ld.id} className="flex flex-col gap-2 py-2 px-3 bg-muted/50 rounded-md">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                            <span className="text-sm font-medium truncate">{ld.documents?.name}</span>
                            <Badge variant="secondary" className="text-xs shrink-0">{ld.documents?.type}</Badge>
                          </div>
                          <div className="flex items-center shrink-0">
                            {ld.documents?.file_path ? (
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Open document"
                                onClick={() => void handleDownloadDoc(ld.documents.file_path)}
                              >
                                <ExternalLink className="h-4 w-4 text-muted-foreground" />
                              </Button>
                            ) : null}
                            <Button variant="ghost" size="icon" title="Remove from this application" onClick={() => unlinkDocument(ld.id)}>
                              <X className="h-4 w-4" />
                            </Button>
                            {ld.documents?.id && ld.documents?.file_path ? (
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Delete from vault"
                                onClick={() =>
                                  setDeleteDialog({
                                    kind: "vaultDocument",
                                    docId: ld.documents.id,
                                    filePath: ld.documents.file_path,
                                    displayName: ld.documents.name || "Document",
                                  })
                                }
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            ) : null}
                          </div>
                        </div>
                        {ld.documents?.type === "resume" ? (
                          <div className="flex items-center gap-2 pl-6 sm:pl-8">
                            <Checkbox
                              id={`sub-resume-${ld.id}`}
                              checked={
                                String(app.submitted_resume_document_id ?? "") === String(ld.document_id)
                              }
                              disabled={submissionBusy}
                              onCheckedChange={(c) => {
                                if (c === "indeterminate") return;
                                void toggleSubmittedResume(ld.document_id, c === true);
                              }}
                            />
                            <Label htmlFor={`sub-resume-${ld.id}`} className="text-xs font-normal text-muted-foreground cursor-pointer leading-snug">
                              Used this resume when I applied
                            </Label>
                          </div>
                        ) : null}
                        {ld.documents?.type === "cover_letter_template" ? (
                          <div className="flex items-center gap-2 pl-6 sm:pl-8">
                            <Checkbox
                              id={`sub-cover-${ld.id}`}
                              checked={
                                String(app.submitted_cover_document_id ?? "") === String(ld.document_id)
                              }
                              disabled={submissionBusy}
                              onCheckedChange={(c) => {
                                if (c === "indeterminate") return;
                                void toggleSubmittedCoverFromVault(ld.document_id, c === true);
                              }}
                            />
                            <Label htmlFor={`sub-cover-${ld.id}`} className="text-xs font-normal text-muted-foreground cursor-pointer leading-snug">
                              Used this cover letter when I applied
                            </Label>
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
                <input
                  ref={attachFileInputRef}
                  type="file"
                  className="sr-only"
                  accept=".pdf,.doc,.docx,.txt,.png,.jpg,.jpeg"
                  aria-hidden
                  tabIndex={-1}
                  onChange={handleAttachFileChange}
                />
                <Select
                  value={attachSelectValue}
                  onValueChange={handleAttachSelectChange}
                  disabled={attachUploading}
                >
                  <SelectTrigger>
                    <div className="flex items-center gap-2">
                      <Paperclip className="h-4 w-4" />
                      <SelectValue placeholder={attachUploading ? "Uploading…" : "Attach a document…"} />
                    </div>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>Add from computer</SelectLabel>
                      <SelectItem value={UPLOAD_RESUME_KEY}>Upload new resume…</SelectItem>
                      <SelectItem value={UPLOAD_COVER_KEY}>Upload new cover letter…</SelectItem>
                      <SelectItem value={UPLOAD_OTHER_KEY}>Upload other document…</SelectItem>
                    </SelectGroup>
                    {availableDocs.length > 0 ? (
                      <>
                        <SelectSeparator />
                        <SelectGroup>
                          <SelectLabel>From Document Vault</SelectLabel>
                          {availableDocs.map((d) => (
                            <SelectItem key={d.id} value={d.id}>
                              {d.name} ({d.type})
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </>
                    ) : null}
                  </SelectContent>
                </Select>
                {linkedDocs.length === 0 && availableDocs.length === 0 && (
                  <p className="text-muted-foreground text-sm text-center py-2">
                    No vault files linked yet. Use the menu above to upload from your computer or pick from the vault.
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Generated artifacts */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-4">
                <div className="min-w-0">
                  <CardTitle>Generated Documents</CardTitle>
                  <p className="text-sm text-muted-foreground mt-1 font-normal">
                    Use the chevron to show or hide the full text. For cover letters, you can mark one as used when you applied—it will be saved to your Document Vault if needed.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 shrink-0">
                  <Button onClick={generateCoverLetter} disabled={generating || generatingResume} size="sm">
                    <Sparkles className="h-4 w-4 mr-2" />
                    {generating ? "Generating..." : "Generate Cover Letter"}
                  </Button>
                  <Button onClick={generateResume} disabled={generating || generatingResume} size="sm" variant="outline">
                    <Sparkles className="h-4 w-4 mr-2" />
                    {generatingResume ? "Generating..." : "Generate Resume"}
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {artifacts.length === 0 ? (
                  <p className="text-muted-foreground text-sm py-4 text-center">No generated documents yet.</p>
                ) : (
                  <div className="space-y-4">
                    {artifacts.map((a) => {
                      const expanded = !!artifactExpanded[a.id];
                      const submittedCoverDoc = allDocs.find(
                        (d) =>
                          String(d.id) === String(app.submitted_cover_document_id ?? ""),
                      );
                      const coverLetterSubmitted =
                        a.type === "cover_letter" &&
                        String(submittedCoverDoc?.source_generated_artifact_id ?? "") === String(a.id);
                      return (
                        <div key={a.id} className="border border-border rounded-lg p-4">
                          <div className="flex flex-wrap items-center gap-2 mb-2">
                            <FileText className="h-4 w-4 text-primary shrink-0" />
                            <span className="font-medium text-sm capitalize">{a.type.replace("_", " ")}</span>
                            {a.generator_version ? (
                              <Badge variant="outline" className="text-xs font-normal">{a.generator_version}</Badge>
                            ) : null}
                            <span className="text-xs text-muted-foreground sm:ml-auto">{new Date(a.created_at).toLocaleString()}</span>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              className="shrink-0"
                              aria-expanded={expanded}
                              aria-label={expanded ? "Hide full generated document" : "Show full generated document"}
                              title={expanded ? "Hide full text" : "Show full text"}
                              onClick={() =>
                                setArtifactExpanded((prev) => ({ ...prev, [a.id]: !prev[a.id] }))
                              }
                            >
                              <ChevronDown
                                className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")}
                              />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="shrink-0"
                              title="Delete generated document"
                              onClick={() => setDeleteDialog({ kind: "artifact", artifactId: a.id })}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                          {expanded ? (
                            <pre className="text-sm whitespace-pre-wrap bg-muted/50 p-3 rounded-md max-h-[70vh] overflow-auto border border-border/60 mb-0">
                              {a.content}
                            </pre>
                          ) : null}
                          {a.type === "cover_letter" ? (
                            <div
                              className={cn(
                                "flex items-center gap-2",
                                expanded ? "mt-3 pt-3 border-t border-border" : "mt-2",
                              )}
                            >
                              <Checkbox
                                id={`sub-gen-cover-${a.id}`}
                                checked={coverLetterSubmitted}
                                disabled={submissionBusy}
                                onCheckedChange={(c) => {
                                  if (c === "indeterminate") return;
                                  void toggleSubmittedCoverFromArtifact(
                                    { id: a.id, content: a.content },
                                    c === true,
                                  );
                                }}
                              />
                              <Label
                                htmlFor={`sub-gen-cover-${a.id}`}
                                className="text-xs font-normal text-muted-foreground cursor-pointer leading-snug"
                              >
                                Used this cover letter when I applied (saves to Document Vault if not already there)
                              </Label>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="ml-auto"
                                onClick={() => startEditingArtifact(a)}
                              >
                                Edit & Save New Version
                              </Button>
                            </div>
                          ) : null}
                          {a.type === "cover_letter" && editingArtifactId === a.id ? (
                            <div className="mt-3 border-t border-border pt-3 space-y-3">
                              <div>
                                <Label htmlFor={`edit-cover-content-${a.id}`} className="text-xs text-muted-foreground">
                                  Edit cover letter text
                                </Label>
                                <Textarea
                                  id={`edit-cover-content-${a.id}`}
                                  className="mt-1 min-h-[180px]"
                                  value={editContent}
                                  onChange={(e) => setEditContent(e.target.value)}
                                />
                              </div>
                              <div>
                                <Label htmlFor={`edit-cover-feedback-${a.id}`} className="text-xs text-muted-foreground">
                                  Feedback points for future generations (wording, structure, tone)
                                </Label>
                                <Textarea
                                  id={`edit-cover-feedback-${a.id}`}
                                  className="mt-1 min-h-[84px]"
                                  placeholder="Example: Keep intro shorter, stronger action verbs, and tighter 3-paragraph structure."
                                  value={editFeedback}
                                  onChange={(e) => setEditFeedback(e.target.value)}
                                />
                              </div>
                              <div className="flex justify-end gap-2">
                                <Button type="button" variant="ghost" onClick={cancelEditingArtifact} disabled={savingEditedArtifact}>
                                  Cancel
                                </Button>
                                <Button
                                  type="button"
                                  onClick={() => saveEditedCoverLetterVersion(a)}
                                  disabled={savingEditedArtifact}
                                >
                                  {savingEditedArtifact ? "Saving..." : "Save New Version"}
                                </Button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            <Card>
              <CardHeader><CardTitle>Application Tracking</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm text-muted-foreground">Submission Status</label>
                  <Select value={app.submission_status} onValueChange={updateSubmissionStatus}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {submissionStatuses.map(s => (
                        <SelectItem key={s} value={s}>{submissionStatusLabels[s]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm text-muted-foreground">Application Stage</label>
                  <Select value={(app.application_status === "draft" || app.application_status === "applied") ? "not_started" : app.application_status} onValueChange={updateStage}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {applicationStages.map(s => (
                        <SelectItem key={s} value={s}>{stageLabels[s]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm text-muted-foreground">Outcome</label>
                  <Select value={app.outcome || "none"} onValueChange={updateOutcome}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No outcome yet</SelectItem>
                      {outcomes.map(o => (
                        <SelectItem key={o} value={o}>{outcomeLabels[o]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Timeline</CardTitle></CardHeader>
              <CardContent>
                {events.length === 0 ? (
                  <p className="text-muted-foreground text-sm text-center py-4">No events yet</p>
                ) : (
                  <div className="space-y-4">
                    {events.map(ev => (
                      <div key={ev.id} className="flex gap-3">
                        <div className="mt-1"><Clock className="h-4 w-4 text-muted-foreground" /></div>
                        <div>
                          <p className="text-sm text-foreground">{ev.description}</p>
                          <p className="text-xs text-muted-foreground">{new Date(ev.created_at).toLocaleString()}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-destructive/30">
              <CardHeader><CardTitle className="text-destructive">Danger zone</CardTitle></CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-3">
                  Permanently delete this application and its timeline, links, generated documents, and all application-tied document files from your Document Vault.
                </p>
                <Button variant="destructive" size="sm" onClick={() => setDeleteDialog({ kind: "application" })}>
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete application
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
