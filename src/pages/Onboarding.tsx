import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Bot } from "lucide-react";
import { toast } from "sonner";
import { nameFromUserMetadata } from "@/lib/userDisplayName";

export default function Onboarding() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    setFullName((prev) => (prev.trim() ? prev : nameFromUserMetadata(user)));
  }, [user]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    const payload = {
      full_name: fullName.trim(),
      phone: phone.trim() || null,
      linkedin_url: linkedinUrl.trim() || null,
      onboarded: true as const,
      updated_at: new Date().toISOString(),
    };
    const insertRow = { user_id: user.id, ...payload };
    setSaving(true);
    try {
      const { error: upsertErr } = await supabase.from("profiles").upsert(insertRow, { onConflict: "user_id" });
      if (!upsertErr) {
        navigate("/dashboard");
        return;
      }

      const { data: updated, error: updateErr } = await supabase
        .from("profiles")
        .update(payload)
        .eq("user_id", user.id)
        .select("id");
      if (!updateErr && updated?.length) {
        navigate("/dashboard");
        return;
      }

      const { error: insertErr } = await supabase.from("profiles").insert(insertRow);
      if (!insertErr) {
        navigate("/dashboard");
        return;
      }

      console.error(insertErr ?? updateErr ?? upsertErr);
      toast.error("Failed to save profile");
    } catch (err) {
      console.error(err);
      toast.error("Failed to save profile");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md animate-fade-in">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
              <Bot className="h-7 w-7 text-primary" />
            </div>
          </div>
          <CardTitle className="text-2xl">Complete your profile</CardTitle>
          <CardDescription>Tell us a bit about yourself to get started</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Full Name</Label>
              <Input id="name" value={fullName} onChange={e => setFullName(e.target.value)} placeholder="John Doe" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+1 (555) 000-0000" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="linkedin">LinkedIn URL</Label>
              <Input id="linkedin" type="url" value={linkedinUrl} onChange={e => setLinkedinUrl(e.target.value)} placeholder="https://linkedin.com/in/yourname" />
            </div>
            <Button type="submit" className="w-full" disabled={saving}>
              {saving ? "Saving..." : "Get Started"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
