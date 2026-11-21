import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Bell,
  Check,
  CircleAlert,
  Download,
  HardDriveDownload,
  LoaderCircle,
  MonitorUp,
  ShieldCheck,
  Sparkles,
  Volume2,
} from "lucide-react";
import { invokeDesktop, type FocusMiniPositionMode, type FocusMiniSettings } from "./focus-session-client";
import { PosterMark } from "./ui/poster";
import {
  ProfileApiError,
  defaultUserProfileDraft,
  draftFromProfile,
  loadUserProfile,
  saveUserProfile,
  type UserProfile,
  type UserProfileDraft,
} from "./user-profile-client";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";


type SettingsWorkspaceProps = {
  onProfileSaved?: (profile: UserProfile) => void;
};

export function SettingsWorkspace({ onProfileSaved }: SettingsWorkspaceProps) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [draft, setDraft] = useState<UserProfileDraft>(defaultUserProfileDraft);
  const [desktopSettings, setDesktopSettings] = useState<FocusMiniSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const desktopRuntime = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const memoMode = !draft.desktopFocusEnabled && !draft.feishuTaskCardsEnabled;
  const dirty = useMemo(() => profile ? JSON.stringify(draft) !== JSON.stringify(draftFromProfile(profile)) : false, [draft, profile]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const profileRequest = loadUserProfile(controller.signal);
    const desktopRequest = desktopRuntime
      ? invokeDesktop<FocusMiniSettings>("focus_mini_settings").catch(() => null)
      : Promise.resolve(null);
    void Promise.all([profileRequest, desktopRequest])
      .then(([loadedProfile, loadedDesktopSettings]) => {
        setProfile(loadedProfile);
        setDraft(draftFromProfile(loadedProfile));
        setDesktopSettings(loadedDesktopSettings);
        onProfileSaved?.(loadedProfile);
      })
      .catch((loadError) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError("无法读取设置。请确认本地服务正在运行。");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [desktopRuntime, onProfileSaved]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await saveUserProfile(profile, draft);
      setProfile(updated);
      setDraft(draftFromProfile(updated));
      onProfileSaved?.(updated);
    } catch (requestError) {
      setError(requestError instanceof ProfileApiError && requestError.body.error === "user_profile_version_conflict"
        ? "设置已在另一处更新。当前草稿仍保留，请刷新后重新确认。"
        : "设置没有保存，请稍后重试。当前草稿仍保留。");
    } finally {
      setSaving(false);
    }
  }

  async function updateDesktopBoolean(command: string, enabled: boolean, kind?: "start" | "phase" | "complete") {
    try {
      const updated = await invokeDesktop<FocusMiniSettings>(command, { enabled, ...(kind ? { kind } : {}) });
      setDesktopSettings(updated);
    } catch {
      setError("本机窗口设置没有保存，请重新打开软件后重试。");
    }
  }

  async function updatePositionMode(positionMode: FocusMiniPositionMode) {
    try {
      const updated = await invokeDesktop<FocusMiniSettings>("focus_mini_set_position_mode", { positionMode });
      setDesktopSettings(updated);
    } catch {
      setError("默认窗口位置没有保存，请重试。");
    }
  }

  if (loading) {
    return <section className="settings-workspace settings-loading"><LoaderCircle className="spin" /><span>正在展开个性化设置</span></section>;
  }

  return <section className="settings-workspace">
    <header className="settings-heading poster-header"><PosterMark word="设置" />
      <div>
        <h1>让工具顺着你的习惯安静下来。</h1>
        <p>专注窗口、提醒、声音和数据都在这里；任何计划变更仍需你确认。</p>
      </div>
    </header>

    <form className="settings-form" onSubmit={save}>
      {error && <p className="user-profile-error" role="alert"><CircleAlert />{error}</p>}

      <div className="settings-columns">
        <section className="settings-section">
          <header><div><h2>桌面专注伴随</h2></div><MonitorUp /></header>
          <div className="settings-toggle-list">
            <SettingToggle label="启用桌面专注" help="关闭后，不再弹出准备、计时或评价窗口。" checked={draft.desktopFocusEnabled} onChange={(checked) => setDraft((current) => ({ ...current, desktopFocusEnabled: checked }))} />
            <SettingToggle label="提前一分钟准备窗" help="在固定开始前一分钟出现，并等待明确的开始确认。" checked={draft.focusPreparationWindowEnabled} disabled={!draft.desktopFocusEnabled} onChange={(checked) => setDraft((current) => ({ ...current, focusPreparationWindowEnabled: checked }))} />
            <SettingToggle label="专注计时窗" help="真正开始后创建新的独立窗口；关闭窗口只会隐藏，计时仍继续。" checked={draft.focusTimerWindowEnabled} disabled={!draft.desktopFocusEnabled} onChange={(checked) => setDraft((current) => ({ ...current, focusTimerWindowEnabled: checked }))} />
            <SettingToggle label="任务结束评价" help="关闭后不自动弹出评价窗；专注时长照常记录，任务保留待评价，不会自动判定完成。" checked={draft.focusEvaluationEnabled} disabled={!draft.desktopFocusEnabled} onChange={(checked) => setDraft((current) => ({ ...current, focusEvaluationEnabled: checked }))} />
          </div>
          {desktopRuntime && desktopSettings ? <div className="desktop-position-settings">
            <span>默认弹出位置</span>
            <div role="group" aria-label="专注窗口默认位置">
              {(["bottom_right", "center", "custom"] as const).map((mode) => <button
                type="button"
                aria-pressed={desktopSettings.positionMode === mode}
                onClick={() => void updatePositionMode(mode)}
                key={mode}
              >{mode === "bottom_right" ? "右下角" : mode === "center" ? "屏幕中央" : "自定义"}</button>)}
            </div>
            <SettingToggle label="始终置顶" help="像 Windows 计时器一样留在其他窗口上方。" checked={desktopSettings.alwaysOnTop} onChange={(checked) => void updateDesktopBoolean("focus_mini_set_always_on_top", checked)} />
            <SettingToggle label="锁定自定义位置" help="自定义位置下避免误拖动。" checked={desktopSettings.locked} onChange={(checked) => void updateDesktopBoolean("focus_mini_set_locked", checked)} />
          </div> : <p className="settings-runtime-note">窗口位置与置顶选项会在桌面版中显示。</p>}
        </section>

        <section className="settings-section">
          <header><div><h2>提醒与开始确认</h2></div><Bell /></header>
          <div className="settings-toggle-list">
            <SettingToggle label="启用飞书任务卡片" help="保留另有安排、取消任务与 T-1 开始确认。" checked={draft.feishuTaskCardsEnabled} onChange={(checked) => setDraft((current) => ({ ...current, feishuTaskCardsEnabled: checked }))} />
            <SettingToggle label="提前十五分钟提醒" help="只关闭较早提醒；T-1 开始确认仍随任务卡片保留。" checked={draft.feishuT15Enabled} disabled={!draft.feishuTaskCardsEnabled} onChange={(checked) => setDraft((current) => ({ ...current, feishuT15Enabled: checked }))} />
          </div>
          {memoMode && <p className="settings-memo-mode"><CircleAlert />当前为备忘录模式：不创建专注会话、不记录专注时长，也不收集完成反馈。</p>}
        </section>
      </div>

      <div className="settings-columns">
        <section className="settings-section">
          <header><div><h2>可选功能</h2></div><Sparkles /></header>
          <SettingToggle label="显示健康参考页面" help="关闭只隐藏入口与展示，已有健康资料不会删除。" checked={draft.healthPageEnabled} onChange={(checked) => setDraft((current) => ({ ...current, healthPageEnabled: checked }))} />
        </section>

        <section className="settings-section">
          <header><div><h2>带走自己的记录</h2></div><HardDriveDownload /></header>
          <p className="settings-section-copy">导出本机保存的任务、专注、复盘、健康参考与设置，生成一个 JSON 文件。</p>
          <a className="settings-download" href={`${apiBaseUrl}/api/v1/backups/export`} download><Download />导出全部数据</a>
        </section>
      </div>

      <section className="settings-section profile-settings-section">
        <header><div><h2>日常规则</h2></div><ShieldCheck /></header>
        <div className="profile-inline-settings">
          <label><span>回收站保留时间</span><select aria-label="回收站保留时间" value={draft.recycleRetentionDays} onChange={(event) => setDraft((current) => ({ ...current, recycleRetentionDays: Number(event.target.value) }))}><option value={1}>1 天</option><option value={3}>3 天</option><option value={7}>7 天</option><option value={14}>14 天</option><option value={30}>30 天</option></select></label>
        </div>
        <fieldset className="settings-radio-group">
          <legend>未排期任务的日终处理</legend>
          <label><input type="radio" name="unscheduled-policy" checked={draft.unscheduledTaskPolicy === "carry_forward"} onChange={() => setDraft((current) => ({ ...current, unscheduledTaskPolicy: "carry_forward" }))} />顺移到下一天</label>
          <label><input type="radio" name="unscheduled-policy" checked={draft.unscheduledTaskPolicy === "delete_at_day_end"} onChange={() => setDraft((current) => ({ ...current, unscheduledTaskPolicy: "delete_at_day_end" }))} />当天结束后进入回收站</label>
        </fieldset>
      </section>

      <section className="settings-section sound-settings-section">
        <header><div><h2>每一种提示都可以单独关闭</h2></div><Volume2 /></header>
        <div className="sound-preference-grid">
          {([
            ["flip", "整分钟提示", "计时每过一分钟轻响一声"],
            ["focusStart", "专注开始", "第一段或下一段专注真正开始"],
            ["breakStart", "休息开始", "从专注切换到休息"],
            ["breakEnd", "休息结束", "准备回到下一段"],
            ["focusEnd", "任务结束", "整个结构到达固定结束时间"],
          ] as const).map(([key, label, help]) => <SettingToggle
            key={key}
            label={label}
            help={help}
            checked={draft.focusSounds[key]}
            onChange={(checked) => setDraft((current) => ({ ...current, focusSounds: { ...current.focusSounds, [key]: checked } }))}
          />)}
        </div>
        {desktopRuntime && desktopSettings ? <div className="sound-preference-grid windows-notifications">
          <SettingToggle label="Windows：专注开始" help="只在真正开始计时时通知。" checked={desktopSettings.notifyStart} onChange={(checked) => void updateDesktopBoolean("focus_mini_set_notification", checked, "start")} />
          <SettingToggle label="Windows：阶段切换" help="进入休息或下一段专注时通知。" checked={desktopSettings.notifyPhaseChange} onChange={(checked) => void updateDesktopBoolean("focus_mini_set_notification", checked, "phase")} />
          <SettingToggle label="Windows：任务完成" help="到达固定结束时间时通知。" checked={desktopSettings.notifyComplete} onChange={(checked) => void updateDesktopBoolean("focus_mini_set_notification", checked, "complete")} />
        </div> : null}
      </section>

      <footer className="settings-save-bar">
        <span role="status">{dirty ? "有未保存更改" : ""}</span>
        <button className="primary-button" type="submit" disabled={saving || !profile}>{saving ? <LoaderCircle className="spin" /> : <Check />}{saving ? "正在保存" : "保存设置"}</button>
      </footer>
    </form>
  </section>;
}

function SettingToggle({ label, help, checked, disabled = false, onChange }: {
  label: string;
  help: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return <label className={`settings-toggle ${disabled ? "disabled" : ""}`}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    <span><strong>{label}</strong><small>{help}</small></span>
    <i aria-hidden="true" />
  </label>;
}
