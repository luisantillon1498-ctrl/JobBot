import { useEffect, useState, useRef } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Upload, FileText, Trash2, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { sanitizeStorageFileName } from "@/lib/utils";
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

const PG_INT_MAX = 2147483647;

interface Doc {
  id: string;
  name: string;
  type: string;
  file_path: string;
  file_size: number | null;
  version: number;
  created_at: string;
}

const SECTIONS = [
  { key: "resume", label: "Resumes", accept: ".pdf,.doc,.docx,.txt" },
  { key: "cover_letter_template", label: "Cover Letters", accept: ".pdf,.doc,.docx,.txt" },
  { key: "other", label: "Other Documents", accept: ".pdf,.doc,.docx,.txt,.png,.jpg,.jpeg" },
] as const;

function DocumentSection({
  section,
  docs,
  user,
  onRefresh,
}: {
  section: (typeof SECTIONS)[number];
  docs: Doc[];
  user: { id: string } | null;
  onRefresh: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [docPendingDelete, setDocPendingDelete] = useState<Doc | null>(null);
  const [removing, setRemoving] = useState(false);

  const handleUpload = async () => {
    if (!user || !fileRef.current?.files?.length) return;
    const files = Array.from(fileRef.current.files);
    setUploading(true);

    let successCount = 0;
    for (const file of files) {
      const safeSegment = sanitizeStorageFileName(file.name);
      const filePath = `${user.id}/${Date.now()}_${safeSegment}`;
      const { error: uploadError } = await supabase.storage.from("documents").upload(filePath, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
      if (uploadError) {
        console.error("Storage upload:", uploadError);
        toast.error(uploadError.message || `Upload failed: ${file.name}`);
        continue;
      }

      const size =
        file.size > PG_INT_MAX ? null : Number.isFinite(file.size) ? Math.floor(file.size) : null;

      const { data: inserted, error } = await supabase
        .from("documents")
        .insert({
          user_id: user.id,
          name: file.name,
          type: section.key,
          file_path: filePath,
          file_size: size,
        })
        .select("id")
        .single();
      if (error || !inserted) {
        console.error("documents insert:", error);
        await supabase.storage.from("documents").remove([filePath]);
        toast.error(error?.message || `Failed to save: ${file.name}`);
        continue;
      }
      successCount++;
    }

    setUploading(false);
    if (successCount > 0) {
      toast.success(`${successCount} document${successCount > 1 ? "s" : ""} uploaded`);
      onRefresh();
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const handleDownload = async (doc: Doc) => {
    const { data, error } = await supabase.storage
      .from("documents")
      .createSignedUrl(doc.file_path, 3600);
    if (error || !data?.signedUrl) {
      toast.error("Could not generate download link.");
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  };

  const confirmDelete = async () => {
    if (!docPendingDelete) return;
    setRemoving(true);
    try {
      const { error: dbErr } = await supabase.from("documents").delete().eq("id", docPendingDelete.id);
      if (dbErr) {
        toast.error(dbErr.message || "Could not delete document");
        return;
      }
      const { error: stErr } = await supabase.storage.from("documents").remove([docPendingDelete.file_path]);
      if (stErr) console.warn("Storage delete after DB row removed:", stErr);
      toast.success("Document deleted");
      onRefresh();
    } finally {
      setRemoving(false);
      setDocPendingDelete(null);
    }
  };

  return (
    <Card>
      <AlertDialog open={docPendingDelete !== null} onOpenChange={(open) => !open && !removing && setDocPendingDelete(null)}>
        {docPendingDelete ? (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this document?</AlertDialogTitle>
              <AlertDialogDescription>
                {`"${docPendingDelete.name}" will be removed from your vault and unlinked from any applications. This cannot be undone.`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={removing}
                onClick={(e) => {
                  e.preventDefault();
                  confirmDelete();
                }}
              >
                {removing ? "Deleting…" : "Delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
      <CardHeader>
        <CardTitle className=”text-lg”>{section.label}</CardTitle>
        {section.key === “resume” && (
          <p className=”text-sm text-muted-foreground font-normal pt-1”>
            Resumes are generated automatically from your Resume Wizard data, tailored to each job. Upload a resume here to attach it manually to a specific application instead.
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-end gap-4">
          <div className="space-y-2 flex-1">
            <Label>Files</Label>
            <Input ref={fileRef} type="file" accept={section.accept} multiple />
          </div>
          <Button onClick={handleUpload} disabled={uploading} size="sm">
            <Upload className="h-4 w-4 mr-2" />{uploading ? "Uploading..." : "Upload"}
          </Button>
        </div>

        {docs.length === 0 ? (
          <div className="text-center py-8">
            <FileText className="h-10 w-10 mx-auto text-muted-foreground/30 mb-2" />
            <p className="text-sm text-muted-foreground">No {section.label.toLowerCase()} yet</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {docs.map((doc) => (
              <div key={doc.id} className="flex items-center justify-between gap-3 py-3">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="font-medium text-sm text-foreground truncate">{doc.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(doc.created_at).toLocaleDateString()}
                      {doc.file_size ? ` · ${(doc.file_size / 1024).toFixed(0)} KB` : ""}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Open document"
                    onClick={() => void handleDownload(doc)}
                  >
                    <ExternalLink className="h-4 w-4 text-muted-foreground" />
                  </Button>
                  <Button variant="ghost" size="icon" title="Delete document" onClick={() => setDocPendingDelete(doc)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function Documents() {
  const { user } = useAuth();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchDocs = async () => {
    if (!user) return;
    const docsRes = await supabase.from("documents").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
    setDocs(docsRes.data || []);
    setLoading(false);
  };

  useEffect(() => {
    fetchDocs();
  }, [user]);

  return (
    <AppLayout>
      <div className="space-y-8 animate-fade-in">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Document Vault</h1>
          <p className="text-muted-foreground mt-1">Upload and manage your resumes, cover letters, and other documents</p>
        </div>

        {loading ? (
          <p className="text-muted-foreground py-8 text-center">Loading...</p>
        ) : (
          <div className="space-y-6">
            {SECTIONS.map((section) => (
              <DocumentSection
                key={section.key}
                section={section}
                docs={docs.filter((d) => d.type === section.key)}
                user={user}
                onRefresh={fetchDocs}
              />
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
