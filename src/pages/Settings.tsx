import { useCallback, useEffect, useState } from "react";
import { format } from "date-fns";
import { useTheme } from "next-themes";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  COVER_LETTER_TONE_LABELS,
  COVER_LETTER_TONES,
  DEFAULT_COVER_LETTER_TONE,
  type CoverLetterTone,
  isCoverLetterTone,
} from "@/lib/coverLetterTone";
import { toast } from "sonner";
import { nameFromUserMetadata } from "@/lib/userDisplayName";
import { invokeDeleteAccount } from "@/lib/invokeDeleteAccount";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const DELETE_ACCOUNT_PHRASE = "DELETE MY ACCOUNT";

export default function Settings() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [coverLetterTone, setCoverLetterTone] = useState<CoverLetterTone>(DEFAULT_COVER_LETTER_TONE);
  const [profileLoading, setProfileLoading] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingTone, setSavingTone] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deletingAccount, setDeletingAccount] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const loadProfile = useCallback(async () => {
    if (!user) return;
    setProfileLoading(true);
    const { data, error } = await supabase
      .from("profiles")
      .select("full_name, phone, linkedin_url, cover_letter_tone")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      console.error(error);
      toast.error("Could not load your profile.");
      setProfileLoading(false);
      return;
    }

    if (data) {
      const profileName = (data.full_name ?? "").trim();
      const hint = nameFromUserMetadata(user);
      setFullName(profileName || hint);
      setPhone(data.phone ?? "");
      setLinkedinUrl(data.linkedin_url ?? "");
      const tone = isCoverLetterTone(data.cover_letter_tone) ? data.cover_letter_tone : DEFAULT_COVER_LETTER_TONE;
      setCoverLetterTone(tone);
    }
    setProfileLoading(false);
  }, [user]);

  const confirmDeleteAccount = async () => {
    if (deleteConfirmText !== DELETE_ACCOUNT_PHRASE) return;
    setDeletingAccount(true);
    try {
      await invokeDeleteAccount();
      toast.success("Your account has been deleted.");
      setDeleteDialogOpen(false);
      setDeleteConfirmText("");
      await signOut();
      navigate("/auth", { replace: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Could not delete account.";
      toast.error(message);
    } finally {
      setDeletingAccount(false);
    }
  };

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setSavingProfile(true);
    const { error } = await supabase
      .from("profiles")
      .update({
        full_name: fullName.trim() || null,
        phone: phone.trim() || null,
        linkedin_url: linkedinUrl.trim() || null,
      })
      .eq("user_id", user.id);

    setSavingProfile(false);
    if (error) {
      console.error(error);
      toast.error(error.message || "Could not save profile.");
      return;
    }
    toast.success("Profile updated.");
    loadProfile();
  };

  const onToneChange = async (value: CoverLetterTone) => {
    setCoverLetterTone(value);
    if (!user) return;
    setSavingTone(true);
    const { error } = await supabase.from("profiles").update({ cover_letter_tone: value }).eq("user_id", user.id);
    setSavingTone(false);
    if (error) {
      console.error(error);
      toast.error(error.message || "Could not save cover letter tone.");
      loadProfile();
      return;
    }
    toast.success("Cover letter tone saved.");
  };

  const sendPasswordReset = async () => {
    const email = user?.email?.trim();
    if (!email) {
      toast.error("No email on file.");
      return;
    }
    setPasswordBusy(true);
    const redirectTo = `${window.location.origin}/auth`;
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    setPasswordBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Check your inbox for a password reset link.");
  };

  const memberSince =
    user?.created_at != null
      ? format(new Date(user.created_at), "MMMM d, yyyy")
      : "—";

  const themeValue = theme ?? "system";

  return (
    <AppLayout>
      <div className="space-y-8 max-w-2xl">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Settings</h1>
          <p className="text-muted-foreground mt-1">Account details and preferences for JobBot.</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
            <CardDescription>How you sign in and how we address you in generated documents.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {profileLoading ? (
              <p className="text-sm text-muted-foreground">Loading profile…</p>
            ) : (
              <>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-muted-foreground">Email</Label>
                    <p className="text-sm font-medium text-foreground">{user?.email ?? "—"}</p>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-muted-foreground">Member since</Label>
                    <p className="text-sm font-medium text-foreground">{memberSince}</p>
                  </div>
                </div>
                <Separator />
                <form onSubmit={saveProfile} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="settings-name">Full name</Label>
                    <Input
                      id="settings-name"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="Your name"
                      autoComplete="name"
                    />
                    <p className="text-xs text-muted-foreground">
                      Used in generated cover letters. If your profile has no name yet, this field is pre-filled from your
                      account (for example the name you entered when you signed up).
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="settings-phone">Phone</Label>
                    <Input
                      id="settings-phone"
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="+1 (555) 000-0000"
                      autoComplete="tel"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="settings-linkedin">LinkedIn</Label>
                    <Input
                      id="settings-linkedin"
                      type="url"
                      value={linkedinUrl}
                      onChange={(e) => setLinkedinUrl(e.target.value)}
                      placeholder="https://linkedin.com/in/…"
                      autoComplete="url"
                    />
                  </div>
                  <Button type="submit" disabled={savingProfile}>
                    {savingProfile ? "Saving…" : "Save profile"}
                  </Button>
                </form>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Appearance</CardTitle>
            <CardDescription>Choose how JobBot looks on this device.</CardDescription>
          </CardHeader>
          <CardContent>
            {!mounted ? (
              <p className="text-sm text-muted-foreground">Loading theme…</p>
            ) : (
              <RadioGroup
                value={themeValue}
                onValueChange={(v) => setTheme(v)}
                className="grid gap-3 sm:grid-cols-3"
              >
                <label
                  htmlFor="theme-light"
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-4 hover:bg-accent/50 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
                >
                  <RadioGroupItem value="light" id="theme-light" className="mt-0.5" />
                  <div>
                    <span className="font-medium text-foreground">Light</span>
                    <p className="text-xs text-muted-foreground mt-0.5">Always use light mode.</p>
                  </div>
                </label>
                <label
                  htmlFor="theme-dark"
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-4 hover:bg-accent/50 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
                >
                  <RadioGroupItem value="dark" id="theme-dark" className="mt-0.5" />
                  <div>
                    <span className="font-medium text-foreground">Dark</span>
                    <p className="text-xs text-muted-foreground mt-0.5">Always use dark mode.</p>
                  </div>
                </label>
                <label
                  htmlFor="theme-system"
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-4 hover:bg-accent/50 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
                >
                  <RadioGroupItem value="system" id="theme-system" className="mt-0.5" />
                  <div>
                    <span className="font-medium text-foreground">System</span>
                    <p className="text-xs text-muted-foreground mt-0.5">Match this device’s light or dark setting.</p>
                  </div>
                </label>
              </RadioGroup>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Writing</CardTitle>
            <CardDescription>Defaults for AI-generated cover letters.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Label htmlFor="cover-tone">Cover letter tone</Label>
            <Select
              value={coverLetterTone}
              onValueChange={(v) => isCoverLetterTone(v) && onToneChange(v)}
              disabled={profileLoading || savingTone}
            >
              <SelectTrigger id="cover-tone" className="max-w-md">
                <SelectValue placeholder="Select a tone" />
              </SelectTrigger>
              <SelectContent>
                {COVER_LETTER_TONES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {COVER_LETTER_TONE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground pt-1">
              Applied the next time you generate a cover letter. Past letters are unchanged.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Notifications</CardTitle>
            <CardDescription>Control optional emails and reminders.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
              <div className="space-y-0.5">
                <Label htmlFor="notify-digest" className="text-base font-medium">
                  Weekly summary email
                </Label>
                <p className="text-sm text-muted-foreground">A recap of applications and upcoming follow-ups.</p>
              </div>
              <Switch id="notify-digest" disabled checked={false} aria-readonly />
            </div>
            <p className="text-xs text-muted-foreground">This option is not wired up yet; it’s here as a placeholder for a future release.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Security</CardTitle>
            <CardDescription>Manage how you access your account.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              We’ll email you a link to choose a new password. Add this site’s URL to your Supabase Auth redirect allow list if
              resets fail.
            </p>
            <Button type="button" variant="outline" onClick={sendPasswordReset} disabled={passwordBusy || !user?.email}>
              {passwordBusy ? "Sending…" : "Send password reset email"}
            </Button>
          </CardContent>
        </Card>

        <Card className="border-destructive/30">
          <CardHeader>
            <CardTitle className="text-destructive">Delete account</CardTitle>
            <CardDescription>
              Permanently delete your account, applications, documents metadata, and stored files. This cannot be undone.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" variant="destructive" onClick={() => setDeleteDialogOpen(true)}>
              Delete my account…
            </Button>
          </CardContent>
        </Card>
      </div>

      <AlertDialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          if (!deletingAccount) {
            setDeleteDialogOpen(open);
            if (!open) setDeleteConfirmText("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete your account permanently?</AlertDialogTitle>
            <AlertDialogDescription className="space-y-3 text-left">
              <span className="block">
                All applications, events, generated content, document records, and files in your vault will be removed. You
                will not be able to recover this data.
              </span>
              <span className="block font-medium text-foreground">
                Type <span className="font-mono">{DELETE_ACCOUNT_PHRASE}</span> to confirm.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-2">
            <Input
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder={DELETE_ACCOUNT_PHRASE}
              autoComplete="off"
              disabled={deletingAccount}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingAccount}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteConfirmText !== DELETE_ACCOUNT_PHRASE || deletingAccount}
              onClick={confirmDeleteAccount}
            >
              {deletingAccount ? "Deleting…" : "Delete account permanently"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
