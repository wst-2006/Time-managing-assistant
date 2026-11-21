import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { BarChart3, CalendarDays, HardDriveDownload, HeartPulse, Map, Settings2, Sparkles, Target, X } from "lucide-react";
import { motion } from "motion/react";
import { FocusWorkspace } from "./FocusWorkspace";
import { GrowthWorkspace } from "./GrowthWorkspace";
import { HealthWorkspace } from "./HealthWorkspace";
import { LongRangePlansWorkspace } from "./LongRangePlansWorkspace";
import { ReviewWorkspace } from "./ReviewWorkspace";
import { SettingsWorkspace } from "./SettingsWorkspace";
import { LaunchSplash } from "./LaunchSplash";
import { TodayWorkspace, type TaskEditRequest } from "./TodayWorkspace";
import { loadUserProfile, type UserProfile } from "./user-profile-client";
import { Cursor, Hatch, Rolling, Sparkle } from "./ui/poster";
import { Component, type ErrorInfo, type ReactNode } from "react";

type View = "today" | "focus" | "review" | "growth" | "health" | "plans" | "settings";
class WorkspaceErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the visible shell recoverable while retaining a local diagnostic for
    // malformed legacy records or a future rendering regression.
    console.error("[workspace-render-error]", error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return <section className="workspace-render-error" role="alert"><strong>这一页暂时无法显示</strong><p>任务数据没有被删除。可以先回到今日页，或重新打开这一页。</p><div><button type="button" onClick={() => this.setState({ hasError: false })}>重试</button><button type="button" onClick={() => window.location.reload()}>重新加载软件</button></div></section>;
  }
}
type DesktopCommand = { id: string; kind: "open_task"; taskId: string; expiresAt: string };
type ViewDirection = "forward" | "backward";
const PAPER_CHANGE_DURATION_MS = 920;
type WorkspaceLayer = {
  view: View;
  role: "current" | "primed" | "priming-outgoing" | "incoming" | "outgoing";
  direction: ViewDirection | null;
  transitionId: number;
  scrollOffset: number;
};

class ApiError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
type Space = "now" | "time" | "echo";
const navItems: Array<{ id: View; label: string; en: string; space: Space; icon: typeof CalendarDays }> = [
  { id: "today", label: "今日", en: "TODAY", space: "now", icon: CalendarDays },
  { id: "focus", label: "专注", en: "FOCUS", space: "now", icon: Target },
  { id: "plans", label: "规划", en: "PLANS", space: "time", icon: Map },
  { id: "health", label: "健康", en: "BODY", space: "time", icon: HeartPulse },
  { id: "review", label: "复盘", en: "REVIEW", space: "echo", icon: Sparkles },
  { id: "growth", label: "成长", en: "GROWTH", space: "echo", icon: BarChart3 },
];
/** Three groups of pages, named plainly: doing today's work, planning ahead, looking back. */
const spaces: Array<{ id: Space; label: string; en: string }> = [
  { id: "now", label: "执行", en: "DO" },
  { id: "time", label: "计划", en: "PLAN" },
  { id: "echo", label: "回顾", en: "LOOK BACK" },
];
const viewOrder: View[] = [...navItems.map((item) => item.id), "settings"];
const viewLabel = (view: View) => view === "settings" ? "设置" : navItems.find((item) => item.id === view)?.label ?? "今日";
const viewSpace = (view: View): Space | null => navItems.find((item) => item.id === view)?.space ?? null;

function isDesktopRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function desktopCommandClientId() {
  const storageKey = "personal-ai.desktop-command-client-id";
  const existing = window.localStorage.getItem(storageKey);
  if (existing) return existing;
  const created = `desktop-${crypto.randomUUID()}`;
  window.localStorage.setItem(storageKey, created);
  return created;
}

function clockNow() {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
}

function useClockLabel() {
  const [label, setLabel] = useState(clockNow);
  useEffect(() => {
    const timer = window.setInterval(() => setLabel(clockNow()), 5_000);
    return () => window.clearInterval(timer);
  }, []);
  return label;
}

function shanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function displayDate() {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", weekday: "long", month: "long", day: "numeric" }).format(new Date());
}

