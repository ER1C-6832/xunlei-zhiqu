import type { LinkHistoryItem, ResourceJobSnapshot } from '@xunlei-zhiqu/contracts';
import {
  Activity,
  Archive,
  Bot,
  ChevronLeft,
  CirclePause,
  Cloud,
  Download,
  FileClock,
  FileImage,
  FileText,
  FolderOpen,
  Gamepad2,
  HardDriveDownload,
  History,
  LayoutGrid,
  Link2,
  List,
  ListChecks,
  MoreHorizontal,
  Music2,
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
import { useCallback, useEffect, useMemo, useState } from 'react';
import './b3.css';

const API_URL = import.meta.env.VITE_RUNTIME_URL || 'http://127.0.0.1:8765';

type PageKey = 'downloads' | 'cloud' | 'links';
type DownloadTab = 'active' | 'completed';
type HistoryFilter = 'all' | 'media' | 'image' | 'document' | 'archive';
type HistoryView = 'list' | 'grid';
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
    destination: 'D:/Downloads/Example App 5.2.1',
    delivery_target: 'local',
    execution_mode: 'demo'
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
    stage_label: '云盘来源失效，等待继续获取',
    issue: '主来源返回 503，原页面、候选与 42% 进度均已保留。',
    next_action: 'continue_acquisition',
    source_count: 2,
    excluded_count: 8,
    created_at: new Date(Date.now() - 72 * 60_000).toISOString(),
    destination: '迅雷云盘/智取下载/Open Media Course',
    delivery_target: 'cloud',
    execution_mode: 'demo'
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
    destination: 'D:/Downloads/sample-dataset.zip',
    delivery_target: 'local',
    execution_mode: 'demo'
  }
];

const fallbackHistory: LinkHistoryItem[] = [
  {
    history_id: 'history_fixture_001',
    title: 'Example App 5.2.1',
    link_type: 'http',
    display_link: 'https://downloads.example.test/ExampleApp_5.2.1_win_x64_portable.zip',
    size_bytes: 2_692_000_000,
    added_at: fallbackJobs[0].created_at,
    job_id: 'job_zhiqu_001',
    delivery_target: 'local',
    status: 'active',
    source_page: 'https://example.test/downloads'
  },
  {
    history_id: 'history_fixture_002',
    title: 'Open Media Course · 1080p',
    link_type: 'magnet',
    display_link: 'magnet:?xt=urn:btih:OPENMEDIACOURSEDEMO',
    size_bytes: 7_643_000_000,
    added_at: fallbackJobs[1].created_at,
    job_id: 'job_zhiqu_002',
    delivery_target: 'cloud',
    status: 'failed',
    source_page: 'https://media.example.test/course'
  },
  {
    history_id: 'history_fixture_003',
    title: 'sample-dataset.zip',
    link_type: 'http',
    display_link: 'https://data.example.test/sample-dataset.zip',
    size_bytes: 482_000_000,
    added_at: fallbackJobs[2].created_at,
    job_id: 'job_normal_001',
    delivery_target: 'local',
    status: 'completed',
    source_page: 'https://data.example.test/datasets'
  }
];

const navItems: Array<{ key?: PageKey; label: string; icon: typeof Download }> = [
  { key: 'downloads', label: '下载', icon: Download },
  { key: 'cloud', label: '云盘', icon: Cloud },
  { label: '播放', icon: Play },
  { key: 'links', label: '链接库', icon: Link2 },
  { label: '我的设备', icon: Smartphone },
  { label: '游戏', icon: Gamepad2 }
];

