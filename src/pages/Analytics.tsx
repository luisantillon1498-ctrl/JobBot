import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";

const STAGE_COLORS: Record<string, string> = {
  draft: "#94a3b8",
  applied: "#94a3b8",
  not_started: "#94a3b8",
  screening: "#f59e0b",
  first_round_interview: "#f59e0b",
  second_round_interview: "#f59e0b",
  final_round_interview: "#8b5cf6",
};

const OUTCOME_COLORS: Record<string, string> = {
  rejected: "#ef4444",
  withdrew: "#94a3b8",
  offer_accepted: "#22c55e",
  ghosted: "#6b7280",
};

const stageLabels: Record<string, string> = {
  draft: "Not Started",
  applied: "Not Started",
  not_started: "Not Started", screening: "Screening",
  first_round_interview: "1st Round", second_round_interview: "2nd Round",
  final_round_interview: "Final Round",
};

const outcomeLabels: Record<string, string> = {
  rejected: "Rejected", withdrew: "Withdrew", offer_accepted: "Offer Accepted", ghosted: "Ghosted",
};

export default function Analytics() {
  const { user } = useAuth();
  type ApplicationRow = Database["public"]["Tables"]["applications"]["Row"];
  type AnalyticsAppRow = Pick<
    ApplicationRow,
    "submission_status" | "application_status" | "outcome" | "created_at" | "company_name"
  >;
  const [apps, setApps] = useState<AnalyticsAppRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    supabase.from("applications").select("submission_status, application_status, outcome, created_at, company_name").eq("user_id", user.id).then(({ data }) => {
      setApps(data || []);
      setLoading(false);
    });
  }, [user]);

  const stageCounts = apps.reduce((acc, a) => {
    const label = stageLabels[a.application_status] || a.application_status;
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const outcomeCounts = apps.reduce((acc, a) => {
    if (a.outcome) {
      const label = outcomeLabels[a.outcome] || a.outcome;
      acc[label] = (acc[label] || 0) + 1;
    }
    return acc;
  }, {} as Record<string, number>);

  const stagePieData = Object.entries(stageCounts).map(([name, value]) => ({ name, value }));
  const outcomePieData = Object.entries(outcomeCounts).map(([name, value]) => ({ name, value }));

  const monthly = apps.reduce((acc, a) => {
    const month = new Date(a.created_at).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
    acc[month] = (acc[month] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const barData = Object.entries(monthly).map(([month, count]) => ({ month, count }));

  const responseRate = apps.length > 0
    ? Math.round((apps.filter(a => a.submission_status === "submitted").length / apps.length) * 100)
    : 0;

  const offerCount = apps.filter(a => a.outcome === "offer_accepted").length;

  return (
    <AppLayout>
      <div className="space-y-8 animate-fade-in">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Analytics</h1>
          <p className="text-muted-foreground mt-1">Insights into your job search progress</p>
        </div>

        {loading ? (
          <p className="text-muted-foreground text-center py-12">Loading...</p>
        ) : apps.length === 0 ? (
          <Card><CardContent className="py-12 text-center text-muted-foreground">No data yet. Start adding applications to see analytics.</CardContent></Card>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Card>
                <CardContent className="pt-6 text-center">
                  <p className="text-4xl font-bold text-foreground">{apps.length}</p>
                  <p className="text-sm text-muted-foreground mt-1">Total Applications</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6 text-center">
                  <p className="text-4xl font-bold text-primary">{responseRate}%</p>
                  <p className="text-sm text-muted-foreground mt-1">Response Rate</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6 text-center">
                  <p className="text-4xl font-bold text-success">{offerCount}</p>
                  <p className="text-sm text-muted-foreground mt-1">Offers Accepted</p>
                </CardContent>
              </Card>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card>
                <CardHeader><CardTitle>Applications by Stage</CardTitle></CardHeader>
                <CardContent>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={stagePieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={({ name, value }) => `${name}: ${value}`}>
                          {stagePieData.map((entry) => (
                            <Cell key={entry.name} fill={STAGE_COLORS[Object.keys(stageLabels).find(k => stageLabels[k] === entry.name) || ""] || "#94a3b8"} />
                          ))}
                        </Pie>
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle>Outcomes</CardTitle></CardHeader>
                <CardContent>
                  <div className="h-64">
                    {outcomePieData.length === 0 ? (
                      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">No outcomes recorded yet</div>
                    ) : (
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie data={outcomePieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={({ name, value }) => `${name}: ${value}`}>
                            {outcomePieData.map((entry) => (
                              <Cell key={entry.name} fill={OUTCOME_COLORS[Object.keys(outcomeLabels).find(k => outcomeLabels[k] === entry.name) || ""] || "#94a3b8"} />
                            ))}
                          </Pie>
                          <Tooltip />
                        </PieChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card className="lg:col-span-2">
                <CardHeader><CardTitle>Applications Over Time</CardTitle></CardHeader>
                <CardContent>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={barData}>
                        <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                        <YAxis tick={{ fontSize: 12 }} />
                        <Tooltip />
                        <Bar dataKey="count" fill="hsl(217, 91%, 60%)" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </div>
    </AppLayout>
  );
}