async function requestJson<T>(path: string, method: string, payload?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: payload ? { "content-type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status);
  return body as T;
}

export function App() {
  const [view, setView] = useState<View>("today");
  const [workspaceLayers, setWorkspaceLayers] = useState<WorkspaceLayer[]>([
    { view: "today", role: "current", direction: null, transitionId: 0, scrollOffset: 0 },
  ]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [todayRefreshToken, setTodayRefreshToken] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [taskEditRequest, setTaskEditRequest] = useState<TaskEditRequest | null>(null);
  const [pendingDesktopCommand, setPendingDesktopCommand] = useState<DesktopCommand | null>(null);
  const [desktopTaskReadyId, setDesktopTaskReadyId] = useState<string | null>(null);
  const desktopCommandInFlight = useRef(false);
  const activeViewRef = useRef<View>("today");
  const viewNavigationRequestRef = useRef(0);
  const viewTransitionTimerRef = useRef<number | null>(null);
  const viewTransitionFrameRef = useRef<number | null>(null);
  const viewTransitionStartFrameRef = useRef<number | null>(null);
  const visibleNavItems = useMemo(() => navItems.filter((item) => item.id !== "health" || userProfile?.healthPageEnabled !== false), [userProfile?.healthPageEnabled]);
  const activeSpace = viewSpace(view);
  const clock = useClockLabel();

  const navigateToView = useCallback((nextView: View) => {
    const currentView = activeViewRef.current;
    if (nextView === currentView) return;

    const requestId = ++viewNavigationRequestRef.current;
    if (viewTransitionTimerRef.current !== null) window.clearTimeout(viewTransitionTimerRef.current);
    if (viewTransitionFrameRef.current !== null) window.cancelAnimationFrame(viewTransitionFrameRef.current);
    if (viewTransitionStartFrameRef.current !== null) window.cancelAnimationFrame(viewTransitionStartFrameRef.current);

    const currentIndex = Math.max(0, viewOrder.indexOf(currentView));
    const nextIndex = Math.max(0, viewOrder.indexOf(nextView));
    const direction: ViewDirection = nextIndex > currentIndex ? "forward" : "backward";
    const scrollOffset = window.scrollY;
    document.documentElement.dataset.viewDirection = direction;
    activeViewRef.current = nextView;
    setView(nextView);
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setWorkspaceLayers([{ view: nextView, role: "current", direction: null, transitionId: requestId, scrollOffset: 0 }]);
      return;
    }

    setWorkspaceLayers((current) => {
      const outgoing = current.find((layer) => layer.view === currentView);
      const incoming = current.find((layer) => layer.view === nextView);
      return [
        {
          view: currentView,
          role: "priming-outgoing",
          direction,
          transitionId: requestId,
          scrollOffset: outgoing?.role === "current" ? scrollOffset : outgoing?.scrollOffset ?? scrollOffset,
        },
        {
          view: nextView,
          role: "primed",
          direction,
          transitionId: requestId,
          scrollOffset: incoming?.role === "current" ? incoming.scrollOffset : 0,
        },
      ];
    });

    // First mount the next workspace invisibly under the current one. The
    // second frame starts the cross-fade, so both DOM trees exist before the
    // outgoing page begins to leave.
    viewTransitionFrameRef.current = window.requestAnimationFrame(() => {
      viewTransitionStartFrameRef.current = window.requestAnimationFrame(() => {
        if (requestId !== viewNavigationRequestRef.current) return;
        setWorkspaceLayers((current) => current.map((layer) => ({
          ...layer,
          role: layer.view === currentView ? "outgoing" : "incoming",
        })));
        viewTransitionFrameRef.current = null;
        viewTransitionStartFrameRef.current = null;
        viewTransitionTimerRef.current = window.setTimeout(() => {
          if (requestId !== viewNavigationRequestRef.current) return;
          setWorkspaceLayers([{ view: nextView, role: "current", direction: null, transitionId: requestId, scrollOffset: 0 }]);
          viewTransitionTimerRef.current = null;
        }, PAPER_CHANGE_DURATION_MS);
      });
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadUserProfile(controller.signal).then(setUserProfile).catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (userProfile?.healthPageEnabled === false && view === "health") navigateToView("today");
  }, [navigateToView, userProfile?.healthPageEnabled, view]);

  const handleProfileSaved = useCallback((profile: UserProfile) => {
    setUserProfile(profile);
  }, []);

  useEffect(() => () => {
    viewNavigationRequestRef.current += 1;
    if (viewTransitionTimerRef.current !== null) window.clearTimeout(viewTransitionTimerRef.current);
    if (viewTransitionFrameRef.current !== null) window.cancelAnimationFrame(viewTransitionFrameRef.current);
    if (viewTransitionStartFrameRef.current !== null) window.cancelAnimationFrame(viewTransitionStartFrameRef.current);
  }, []);

  useEffect(() => {
    const reflectVisibility = () => {
      document.documentElement.dataset.documentHidden = document.hidden ? "true" : "false";
    };
    reflectVisibility();
    document.addEventListener("visibilitychange", reflectVisibility);
    return () => {
      document.removeEventListener("visibilitychange", reflectVisibility);
      delete document.documentElement.dataset.documentHidden;
    };
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime() || pendingDesktopCommand) return;
    const clientId = desktopCommandClientId();
    let stopped = false;

    async function pollDesktopCommand() {
      if (stopped || desktopCommandInFlight.current) return;
      desktopCommandInFlight.current = true;
      try {
        const result = await requestJson<{ command: DesktopCommand | null }>(`/api/v1/desktop-commands/pending?clientId=${encodeURIComponent(clientId)}`, "GET");
        if (!result.command || stopped) return;
        setDesktopTaskReadyId(null);
        setPendingDesktopCommand(result.command);
        setSelectedTaskId(result.command.taskId);
        navigateToView("focus");
      } catch {
        // The desktop API may still be starting. The next bounded poll retries
        // without turning a transient integration issue into a blocking banner.
      } finally {
        desktopCommandInFlight.current = false;
      }
    }

    void pollDesktopCommand();
    const timer = window.setInterval(() => void pollDesktopCommand(), 1_500);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [navigateToView, pendingDesktopCommand]);

  useEffect(() => {
    if (!isDesktopRuntime() || !pendingDesktopCommand || desktopTaskReadyId !== pendingDesktopCommand.taskId) return;
    const command = pendingDesktopCommand;
    const clientId = desktopCommandClientId();
    let stopped = false;
    let retryTimer: number | undefined;

    async function completeWhenReady() {
      if (stopped) return;
      if (Date.now() >= new Date(command.expiresAt).getTime()) {
        setPendingDesktopCommand(null);
        setDesktopTaskReadyId(null);
        return;
      }
      try {
        await requestJson(`/api/v1/desktop-commands/${command.id}/complete`, "POST", { clientId });
        if (!stopped) {
          setPendingDesktopCommand(null);
          setDesktopTaskReadyId(null);
        }
      } catch {
        if (!stopped) retryTimer = window.setTimeout(() => void completeWhenReady(), 1_500);
      }
    }

    void completeWhenReady();
    return () => {
      stopped = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [desktopTaskReadyId, pendingDesktopCommand]);

  const handleDesktopTaskReady = useCallback((taskId: string) => {
    setDesktopTaskReadyId(taskId);
  }, []);

  /** After "另有安排" in focus, go back to the timeline with that task's edit form open. */
  function openTaskForRescheduling(task: { id: string; title: string }) {
    setSelectedTaskId(null);
    setTaskEditRequest({ requestId: crypto.randomUUID(), taskId: task.id });
    navigateToView("today");
    setTodayRefreshToken((value) => value + 1);
  }

  function renderWorkspace(layerView: View, layerRole: WorkspaceLayer["role"]) {
    if (layerView === "today") return <TodayWorkspace
      refreshToken={todayRefreshToken}
      taskEditRequest={taskEditRequest}
      onTaskEditRequestConsumed={() => setTaskEditRequest(null)}
      onOpenHealth={() => navigateToView("health")}
      onFocus={(id) => { setSelectedTaskId(id); navigateToView("focus"); }}
    />;
    if (layerView === "focus") return <FocusWorkspace isWorkspaceCurrent={layerRole === "current"} preferredTaskId={selectedTaskId} onBack={() => navigateToView("today")} onPlanChange={openTaskForRescheduling} onPreferredTaskReady={handleDesktopTaskReady} />;
    if (layerView === "review") return <ReviewWorkspace isWorkspaceCurrent={layerRole === "current"} onOpenGrowth={() => navigateToView("growth")} />;
    if (layerView === "growth") return <GrowthWorkspace />;
    if (layerView === "plans") return <LongRangePlansWorkspace />;
    if (layerView === "health") return <HealthWorkspace />;
    return <SettingsWorkspace onProfileSaved={handleProfileSaved} />;
  }

  const navButton = ({ id, label, en }: (typeof navItems)[number]) => <button className={`rail-button ${view === id ? "active" : ""}`} type="button" key={id} aria-label={label} aria-current={view === id ? "page" : undefined} onClick={() => { if (id === "focus" && view !== "focus") setSelectedTaskId(null); navigateToView(id); }}>
    {view === id && <motion.span layoutId="rail-ink" className="rail-ink" transition={{ type: "spring", stiffness: 420, damping: 34 }} aria-hidden="true" />}
    <span className="rail-zh">{label}</span><span className="rail-en" aria-hidden="true">{en}</span>
  </button>;
  const changingTo = workspaceLayers.length > 1 ? workspaceLayers.find((layer) => layer.view === view) : undefined;

  return <main className="app-shell" data-space={activeSpace ?? "settings"}>
    <LaunchSplash />
    <Cursor />
    <header className="masthead">
      <button className="brand-mark" type="button" aria-label="回到今日" onClick={() => navigateToView("today")}><span aria-hidden="true">序</span><b aria-hidden="true">PLANNER</b></button>
      <nav className="space-nav" aria-label="页面分组">{spaces.map((space) => {
        const first = visibleNavItems.find((item) => item.space === space.id);
        return <button key={space.id} type="button" className={activeSpace === space.id ? "active" : ""} aria-label={`${space.label}分组`} aria-current={activeSpace === space.id ? "true" : undefined} disabled={!first} onClick={() => first && navigateToView(activeSpace === space.id ? view : first.id)}>
          {activeSpace === space.id && <motion.span layoutId="space-ink" className="space-ink" transition={{ type: "spring", stiffness: 380, damping: 32 }} aria-hidden="true" />}
          <span>{space.label}</span>
        </button>;
      })}</nav>
      <div className="masthead-actions">
        {import.meta.env.VITE_TMA_TARGET === "mobile" ? null : <a className="quiet-icon backup-trigger" href={`${apiBaseUrl}/api/v1/backups/export`} download aria-label="备份所有数据" title="备份所有数据"><HardDriveDownload /></a>}
        <button className={`rail-settings-button mobile-settings-shortcut ${view === "settings" ? "active" : ""}`} type="button" aria-label="设置" title="设置" aria-current={view === "settings" ? "page" : undefined} onClick={() => navigateToView("settings")}><Settings2 /></button>
        <span className="masthead-clock" aria-label={`现在 ${clock}`}><Rolling value={clock} /></span>
      </div>
    </header>
    <nav className="app-rail" aria-label="主要导航">
      {spaces.map((space, index) => <div className="rail-group" key={space.id} data-space={space.id} data-active={activeSpace === space.id ? "true" : undefined}>
        {index > 0 && <Hatch className="rail-hatch" />}
        <span className="rail-space" aria-hidden="true"><Sparkle size={11} />{space.en}</span>
        {visibleNavItems.filter((item) => item.space === space.id).map(navButton)}
      </div>)}
      <span className="rail-date" aria-hidden="true">{displayDate()}</span>
    </nav>
    <section className="app-canvas">
      {error && <div className="error-banner" role="alert"><X />{error}<button type="button" aria-label="关闭错误提示" onClick={() => setError(null)}><X /></button></div>}
      <div className={`view-transition-stage ${workspaceLayers.length > 1 ? "changing-sheet" : ""}`} data-view={view} aria-live="polite">
        {workspaceLayers.map((layer) => {
          const layerIsInteractive = layer.role === "current";
          const inertAttributes = layerIsInteractive ? {} : ({ inert: "" } as Record<string, string>);
          return <div
            {...inertAttributes}
            className={`workspace-layer ${layer.role}`}
            data-layer-view={layer.view}
            data-direction={layer.direction ?? undefined}
            aria-hidden={!layerIsInteractive ? "true" : undefined}
            key={layer.view}
            style={{ "--sheet-scroll-offset": `${layer.scrollOffset}px` } as CSSProperties}
          >
            <WorkspaceErrorBoundary>{renderWorkspace(layer.view, layer.role)}</WorkspaceErrorBoundary>
          </div>;
        })}
        {changingTo && <div className="view-curtain" key={changingTo.transitionId} data-direction={changingTo.direction ?? "forward"} aria-hidden="true">
          <span className="view-curtain-word">{viewLabel(changingTo.view)}</span>
          <span className="view-curtain-meta">{viewSpace(changingTo.view) ? spaces.find((space) => space.id === viewSpace(changingTo.view))?.en : "SETTINGS"} / {navItems.find((item) => item.id === changingTo.view)?.en ?? "SETTINGS"}</span>
        </div>}
      </div>
    </section>
    <nav className="mobile-nav" aria-label="移动端主要导航">{visibleNavItems.map(({ id, label, icon: Icon }) => <button className={view === id ? "active" : ""} type="button" key={id} aria-current={view === id ? "page" : undefined} onClick={() => navigateToView(id)}><Icon /><span>{label}</span></button>)}</nav>
  </main>;
}
