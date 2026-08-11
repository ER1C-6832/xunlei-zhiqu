import type { ResourceJobSnapshot } from '@xunlei-zhiqu/contracts';
import {
  Activity,
  Bot,
  ChevronLeft,
  CirclePause,
  Cloud,
  Download,
  FileClock,
  FolderOpen,
  Gamepad2,
  HardDriveDownload,
  Link2,
  ListChecks,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Smartphone,
  Sparkles,
  TriangleAlert,
  X
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';

const API_URL = import.meta.env.VITE_RUNTIME_URL || 'http://127.0.0.1:8765';

type DownloadTab = 'active' | 'completed';
type ToastState = { message: string; tone?: 'normal' | 'warning' } | null;

const fallbackJobs: ResourceJobSnapshot[] = [
  {
    job_id: 'job_zhiqu_001',
    title: 'Example App 5.2.1',
    subtitle: 'Windows x64 便携版 · 中文语言包 · 校验文件',
    kind: 'zhiqu',
    status: 'downloading',
    progress: 68.4,
    downloaded_bytes: 1_842_000_000,
    total_bytes: 2_692_000_000,
    speed_bytes_per_second: 12_600_000,
    eta_seconds: 68,
    stage_label: '正在下载主资源',
    next_action: 'pause',
    source_count: 3,
    excluded_count: 15,
    created_at: new Date(Date.now() - 18 * 60_000).toISOString(),
    destination: 'D:/Downloads/Example App 5.2.1'
  },
  {
    job_id: 'job_zhiqu_002',
    title: 'Open Media Course · 1080p',
    subtitle: '12 个视频 · 中文字幕 · 2 个备用来源',
    kind: 'zhiqu',
    status: 'waiting_for_source',
    progress: 42,
    downloaded_bytes: 3_210_000_000,
    total_bytes: 7_643_000_000,
    speed_bytes_per_second: 0,
    eta_seconds: null,
    stage_label: '来源失效，等待继续获取',
    issue: '主来源返回 503，原页面、候选与 42% 进度均已保留。',
    next_action: 'continue_acquisition',
    source_count: 2,
    excluded_count: 8,
    created_at: new Date(Date.now() - 72 * 60_000).toISOString(),
    destination: 'D:/Downloads/Open Media Course'
  },
  {
    job_id: 'job_normal_001',
    title: 'sample-dataset.zip',
    subtitle: '普通下载 · ZIP 压缩包',
    kind: 'normal',
    status: 'completed',
    progress: 100,
    downloaded_bytes: 482_000_000,
    total_bytes: 482_000_000,
    speed_bytes_per_second: 0,
    eta_seconds: null,
    stage_label: '已完成',
    next_action: 'open',
    source_count: 1,
    excluded_count: 0,
    created_at: new Date(Date.now() - 86_400_000).toISOString(),
    destination: 'D:/Downloads/sample-dataset.zip'
  }
];

const navItems = [
  { label: '下载', icon: Download, enabled: true },
  { label: '云盘', icon: Cloud, enabled: false },
  { label: '播放', icon: Play, enabled: false },
  { label: '链接库', icon: Link2, enabled: false },
  { label: '我的设备', icon: Smartphone, enabled: false },
  { label: '游戏', icon: Gamepad2, enabled: false }
];

export function App() {
  const [jobs, setJobs] = useState<ResourceJobSnapshot[]>(fallbackJobs);
  const [selectedId, setSelectedId] = useState<string>('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [tab, setTab] = useState<DownloadTab>('active');
  const [query, setQuery] = useState('');
  const [runtimeConnected, setRuntimeConnected] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_URL}/v1/jobs`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<ResourceJobSnapshot[]>;
      })
      .then((data) => {
        setJobs(data.length > 0 ? data : fallbackJobs);
        setRuntimeConnected(true);
      })
      .catch(() => setRuntimeConnected(false));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const activeCount = jobs.filter((job) => job.status !== 'completed').length;
  const completedCount = jobs.filter((job) => job.status === 'completed').length;
  const totalSpeed = jobs
    .filter((job) => job.status === 'downloading')
    .reduce((sum, job) => sum + job.speed_bytes_per_second, 0);

  const visibleJobs = useMemo(() => {
    const lowerQuery = query.trim().toLowerCase();
    return jobs.filter((job) => {
      const matchesTab = tab === 'completed' ? job.status === 'completed' : job.status !== 'completed';
      const matchesQuery = !lowerQuery || `${job.title} ${job.subtitle}`.toLowerCase().includes(lowerQuery);
      return matchesTab && matchesQuery;
    });
  }, [jobs, query, tab]);

  const selectedJob = jobs.find((job) => job.job_id === selectedId) ?? null;

  function openJob(job: ResourceJobSnapshot) {
    setSelectedId(job.job_id);
    setDrawerOpen(true);
  }

  function switchTab(nextTab: DownloadTab) {
    setTab(nextTab);
    setDrawerOpen(false);
    setSelectedId('');
  }

  function showDeferred(label: string) {
    setToast({ message: `${label}将在阶段 B3 接入，当前先保持迅雷 17 视觉占位。` });
  }

  function handleJobAction(job: ResourceJobSnapshot) {
    if (job.status === 'downloading') {
      setJobs((current) => current.map((item) => (
        item.job_id === job.job_id
          ? { ...item, status: 'paused', stage_label: '已暂停', next_action: 'resume', speed_bytes_per_second: 0 }
          : item
      )));
      setToast({ message: '已在界面层暂停任务。Runtime 控制会在阶段 E 接入。' });
      return;
    }

    if (job.status === 'paused') {
      setJobs((current) => current.map((item) => (
        item.job_id === job.job_id
          ? { ...item, status: 'downloading', stage_label: '正在下载主资源', next_action: 'pause', speed_bytes_per_second: 8_400_000 }
          : item
      )));
      setToast({ message: '已在界面层恢复任务。' });
      return;
    }

    if (job.status === 'waiting_for_source') {
      setToast({ message: '一键续取入口已保留；阶段 F 再接真实重新智取闭环。', tone: 'warning' });
      return;
    }

    setToast({ message: `交付位置：${job.destination || '尚未设置'}` });
  }

  return (
    <div className="app-frame">
      <aside className="sidebar" aria-label="主导航">
        <div className="brand-row" aria-label="迅雷智取">
          <span className="brand-bird"><Sparkles size={18} /></span>
          <strong>迅雷</strong>
        </div>

        <nav className="primary-nav">
          {navItems.map(({ label, icon: Icon, enabled }, index) => (
            <button
              className={`nav-item ${index === 0 ? 'active' : ''}`}
              type="button"
              key={label}
              onClick={() => enabled ? undefined : showDeferred(label)}
              title={enabled ? label : `${label}（后续阶段）`}
            >
              <Icon size={18} strokeWidth={1.8} />
              <span>{label}</span>
              {index === 0 && activeCount > 0 && <span className="nav-badge">{activeCount}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-spacer" />
        <button className="nav-item secondary" type="button" onClick={() => showDeferred('设置')}>
          <Settings size={18} strokeWidth={1.8} />
          <span>设置</span>
        </button>
        <div className="prototype-mark">
          <Bot size={15} />
          <span>迅雷智取功能原型</span>
        </div>
      </aside>

      <main className="main-shell">
        <header className="topbar">
          <button className="top-icon" type="button" aria-label="后退"><ChevronLeft size={18} /></button>
          <button className="top-icon forward" type="button" aria-label="前进"><ChevronLeft size={18} /></button>
          <button className="top-icon" type="button" aria-label="刷新" onClick={() => window.location.reload()}><RefreshCw size={16} /></button>

          <label className="search-box">
            <Search size={16} />
            <input
              aria-label="搜索任务"
              value={query}
              onChange={(event: { target: { value: string } }) => setQuery(event.target.value)}
              placeholder="搜文件、贴链接"
            />
          </label>

          <button className="new-button" type="button" onClick={() => setToast({ message: '新建任务将在阶段 B2 接入 Runtime 任务数据流。' })}>
            <Plus size={17} />新建
          </button>

          <div className="topbar-spacer" />
          <span className={`runtime-status ${runtimeConnected ? 'online' : ''}`} title={runtimeConnected ? 'Runtime 已连接' : '正在使用本地回退数据'}>
            <span />
            {runtimeConnected ? 'Runtime' : 'Fixture'}
          </span>
          <button className="top-icon" type="button" aria-label="更多"><MoreHorizontal size={18} /></button>
        </header>

        <section className="download-page">
          <div className="download-tabs" role="tablist" aria-label="任务状态">
            <button
              className={tab === 'active' ? 'download-tab active' : 'download-tab'}
              type="button"
              role="tab"
              aria-selected={tab === 'active'}
              onClick={() => switchTab('active')}
            >
              下载中 <span>{activeCount}</span>
            </button>
            <button
              className={tab === 'completed' ? 'download-tab active' : 'download-tab'}
              type="button"
              role="tab"
              aria-selected={tab === 'completed'}
              onClick={() => switchTab('completed')}
            >
              已完成 <span>{completedCount}</span>
            </button>

            <div className="download-header-actions">
              <button className="plain-icon" type="button" aria-label="刷新任务" onClick={() => window.location.reload()}><RefreshCw size={17} /></button>
              <button className="plain-icon" type="button" aria-label="更多操作"><MoreHorizontal size={18} /></button>
            </div>
          </div>

          <div className="download-summary">
            <div className="speed-summary">
              {tab === 'active' && totalSpeed > 0 ? (
                <><strong>{formatSpeed(totalSpeed)}</strong><span>当前总速度</span></>
              ) : (
                <><strong>{tab === 'active' ? activeCount : completedCount}</strong><span>{tab === 'active' ? '个进行中任务' : '个已完成任务'}</span></>
              )}
            </div>
            <span className="summary-copy">
              {tab === 'active' ? '智取任务保留资源目标、选择结果和恢复上下文' : '已交付任务与普通下载统一归档'}
            </span>
            <div className="view-actions" aria-label="视图操作">
              <button type="button" title="列表视图"><ListChecks size={16} /></button>
              <button type="button" title="筛选"><ShieldCheck size={16} /></button>
            </div>
          </div>

          <section className="task-list" aria-label={tab === 'active' ? '下载中任务' : '已完成任务'}>
            {visibleJobs.map((job) => (
              <TaskRow
                key={job.job_id}
                job={job}
                selected={drawerOpen && job.job_id === selectedId}
                onSelect={() => openJob(job)}
                onAction={() => handleJobAction(job)}
              />
            ))}

            {visibleJobs.length === 0 && (
              <EmptyState tab={tab} query={query} onCreate={() => setToast({ message: '新建任务会在阶段 B2 接入。' })} />
            )}
          </section>
        </section>
      </main>

      {drawerOpen && selectedJob && (
        <JobDrawer
          job={selectedJob}
          onClose={() => setDrawerOpen(false)}
          onAction={() => handleJobAction(selectedJob)}
        />
      )}

      {toast && <div className={`toast ${toast.tone === 'warning' ? 'warning' : ''}`} role="status">{toast.message}</div>}
    </div>
  );
}

function TaskRow({
  job,
  selected,
  onSelect,
  onAction
}: {
  job: ResourceJobSnapshot;
  selected: boolean;
  onSelect: () => void;
  onAction: () => void;
}) {
  const waiting = job.status === 'waiting_for_source';
  const completed = job.status === 'completed';
  const paused = job.status === 'paused';

  return (
    <article className={`task-row ${selected ? 'selected' : ''} ${waiting ? 'waiting' : ''}`}>
      <button className="task-open-area" type="button" onClick={onSelect} aria-label={`查看 ${job.title} 详情`}>
        <div className={`file-icon ${job.kind === 'zhiqu' ? 'zhiqu' : ''}`}>
          {job.kind === 'zhiqu' ? <Sparkles size={20} /> : <HardDriveDownload size={20} />}
        </div>

        <div className="task-main">
          <div className="task-title-row">
            <strong title={job.title}>{job.title}</strong>
            {job.kind === 'zhiqu' && <span className="zhiqu-tag">智取</span>}
          </div>
          <div className="task-subtitle" title={job.subtitle}>{job.subtitle}</div>

          {!completed && (
            <div className="task-progress-line">
              <div className="progress-track" aria-label={`下载进度 ${job.progress}%`}>
                <span className={waiting ? 'warning' : paused ? 'paused' : ''} style={{ width: `${job.progress}%` }} />
              </div>
              <div className="progress-meta">
                <span>{formatBytes(job.downloaded_bytes)} / {formatBytes(job.total_bytes)}</span>
                <span>来源 {job.source_count}</span>
                {job.excluded_count > 0 && <span>排除 {job.excluded_count} 项</span>}
              </div>
            </div>
          )}

          {completed && (
            <div className="completed-meta">
              <span>{formatDate(job.created_at)}</span>
              <span>{formatBytes(job.total_bytes)}</span>
              <span>{job.kind === 'zhiqu' ? `智取 · ${job.source_count} 来源` : '普通下载'}</span>
            </div>
          )}
        </div>

        <div className="task-state">
          {waiting ? (
            <>
              <strong className="warning-text">需要续取</strong>
              <span>{job.stage_label}</span>
            </>
          ) : completed ? (
            <>
              <strong>已完成</strong>
              <span>{job.destination || '下载目录'}</span>
            </>
          ) : paused ? (
            <>
              <strong>已暂停</strong>
              <span>{job.progress.toFixed(1)}%</span>
            </>
          ) : (
            <>
              <strong>{formatSpeed(job.speed_bytes_per_second)}</strong>
              <span>{job.eta_seconds ? `剩余 ${formatEta(job.eta_seconds)}` : job.stage_label}</span>
            </>
          )}
        </div>
      </button>

      <button
        className={`row-action ${waiting ? 'warning' : ''}`}
        type="button"
        onClick={onAction}
        aria-label={waiting ? '一键续取' : completed ? '打开文件夹' : paused ? '继续任务' : '暂停任务'}
        title={waiting ? '一键续取' : completed ? '打开文件夹' : paused ? '继续任务' : '暂停任务'}
      >
        {waiting ? <RefreshCw size={17} /> : completed ? <FolderOpen size={17} /> : paused ? <Play size={17} /> : <CirclePause size={18} />}
      </button>
    </article>
  );
}

function JobDrawer({ job, onClose, onAction }: { job: ResourceJobSnapshot; onClose: () => void; onAction: () => void }) {
  const waiting = job.status === 'waiting_for_source';
  const completed = job.status === 'completed';
  const paused = job.status === 'paused';

  return (
    <aside className="job-drawer" aria-label="任务详情">
      <div className="drawer-header">
        <div className={`file-icon large ${job.kind === 'zhiqu' ? 'zhiqu' : ''}`}>
          {job.kind === 'zhiqu' ? <Sparkles size={22} /> : <HardDriveDownload size={22} />}
        </div>
        <div className="drawer-title">
          <small>{job.kind === 'zhiqu' ? 'RESOURCE JOB' : 'DOWNLOAD JOB'}</small>
          <h2>{job.title}</h2>
          <span>{job.stage_label}</span>
        </div>
        <button className="drawer-close" type="button" onClick={onClose} aria-label="关闭详情"><X size={18} /></button>
      </div>

      {waiting && (
        <div className="issue-banner">
          <TriangleAlert size={17} />
          <div>
            <strong>当前问题：来源失效</strong>
            <p>{job.issue || '当前来源不可用，任务已保留上下文。'}</p>
          </div>
        </div>
      )}

      <div className="drawer-progress">
        <div className="drawer-progress-title">
          <span>{completed ? '交付进度' : '总体进度'}</span>
          <strong>{job.progress.toFixed(1)}%</strong>
        </div>
        <div className="progress-track large">
          <span className={waiting ? 'warning' : paused ? 'paused' : completed ? 'complete' : ''} style={{ width: `${job.progress}%` }} />
        </div>
        <div className="drawer-progress-meta">
          <span>{formatBytes(job.downloaded_bytes)} / {formatBytes(job.total_bytes)}</span>
          {!completed && <span>{job.speed_bytes_per_second > 0 ? formatSpeed(job.speed_bytes_per_second) : job.stage_label}</span>}
        </div>
      </div>

      <DrawerSection title="目标与选择">
        <DetailFact icon={<ListChecks size={16} />} label="资源目标" value={job.subtitle} />
        <DetailFact icon={<ShieldCheck size={16} />} label="智取整理" value={`保留 ${job.source_count} 个来源，排除 ${job.excluded_count} 项候选噪声`} />
      </DrawerSection>

      <DrawerSection title="当前状态">
        <DetailFact icon={<Activity size={16} />} label="当前阶段" value={job.stage_label} />
        <DetailFact icon={<FolderOpen size={16} />} label="交付位置" value={job.destination || '未设置'} />
      </DrawerSection>

      <DrawerSection title="下一步">
        <div className={`next-step ${waiting ? 'warning' : ''}`}>
          <strong>{waiting ? '继续获取可信来源' : completed ? '查看已交付资源' : paused ? '继续当前任务' : '继续托管下载'}</strong>
          <p>
            {waiting
              ? '优先检查已保存来源；仍不可用时再把原任务上下文带回浏览器。'
              : completed
                ? '任务已经完成，本阶段只保留交付位置与智取摘要。'
                : paused
                  ? '当前仅暂停界面状态，后续阶段再接真实下载引擎控制。'
                  : 'Runtime 持续托管任务，异常时会把恢复动作提升为主操作。'}
          </p>
        </div>
      </DrawerSection>

      {job.kind === 'zhiqu' && (
        <DrawerSection title="智取记录" compact>
          <TimelineRow label="节点 A 已生成资源计划" meta="资源理解与选型" state="done" />
          <TimelineRow label={`Selection Hygiene 排除 ${job.excluded_count} 项`} meta="确定性整理" state="done" />
          <TimelineRow
            label={waiting ? '等待新的可信来源' : completed ? '任务交付完成' : paused ? '用户暂停任务' : '正在执行资源任务'}
            meta="当前"
            state={waiting ? 'warning' : completed ? 'done' : 'active'}
          />
        </DrawerSection>
      )}

      <div className="drawer-footer">
        <button className={`drawer-primary ${waiting ? 'warning' : ''}`} type="button" onClick={onAction}>
          {waiting ? <><RefreshCw size={17} />一键续取</> : completed ? <><FolderOpen size={17} />打开文件夹</> : paused ? <><Play size={17} />继续任务</> : <><CirclePause size={17} />暂停任务</>}
        </button>
      </div>
    </aside>
  );
}

function DrawerSection({ title, compact = false, children }: { title: string; compact?: boolean; children: ReactNode }) {
  return (
    <section className={`drawer-section ${compact ? 'compact' : ''}`}>
      <h3>{title}</h3>
      <div>{children}</div>
    </section>
  );
}

function DetailFact({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="detail-fact">
      <span className="detail-fact-icon">{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function TimelineRow({ label, meta, state }: { label: string; meta: string; state: 'done' | 'active' | 'warning' }) {
  return (
    <div className="timeline-row">
      <span className={`timeline-dot ${state}`} />
      <div><strong>{label}</strong><span>{meta}</span></div>
    </div>
  );
}

function EmptyState({ tab, query, onCreate }: { tab: DownloadTab; query: string; onCreate: () => void }) {
  return (
    <div className="empty-state">
      <div className="empty-art"><FileClock size={28} /></div>
      <strong>{query ? '没有找到匹配任务' : tab === 'active' ? '暂无下载任务' : '暂无已完成任务'}</strong>
      <span>{query ? '换个关键词试试。' : tab === 'active' ? '新任务会出现在这里。' : '完成后的资源会统一归档。'}</span>
      {tab === 'active' && !query && <button type="button" onClick={onCreate}><Plus size={15} />新建任务</button>}
    </div>
  );
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** index;
  return `${amount >= 100 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function formatSpeed(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 KB/s';
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(value >= 10 * 1024 ** 2 ? 1 : 2)} MB/s`;
  return `${(value / 1024).toFixed(1)} KB/s`;
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}