export function App() {
  const [page, setPage] = useState<PageKey>('downloads');
  const [jobs, setJobs] = useState<ResourceJobSnapshot[]>(fallbackJobs);
  const [history, setHistory] = useState<LinkHistoryItem[]>(fallbackHistory);
  const [selectedId, setSelectedId] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [tab, setTab] = useState<DownloadTab>('active');
  const [query, setQuery] = useState('');
  const [runtimeConnected, setRuntimeConnected] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [actionJobId, setActionJobId] = useState<string | null>(null);
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('all');
  const [historyView, setHistoryView] = useState<HistoryView>('list');

  const syncData = useCallback(async (showError = false) => {
    try {
      const jobsResponse = await fetch(`${API_URL}/v1/jobs`, { cache: 'no-store' });
      if (!jobsResponse.ok) throw new Error(`任务 HTTP ${jobsResponse.status}`);
      setJobs((await jobsResponse.json()) as ResourceJobSnapshot[]);
      setRuntimeConnected(true);

      const historyResponse = await fetch(`${API_URL}/v1/link-history`, { cache: 'no-store' });
      if (historyResponse.ok) setHistory((await historyResponse.json()) as LinkHistoryItem[]);
    } catch (syncError) {
      setRuntimeConnected(false);
      if (showError) setToast({ message: syncError instanceof Error ? `刷新失败：${syncError.message}` : '刷新失败', tone: 'warning' });
    }
  }, []);

  useEffect(() => {
    void syncData();
    const timer = window.setInterval(() => void syncData(), 1500);
    return () => window.clearInterval(timer);
  }, [syncData]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const activeCount = jobs.filter((job) => job.status !== 'completed').length;
  const completedCount = jobs.filter((job) => job.status === 'completed').length;
  const cloudCount = jobs.filter((job) => job.delivery_target === 'cloud').length;
  const totalSpeed = jobs
    .filter((job) => job.status === 'downloading' && (page !== 'cloud' || job.delivery_target === 'cloud'))
    .reduce((sum, job) => sum + job.speed_bytes_per_second, 0);

  const visibleJobs = useMemo(() => {
    const lowerQuery = query.trim().toLowerCase();
    return jobs.filter((job) => {
      const matchesPage = page !== 'cloud' || job.delivery_target === 'cloud';
      const matchesTab = tab === 'completed' ? job.status === 'completed' : job.status !== 'completed';
      const matchesQuery = !lowerQuery || `${job.title} ${job.subtitle} ${job.destination ?? ''}`.toLowerCase().includes(lowerQuery);
      return matchesPage && matchesTab && matchesQuery;
    });
  }, [jobs, page, query, tab]);

  const visibleHistory = useMemo(() => {
    const lowerQuery = query.trim().toLowerCase();
    return history.filter((item) => {
      const kind = classifyHistory(item);
      return (historyFilter === 'all' || kind === historyFilter)
        && (!lowerQuery || `${item.title} ${item.display_link} ${item.source_page ?? ''}`.toLowerCase().includes(lowerQuery));
    });
  }, [history, historyFilter, query]);

  const selectedJob = jobs.find((job) => job.job_id === selectedId) ?? null;

  function changePage(nextPage: PageKey) {
    setPage(nextPage);
    setQuery('');
    setDrawerOpen(false);
    setSelectedId('');
  }

  function switchTab(nextTab: DownloadTab) {
    setTab(nextTab);
    setDrawerOpen(false);
    setSelectedId('');
  }

  function openJob(job: ResourceJobSnapshot) {
    setSelectedId(job.job_id);
    setDrawerOpen(true);
  }

  function openHistoryJob(item: LinkHistoryItem) {
    const job = item.job_id ? jobs.find((candidate) => candidate.job_id === item.job_id) : null;
    if (!job) {
      setToast({ message: '这条历史当前没有关联的 ResourceJob。' });
      return;
    }
    setPage(job.delivery_target === 'cloud' ? 'cloud' : 'downloads');
    setTab(job.status === 'completed' ? 'completed' : 'active');
    setSelectedId(job.job_id);
    setDrawerOpen(true);
    setQuery('');
  }

  async function handleJobAction(job: ResourceJobSnapshot) {
    if (job.status === 'waiting_for_source') {
      setToast({ message: '一键续取入口已保留；阶段 F 接真实重新智取闭环。', tone: 'warning' });
      return;
    }
    if (job.status === 'completed') {
      setToast({ message: `${job.delivery_target === 'cloud' ? '云盘位置' : '交付位置'}：${job.destination || '尚未设置'}` });
      return;
    }

    const operation = job.status === 'paused' ? 'resume' : 'pause';
    setActionJobId(job.job_id);
    try {
      const response = await fetch(`${API_URL}/v1/jobs/${job.job_id}/${operation}`, { method: 'POST' });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { detail?: string } | null;
        throw new Error(body?.detail || `HTTP ${response.status}`);
      }
      const updated = (await response.json()) as ResourceJobSnapshot;
      setJobs((current) => current.map((item) => item.job_id === updated.job_id ? updated : item));
      setToast({ message: operation === 'pause' ? 'Runtime 已暂停任务。' : 'Runtime 已恢复任务。' });
    } catch (actionError) {
      setToast({ message: actionError instanceof Error ? actionError.message : '任务操作失败', tone: 'warning' });
    } finally {
      setActionJobId(null);
    }
  }

  return (
    <div className="app-frame">
      <aside className="sidebar" aria-label="主导航">
        <div className="brand-row"><span className="brand-bird"><Sparkles size={18} /></span><strong>迅雷</strong></div>
        <nav className="primary-nav">
          {navItems.map(({ key, label, icon: Icon }) => (
            <button className={`nav-item ${key === page ? 'active' : ''}`} type="button" key={label} onClick={() => key ? changePage(key) : setToast({ message: `${label}不属于阶段 B 下载链路，暂不实现。` })}>
              <Icon size={18} strokeWidth={1.8} /><span>{label}</span>
              {key === 'downloads' && activeCount > 0 && <span className="nav-badge">{activeCount}</span>}
              {key === 'cloud' && cloudCount > 0 && <span className="nav-soft-badge">{cloudCount}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-spacer" />
        <button className="nav-item secondary" type="button" onClick={() => setToast({ message: '设置暂不进入阶段 B。' })}><Settings size={18} /><span>设置</span></button>
        <div className="prototype-mark"><Bot size={15} /><span>迅雷智取功能原型</span></div>
      </aside>

      <main className="main-shell">
        <header className="topbar">
          <button className="top-icon" type="button"><ChevronLeft size={18} /></button>
          <button className="top-icon forward" type="button"><ChevronLeft size={18} /></button>
          <button className="top-icon" type="button" onClick={() => void syncData(true)}><RefreshCw size={16} /></button>
          <label className="search-box"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={page === 'links' ? '搜链接、文件名' : page === 'cloud' ? '搜索云盘任务' : '搜文件、贴链接'} /></label>
          <button className="new-button" type="button" onClick={() => setToast({ message: '智取任务从浏览器扩展确认 ResourcePlan 后创建；阶段 B 不额外造手工新建流程。' })}><Plus size={17} />新建</button>
          <div className="topbar-spacer" />
          <span className={`runtime-status ${runtimeConnected ? 'online' : ''}`}><span />{runtimeConnected ? 'Runtime · 自动刷新' : 'Fixture'}</span>
          <button className="top-icon" type="button"><MoreHorizontal size={18} /></button>
        </header>

        {page === 'links' ? (
          <LinkHistoryPage items={visibleHistory} filter={historyFilter} view={historyView} query={query} onFilter={setHistoryFilter} onView={setHistoryView} onOpen={openHistoryJob} onDeferred={() => setToast({ message: '链接收藏不是阶段 B 主链路，本轮只实现历史。' })} />
        ) : (
          <DownloadPage
            cloudOnly={page === 'cloud'} jobs={visibleJobs} tab={tab}
            activeCount={page === 'cloud' ? jobs.filter((job) => job.delivery_target === 'cloud' && job.status !== 'completed').length : activeCount}
            completedCount={page === 'cloud' ? jobs.filter((job) => job.delivery_target === 'cloud' && job.status === 'completed').length : completedCount}
            totalSpeed={totalSpeed} query={query} selectedId={drawerOpen ? selectedId : ''} actionJobId={actionJobId}
            onTab={switchTab} onRefresh={() => void syncData(true)} onSelect={openJob} onAction={(job) => void handleJobAction(job)}
          />
        )}
      </main>

      {drawerOpen && selectedJob && <JobDrawer job={selectedJob} busy={actionJobId === selectedJob.job_id} onClose={() => setDrawerOpen(false)} onAction={() => void handleJobAction(selectedJob)} />}
      {toast && <div className={`toast ${toast.tone === 'warning' ? 'warning' : ''}`} role="status">{toast.message}</div>}
    </div>
  );
}

function DownloadPage({ cloudOnly, jobs, tab, activeCount, completedCount, totalSpeed, query, selectedId, actionJobId, onTab, onRefresh, onSelect, onAction }: {
  cloudOnly: boolean; jobs: ResourceJobSnapshot[]; tab: DownloadTab; activeCount: number; completedCount: number; totalSpeed: number; query: string; selectedId: string; actionJobId: string | null;
  onTab: (tab: DownloadTab) => void; onRefresh: () => void; onSelect: (job: ResourceJobSnapshot) => void; onAction: (job: ResourceJobSnapshot) => void;
}) {
  return (
    <section className="download-page">
      {cloudOnly && <div className="cloud-context"><div><Cloud size={19} /><strong>云盘下载</strong><span>只展示交付目标为迅雷云盘的 ResourceJob</span></div><small>资源理解、来源与恢复上下文仍由同一个 Runtime 任务持有。</small></div>}
      <div className="download-tabs">
        <button className={tab === 'active' ? 'download-tab active' : 'download-tab'} type="button" onClick={() => onTab('active')}>{cloudOnly ? '保存中' : '下载中'} <span>{activeCount}</span></button>
        <button className={tab === 'completed' ? 'download-tab active' : 'download-tab'} type="button" onClick={() => onTab('completed')}>已完成 <span>{completedCount}</span></button>
        <div className="download-header-actions"><button className="plain-icon" type="button" onClick={onRefresh}><RefreshCw size={17} /></button><button className="plain-icon" type="button"><MoreHorizontal size={18} /></button></div>
      </div>
      <div className="download-summary">
        <div className="speed-summary">{tab === 'active' && totalSpeed > 0 ? <><strong>{formatSpeed(totalSpeed)}</strong><span>{cloudOnly ? '云盘任务速度' : '当前总速度'}</span></> : <><strong>{tab === 'active' ? activeCount : completedCount}</strong><span>{tab === 'active' ? '个进行中任务' : '个已完成任务'}</span></>}</div>
        <span className="summary-copy">{cloudOnly ? '云盘只是交付目的地差异，不复制一套下载逻辑' : '任务快照由 Runtime 持有，页面每 1.5 秒同步'}</span>
        <div className="view-actions"><button type="button"><ListChecks size={16} /></button><button type="button"><ShieldCheck size={16} /></button></div>
      </div>
      <section className="task-list">
        {jobs.map((job) => <TaskRow key={job.job_id} job={job} selected={job.job_id === selectedId} busy={job.job_id === actionJobId} onSelect={() => onSelect(job)} onAction={() => onAction(job)} />)}
        {jobs.length === 0 && <EmptyState tab={tab} query={query} cloudOnly={cloudOnly} />}
      </section>
    </section>
  );
}

function LinkHistoryPage({ items, filter, view, query, onFilter, onView, onOpen, onDeferred }: {
  items: LinkHistoryItem[]; filter: HistoryFilter; view: HistoryView; query: string; onFilter: (filter: HistoryFilter) => void; onView: (view: HistoryView) => void; onOpen: (item: LinkHistoryItem) => void; onDeferred: () => void;
}) {
  const filters: Array<[HistoryFilter, string]> = [['all', '全部'], ['media', '音视频'], ['image', '图片'], ['document', '文档'], ['archive', '压缩包']];
  return (
    <section className="link-page">
      <div className="link-titlebar"><button type="button" onClick={onDeferred}>收藏</button><button className="active" type="button"><History size={15} />历史 <span>{items.length}</span></button><div className="link-sync"><Cloud size={13} />本机 Runtime 历史</div></div>
      <div className="link-toolbar"><div className="history-filters">{filters.map(([key, label]) => <button className={filter === key ? 'active' : ''} type="button" key={key} onClick={() => onFilter(key)}>{label}</button>)}</div><div className="history-view-switch"><button className={view === 'list' ? 'active' : ''} type="button" onClick={() => onView('list')}><List size={15} /></button><button className={view === 'grid' ? 'active' : ''} type="button" onClick={() => onView('grid')}><LayoutGrid size={15} /></button></div></div>
      {view === 'list' && items.length > 0 && <div className="history-columns"><span>文件名 / 来源</span><span>类型</span><span>添加时间</span></div>}
      <div className={view === 'grid' ? 'history-grid' : 'history-list'}>
        {items.map((item) => <HistoryItem key={item.history_id} item={item} view={view} onOpen={() => onOpen(item)} />)}
        {items.length === 0 && <div className="history-empty"><Link2 size={31} /><strong>{query ? '没有匹配的历史' : '暂无链接历史'}</strong><span>从扩展创建 ResourceJob 后，来源会自动进入这里。</span></div>}
      </div>
    </section>
  );
}

function HistoryItem({ item, view, onOpen }: { item: LinkHistoryItem; view: HistoryView; onOpen: () => void }) {
  const kind = classifyHistory(item);
  return (
    <button className={`history-item ${view}`} type="button" onClick={onOpen}>
      <span className={`history-file-icon ${kind}`}>{historyIcon(kind)}</span>
      <span className="history-main"><strong>{item.title}</strong><span><Link2 size={11} />{item.display_link}</span><small>{item.size_bytes ? formatBytes(item.size_bytes) : '大小未知'} · {item.delivery_target === 'cloud' ? '保存到云盘' : '本地下载'}</small></span>
      <span className="history-type">{historyTypeLabel(item, kind)}{item.status === 'failed' && <small className="failed">链接已失效</small>}</span>
      <span className="history-time">{formatDateTime(item.added_at)}</span>
    </button>
  );
}

function TaskRow({ job, selected, busy, onSelect, onAction }: { job: ResourceJobSnapshot; selected: boolean; busy: boolean; onSelect: () => void; onAction: () => void }) {
  const waiting = job.status === 'waiting_for_source';
  const completed = job.status === 'completed';
  const paused = job.status === 'paused';
  const planning = job.status === 'planning';
  const cloud = job.delivery_target === 'cloud';
  return (
    <article className={`task-row ${selected ? 'selected' : ''} ${waiting ? 'waiting' : ''}`}>
      <button className="task-open-area" type="button" onClick={onSelect}>
        <div className={`file-icon ${job.kind === 'zhiqu' ? 'zhiqu' : ''}`}>{cloud ? <Cloud size={20} /> : job.kind === 'zhiqu' ? <Sparkles size={20} /> : <HardDriveDownload size={20} />}</div>
        <div className="task-main">
          <div className="task-title-row"><strong>{job.title}</strong>{job.kind === 'zhiqu' && <span className="zhiqu-tag">智取</span>}{cloud && <span className="cloud-tag">云盘</span>}</div>
          <div className="task-subtitle">{job.subtitle}</div>
          {!completed ? <div className="task-progress-line"><div className="progress-track"><span className={waiting ? 'warning' : paused ? 'paused' : ''} style={{ width: `${job.progress}%` }} /></div><div className="progress-meta"><span>{formatBytes(job.downloaded_bytes)} / {formatBytes(job.total_bytes)}</span><span>来源 {job.source_count}</span>{job.excluded_count > 0 && <span>排除 {job.excluded_count} 项</span>}</div></div> : <div className="completed-meta"><span>{formatDateTime(job.created_at)}</span><span>{formatBytes(job.total_bytes)}</span><span>{cloud ? '云盘交付' : job.kind === 'zhiqu' ? `智取 · ${job.source_count} 来源` : '普通下载'}</span></div>}
        </div>
        <div className="task-state">{waiting ? <><strong className="warning-text">需要续取</strong><span>{job.stage_label}</span></> : completed ? <><strong>{cloud ? '已存云盘' : '已完成'}</strong><span>{job.destination}</span></> : paused ? <><strong>已暂停</strong><span>{job.progress.toFixed(1)}%</span></> : planning ? <><strong>准备任务</strong><span>{job.stage_label}</span></> : <><strong>{job.speed_bytes_per_second > 0 ? formatSpeed(job.speed_bytes_per_second) : `${job.progress.toFixed(1)}%`}</strong><span>{job.eta_seconds ? `剩余 ${formatEta(job.eta_seconds)}` : job.stage_label}</span></>}</div>
      </button>
      <button className={`row-action ${waiting ? 'warning' : ''}`} type="button" onClick={onAction} disabled={busy}>{waiting ? <RefreshCw size={17} /> : completed ? cloud ? <Cloud size={17} /> : <FolderOpen size={17} /> : paused ? <Play size={17} /> : <CirclePause size={18} />}</button>
    </article>
  );
}

function JobDrawer({ job, busy, onClose, onAction }: { job: ResourceJobSnapshot; busy: boolean; onClose: () => void; onAction: () => void }) {
  const waiting = job.status === 'waiting_for_source';
  const completed = job.status === 'completed';
  const paused = job.status === 'paused';
  const cloud = job.delivery_target === 'cloud';
  return (
    <aside className="job-drawer">
      <div className="drawer-header"><div className={`file-icon large ${job.kind === 'zhiqu' ? 'zhiqu' : ''}`}>{cloud ? <Cloud size={22} /> : job.kind === 'zhiqu' ? <Sparkles size={22} /> : <HardDriveDownload size={22} />}</div><div className="drawer-title"><small>{cloud ? 'CLOUD RESOURCE JOB' : job.kind === 'zhiqu' ? 'RESOURCE JOB' : 'DOWNLOAD JOB'}</small><h2>{job.title}</h2><span>{job.stage_label}</span></div><button className="drawer-close" type="button" onClick={onClose}><X size={18} /></button></div>
      {waiting && <div className="issue-banner"><TriangleAlert size={17} /><div><strong>当前问题：来源失效</strong><p>{job.issue || '当前来源不可用，任务上下文仍保留。'}</p></div></div>}
      <div className="drawer-progress"><div className="drawer-progress-title"><span>{cloud ? '云盘交付进度' : completed ? '交付进度' : '总体进度'}</span><strong>{job.progress.toFixed(1)}%</strong></div><div className="progress-track large"><span className={waiting ? 'warning' : paused ? 'paused' : completed ? 'complete' : ''} style={{ width: `${job.progress}%` }} /></div><div className="drawer-progress-meta"><span>{formatBytes(job.downloaded_bytes)} / {formatBytes(job.total_bytes)}</span>{!completed && <span>{job.speed_bytes_per_second > 0 ? formatSpeed(job.speed_bytes_per_second) : job.stage_label}</span>}</div></div>
      <DrawerSection title="目标与选择"><DetailFact icon={<ListChecks size={16} />} label="资源目标" value={job.subtitle} /><DetailFact icon={<ShieldCheck size={16} />} label="智取整理" value={`保留 ${job.source_count} 个来源，排除 ${job.excluded_count} 项候选噪声`} /></DrawerSection>
      <DrawerSection title="交付"><DetailFact icon={cloud ? <Cloud size={16} /> : <FolderOpen size={16} />} label="交付方式" value={cloud ? '保存到迅雷云盘' : '下载到本地'} /><DetailFact icon={<FolderOpen size={16} />} label="交付位置" value={job.destination || '未设置'} /></DrawerSection>
      <DrawerSection title="当前状态"><DetailFact icon={<Activity size={16} />} label="Runtime 阶段" value={job.stage_label} /></DrawerSection>
      <DrawerSection title="下一步"><div className={`next-step ${waiting ? 'warning' : ''}`}><strong>{waiting ? '继续获取可信来源' : completed ? cloud ? '查看云盘交付位置' : '查看已交付资源' : paused ? '继续当前任务' : cloud ? '继续保存到云盘' : '继续托管下载'}</strong><p>{waiting ? '优先检查已保存来源；仍不可用时再把原任务上下文带回浏览器。' : completed ? '任务已经完成，来源历史仍保留在链接库。' : '当前仍是阶段 B 演示执行；真实下载和云盘写入在阶段 E 接入。'}</p></div></DrawerSection>
      <div className="drawer-footer"><button className={`drawer-primary ${waiting ? 'warning' : ''}`} type="button" onClick={onAction} disabled={busy}>{waiting ? <><RefreshCw size={17} />一键续取</> : completed ? cloud ? <><Cloud size={17} />查看云盘位置</> : <><FolderOpen size={17} />打开文件夹</> : paused ? <><Play size={17} />继续任务</> : <><CirclePause size={17} />暂停任务</>}</button></div>
    </aside>
  );
}

function DrawerSection({ title, children }: { title: string; children: ReactNode }) { return <section className="drawer-section"><h3>{title}</h3><div>{children}</div></section>; }
function DetailFact({ icon, label, value }: { icon: ReactNode; label: string; value: string }) { return <div className="detail-fact"><span className="detail-fact-icon">{icon}</span><div><small>{label}</small><strong>{value}</strong></div></div>; }
function EmptyState({ tab, query, cloudOnly }: { tab: DownloadTab; query: string; cloudOnly: boolean }) { return <div className="empty-state"><div className="empty-art">{cloudOnly ? <Cloud size={28} /> : <FileClock size={28} />}</div><strong>{query ? '没有找到匹配任务' : cloudOnly ? '暂无云盘任务' : tab === 'active' ? '暂无下载任务' : '暂无已完成任务'}</strong><span>{query ? '换个关键词试试。' : cloudOnly ? '在扩展确认计划时选择“保存到云盘”。' : '新 ResourceJob 会自动出现在这里。'}</span></div>; }

function classifyHistory(item: LinkHistoryItem): HistoryFilter {
  const name = item.title.toLowerCase();
  if (item.link_type === 'media' || /\.(mp4|mkv|m3u8|mp3|flac|aac|wav)$/i.test(name)) return 'media';
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)) return 'image';
  if (/\.(pdf|docx?|xlsx?|pptx?|txt|md)$/i.test(name)) return 'document';
  if (/\.(zip|rar|7z|tar|gz|xz)$/i.test(name)) return 'archive';
  return 'all';
}
function historyIcon(kind: HistoryFilter): ReactNode { if (kind === 'media') return <Music2 size={20} />; if (kind === 'image') return <FileImage size={20} />; if (kind === 'document') return <FileText size={20} />; if (kind === 'archive') return <Archive size={20} />; return <Link2 size={20} />; }
function historyTypeLabel(item: LinkHistoryItem, kind: HistoryFilter): string { if (item.link_type === 'magnet') return 'Magnet'; if (kind === 'media') return '音视频'; if (kind === 'image') return '图片'; if (kind === 'document') return '文档'; if (kind === 'archive') return '压缩包'; return '链接'; }
function formatBytes(value: number): string { if (!Number.isFinite(value) || value <= 0) return '0 B'; const units = ['B', 'KB', 'MB', 'GB', 'TB']; const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1); const amount = value / 1024 ** index; return `${amount >= 100 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`; }
function formatSpeed(value: number): string { if (!Number.isFinite(value) || value <= 0) return '0 KB/s'; if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(value >= 10 * 1024 ** 2 ? 1 : 2)} MB/s`; return `${(value / 1024).toFixed(1)} KB/s`; }
function formatEta(seconds: number): string { if (seconds < 60) return `${seconds} 秒`; const minutes = Math.floor(seconds / 60); const rest = seconds % 60; return `${minutes}:${String(rest).padStart(2, '0')}`; }
function formatDateTime(value: string): string { const date = new Date(value); if (Number.isNaN(date.getTime())) return value; return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date); }
