import { ReactNode, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { LayoutDashboard, FolderOpen, ListOrdered, PlusCircle, BarChart3, LogOut, Bot, Settings, FileText, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";

const navItems = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/documents", label: "Documents", icon: FolderOpen },
  { to: "/applications/new", label: "New Application", icon: PlusCircle },
  { to: "/applications/queue", label: "Application Queue", icon: ListOrdered },
  { to: "/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/resume-wizard", label: "Resume Wizard", icon: FileText },
  { to: "/settings", label: "Settings", icon: Settings },
];

function NavLinks({ onNavClick }: { onNavClick?: () => void }) {
  const location = useLocation();
  return (
    <>
      {navItems.map((item) => {
        const active =
          item.to === "/settings"
            ? location.pathname === "/settings"
            : location.pathname === item.to || location.pathname.startsWith(item.to + "/");
        return (
          <Link
            key={item.to}
            to={item.to}
            onClick={onNavClick}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              active
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            <item.icon className="h-4 w-4 shrink-0" />
            {item.label}
          </Link>
        );
      })}
    </>
  );
}

export function AppLayout({ children }: { children: ReactNode }) {
  const { signOut } = useAuth();
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background flex">
      {/* ── Desktop sidebar (md+) ── */}
      <aside className="hidden md:flex w-64 border-r border-border bg-card flex-col shrink-0 h-screen sticky top-0">
        <div className="p-6 border-b border-border">
          <Link to="/dashboard" className="flex items-center gap-2">
            <Bot className="h-7 w-7 text-primary" />
            <span className="text-xl font-bold text-foreground">JobBot</span>
          </Link>
        </div>
        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          <NavLinks />
        </nav>
        <div className="p-4 border-t border-border">
          <Button variant="ghost" className="w-full justify-start gap-3 text-muted-foreground" onClick={signOut}>
            <LogOut className="h-4 w-4" />
            Sign Out
          </Button>
        </div>
      </aside>

      {/* ── Mobile sheet nav (< md) ── */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="left" className="w-72 p-0 gap-0 flex flex-col">
          <div className="p-6 border-b border-border">
            <Link to="/dashboard" onClick={() => setSheetOpen(false)} className="flex items-center gap-2">
              <Bot className="h-7 w-7 text-primary" />
              <span className="text-xl font-bold text-foreground">JobBot</span>
            </Link>
          </div>
          <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
            <NavLinks onNavClick={() => setSheetOpen(false)} />
          </nav>
          <div className="p-4 border-t border-border">
            <Button variant="ghost" className="w-full justify-start gap-3 text-muted-foreground" onClick={signOut}>
              <LogOut className="h-4 w-4" />
              Sign Out
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Main area ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile top header */}
        <header className="md:hidden flex items-center gap-3 px-4 py-3 border-b border-border bg-card shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground"
            onClick={() => setSheetOpen(true)}
            aria-label="Open navigation menu"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <Link to="/dashboard" className="flex items-center gap-2 flex-1 justify-center">
            <Bot className="h-6 w-6 text-primary" />
            <span className="text-lg font-bold text-foreground">JobBot</span>
          </Link>
          {/* Spacer to keep logo centered */}
          <div className="w-9" />
        </header>

        <main className="flex-1 overflow-auto">
          <div className="max-w-6xl mx-auto px-4 py-4 sm:px-6 sm:py-6 lg:px-8 lg:py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
