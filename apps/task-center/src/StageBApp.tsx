import type {
  DeliveryTarget,
  LinkHistoryItem,
  ManualJobCreateRequest,
  ResourceJobSnapshot
} from '@xunlei-zhiqu/contracts';
import {
  Activity,
  Archive,
  Bell,
  Bird,
  Check,
  ChevronDown,
  ChevronLeft,
  CirclePause,
  Cloud,
  Copy,
  Download,
  ExternalLink,
  FileClock,
  FileImage,
  FileText,
  Filter,
  FolderOpen,
  HardDrive,
  HardDriveDownload,
  History,
  Info,
  LayoutGrid,
  Link2,
  List,
  ListChecks,
  LoaderCircle,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  TriangleAlert,
  UserRound,
  X
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import './stage-b.css';

const API_URL = import.meta.env.VITE_RUNTIME_URL || 'http://127.0.0.1:8765';
const SETTINGS_KEY = 'xunlei-zhiqu.stage-b.preferences';

type PageKey = 'downloads' | 'cloud' | 'links';
type DownloadTab = 'active' | 'completed';
type LibraryTab = 'favorites' | 'history';
type LibraryFilter = 'all' | 'media' | 'image' | 'document' | 'archive' | 'software';
type LibraryView = 'list' | 'grid';
type TaskKindFilter = 'all' | 'zhiqu' | 'normal';
type TaskStateFilter = 'all' | 'running' | 'paused' | 'issue';
type SortMode = 'newest' | 'progress' | 'speed';
type SettingsSection = 'general' | 'download' | 'notifications' | 'about';
type ToastState = { message: string; tone?: 'normal' | 'warning' } | null;
type RuntimeInfo = { status: string; provider: string; version: string };

type TaskFilter = {
  kind: TaskKindFilter;
  state: TaskStateFilter;
  sort: SortMode;
};

type Preferences = {
  refreshMs: 1500 | 3000 | 5000;
  density: 'comfortable' | 'compact';
  defaultDelivery: DeliveryTarget;
  showTechnical: boolean;
  notifications: boolean;
};

const defaultPreferences: Preferences = {
  refreshMs: 1500,
  density: 'comfortable',
  defaultDelivery: 'local',
  showTechnical: true,
  notifications: true
};

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
    execution_mode: 'demo',
    resource_type: 'software',
    plan_overview: '节点 A 选择当前设备可直接使用的 Windows x64 便携版，并保留语言包与校验文件。',
    selected_items: ['Windows x64 便携版', '中文语言包', 'SHA-256 校验文件'],
    alternative_count: 2,
    source_page: 'https://example.test/downloads'
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
    execution_mode: 'demo',
    resource_type: 'video',
    plan_overview: '选择 1080p 主视频、中文字幕和课程附件，备用来源保留用于恢复。',
    selected_items: ['1080p 主视频组', '简体中文字幕', '课程附件'],
    alternative_count: 2,
    source_page: 'https://media.example.test/course'
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
    execution_mode: 'demo',
    resource_type: 'archive',
    selected_items: ['sample-dataset.zip']
  }
];

const fallbackLibrary: LinkHistoryItem[] = [
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
    source_page: 'https://example.test/downloads',
    resource_type: 'software',
    favorite: true,
    favorite_at: fallbackJobs[0].created_at
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
    source_page: 'https://media.example.test/course',
    resource_type: 'video',
    favorite: false
  }
];

const navItems: Array<{ key: PageKey; label: string; icon: typeof Download }> = [
  { key: 'downloads', label: '下载', icon: Download },
  { key: 'cloud', label: '云盘', icon: Cloud },
  { key: 'links', label: '链接库', icon: Link2 }
];

export function StageBApp() {
  const [page, setPage] = useState<PageKey>(() => pageFromHash());
  const [jobs, setJobs] = useState<ResourceJobSnapshot[]>(fallbackJobs);
  const [library, setLibrary] = useState<LinkHistoryItem[]>(fallbackLibrary);
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null);
  const [runtimeConnected, setRuntimeConnected] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [tab, setTab] = useState<DownloadTab>('active');
  const [libraryTab, setLibraryTab] = useState<LibraryTab>('history');
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>('all');
  const [libraryView, setLibraryView] = useState<LibraryView>('list');
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState<ToastState>(null);
  const [actionJobId, setActionJobId] = useState<string | null>(null);
  const [taskFilter, setTaskFilter] = useState<TaskFilter>({ kind: 'all', state: 'all', sort: 'newest' });
  const [filterOpen, setFilterOpen] = useState(false);
  const [batchMenuOpen, setBatchMenuOpen] = useState(false);
  const [topPopover, setTopPopover] = useState<'user' | 'notifications' | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>(() => loadPreferences());

  const syncData = useCallback(async (showError = false) => {
    try {
      const [jobsResponse, libraryResponse, healthResponse] = await Promise.all([
        fetch(`${API_URL}/v1/jobs`, { cache: 'no-store' }),
        fetch(`${API_URL}/v1/link-library`, { cache: 'no-store' }),
        fetch(`${API_URL}/v1/health`, { cache: 'no-store' })
      ]);
      if (!jobsResponse.ok) throw new Error(`任务 HTTP ${jobsResponse.status}`);
      if (!libraryResponse.ok) throw new Error(`链接库 HTTP ${libraryResponse.status}`);
      setJobs((await jobsResponse.json()) as ResourceJobSnapshot[]);
      setLibrary((await libraryResponse.json()) as LinkHistoryItem[]);
      if (healthResponse.ok) setRuntimeInfo((await healthResponse.json()) as RuntimeInfo);
      setRuntimeConnected(true);
    } catch (error) {
      setRuntimeConnected(false);
      if (showError) setToast({ message: error instanceof Error ? `刷新失败：${error.message}` : '刷新失败', tone: 'warning' });
    }
  }, []);

  useEffect(() => {
    if (!window.location.hash) window.history.replaceState(null, '', '#/downloads');
    const handleHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, []);

  useEffect(() => {
    void syncData();
    const timer = window.setInterval(() => void syncData(), preferences.refreshMs);
    return () => window.clearInterval(timer);
  }, [preferences.refreshMs, syncData]);

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(preferences));
  }, [preferences]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const scopeJobs = useMemo(
    () => jobs.filter((job) => page === 'cloud' ? job.delivery_target === 'cloud' : job.delivery_target !== 'cloud'),
    [jobs, page]
  );
  const activeCount = scopeJobs.filter((job) => job.status !== 'completed').length;
  const completedCount = scopeJobs.filter((job) => job.status === 'completed').length;
  const totalSpeed = scopeJobs.filter((job) => job.status === 'downloading').reduce((sum, job) => sum + job.speed_bytes_per_second, 0);
  const issueCount = jobs.filter((job) => job.status === 'waiting_for_source').length;
  const favoriteCount = library.filter((item) => item.favorite).length;

  const visibleJobs = useMemo(() => {
    const lower = query.trim().toLowerCase();
    const filtered = scopeJobs.filter((job) => {
      const matchesTab = tab === 'completed' ? job.status === 'completed' : job.status !== 'completed';
      const matchesQuery = !lower || `${job.title} ${job.subtitle} ${job.destination ?? ''}`.toLowerCase().includes(lower);
      const matchesKind = taskFilter.kind === 'all' || job.kind === taskFilter.kind;
      const matchesState = taskFilter.state === 'all'
        || (taskFilter.state === 'running' && ['planning', 'downloading', 'verifying'].includes(job.status))
        || (taskFilter.state === 'paused' && job.status === 'paused')
        || (taskFilter.state === 'issue' && job.status === 'waiting_for_source');
      return matchesTab && matchesQuery && matchesKind && matchesState;
    });
    return [...filtered].sort((a, b) => {
      if (taskFilter.sort === 'speed') return b.speed_bytes_per_second - a.speed_bytes_per_second;
      if (taskFilter.sort === 'progress') return b.progress - a.progress;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [query, scopeJobs, tab, taskFilter]);

  const visibleLibrary = useMemo(() => {
    const lower = query.trim().toLowerCase();
    return library
      .filter((item) => libraryTab === 'history' || Boolean(item.favorite))
      .filter((item) => libraryFilter === 'all' || classifyLibrary(item) === libraryFilter)
      .filter((item) => !lower || `${item.title} ${item.display_link} ${item.source_page ?? ''}`.toLowerCase().includes(lower))
      .sort((a, b) => {
        const aTime = libraryTab === 'favorites' && a.favorite_at ? a.favorite_at : a.added_at;
        const bTime = libraryTab === 'favorites' && b.favorite_at ? b.favorite_at : b.added_at;
        return new Date(bTime).getTime() - new Date(aTime).getTime();
      });
  }, [library, libraryFilter, libraryTab, query]);

  const selectedJob = jobs.find((job) => job.job_id === selectedId) ?? null;
  const activeFilterCount = Number(taskFilter.kind !== 'all') + Number(taskFilter.state !== 'all') + Number(taskFilter.sort !== 'newest');

  function changePage(nextPage: PageKey) {
    setPage(nextPage);
    setQuery('');
    setDrawerOpen(false);
    setSelectedId('');
    setFilterOpen(false);
    setBatchMenuOpen(false);
    setTopPopover(null);
    if (window.location.hash !== `#/${nextPage}`) window.location.hash = `/${nextPage}`;
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

  async function copyText(text: string, message = '已复制') {
    try {
      await navigator.clipboard.writeText(text);
      setToast({ message });
    } catch {
      setToast({ message: text });
    }
  }

  async function handleJobAction(job: ResourceJobSnapshot) {
    if (job.status === 'waiting_for_source') {
      setToast({ message: '一键续取入口已就位；真实重新智取闭环在阶段 F 接入。', tone: 'warning' });
      return;
    }
    if (job.status === 'completed') {
      await copyText(job.destination || '未设置交付位置', job.delivery_target === 'cloud' ? '云盘位置已复制' : '本地路径已复制');
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
      setToast({ message: operation === 'pause' ? 'Runtime 已暂停任务' : 'Runtime 已恢复任务' });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : '任务操作失败', tone: 'warning' });
    } finally {
      setActionJobId(null);
    }
  }

  async function handleBatch(operation: 'pause' | 'resume') {
    const targets = scopeJobs.filter((job) => operation === 'pause'
      ? ['planning', 'downloading', 'verifying'].includes(job.status)
      : job.status === 'paused');
    setBatchMenuOpen(false);
    if (!targets.length) {
      setToast({ message: operation === 'pause' ? '当前没有可暂停任务' : '当前没有已暂停任务' });
      return;
    }
    try {
      await Promise.all(targets.map(async (job) => {
        const response = await fetch(`${API_URL}/v1/jobs/${job.job_id}/${operation}`, { method: 'POST' });
        if (!response.ok) throw new Error(`${job.title} 操作失败`);
      }));
      await syncData();
      setToast({ message: operation === 'pause' ? `已暂停 ${targets.length} 个任务` : `已恢复 ${targets.length} 个任务` });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : '批量操作失败', tone: 'warning' });
    }
  }

  async function toggleFavorite(item: LinkHistoryItem) {
    try {
      const response = await fetch(`${API_URL}/v1/link-library/${item.history_id}/favorite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorite: !item.favorite })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const updated = (await response.json()) as LinkHistoryItem;
      setLibrary((current) => current.map((entry) => entry.history_id === updated.history_id ? updated : entry));
      setToast({ message: updated.favorite ? '已加入收藏' : '已取消收藏' });
    } catch (error) {
      setToast({ message: error instanceof Error ? `收藏操作失败：${error.message}` : '收藏操作失败', tone: 'warning' });
    }
  }

  function openLibraryItem(item: LinkHistoryItem) {
    const job = item.job_id ? jobs.find((candidate) => candidate.job_id === item.job_id) : null;
    if (job) {
      changePage(job.delivery_target === 'cloud' ? 'cloud' : 'downloads');
      setTab(job.status === 'completed' ? 'completed' : 'active');
      setSelectedId(job.job_id);
      setDrawerOpen(true);
      return;
    }
    const target = item.source_page || item.display_link;
    if (target.startsWith('http://') || target.startsWith('https://')) {
      window.open(target, '_blank', 'noopener,noreferrer');
      return;
    }
    void copyText(item.display_link, '资源链接已复制');
  }

  async function createManualTask(payload: ManualJobCreateRequest) {
    const response = await fetch(`${API_URL}/v1/jobs/manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { detail?: string } | null;
      throw new Error(body?.detail || `Runtime 返回 ${response.status}`);
    }
    const job = (await response.json()) as ResourceJobSnapshot;
    await syncData();
    setNewTaskOpen(false);
    changePage(job.delivery_target === 'cloud' ? 'cloud' : 'downloads');
    setTab('active');
    setSelectedId(job.job_id);
    setDrawerOpen(true);
    setToast({ message: '普通任务已创建；复杂页面仍建议使用智取扩展' });
  }

  function openSettings(section: SettingsSection = 'general') {
    setSettingsSection(section);
    setSettingsOpen(true);
    setTopPopover(null);
  }

  const notifications = jobs.filter((job) => job.status === 'waiting_for_source').map((job) => ({
    id: job.job_id,
    title: job.title,
    detail: job.issue || job.stage_label
  }));

  return (
    <div className={`stage-b-app density-${preferences.density}`}>
      <aside className="xl-sidebar" aria-label="主导航">
        <button className="xl-brand" type="button" onClick={() => changePage('downloads')} aria-label="迅雷智取首页">
          <span className="xl-bird"><Bird size={19} strokeWidth={2.4} /></span>
          <strong>迅雷</strong>
        </button>
        <nav className="xl-nav">
          {navItems.map(({ key, label, icon: Icon }) => (
            <button className={`xl-nav-item ${page === key ? 'active' : ''}`} type="button" key={key} onClick={() => changePage(key)}>
              <Icon size={18} strokeWidth={1.8} />
              <span>{label}</span>
              {key === 'downloads' && jobs.some((job) => job.delivery_target !== 'cloud' && job.status !== 'completed') && <i className="nav-dot" />}
              {key === 'cloud' && jobs.some((job) => job.delivery_target === 'cloud' && job.status !== 'completed') && <i className="nav-dot" />}
              {key === 'links' && favoriteCount > 0 && <span className="nav-count">{favoriteCount}</span>}
            </button>
          ))}
        </nav>
        <div className="xl-sidebar-spacer" />
        <button className="xl-nav-item" type="button" onClick={() => openSettings('general')}><Settings size={18} /><span>设置</span></button>
        <div className="xl-version">迅雷智取 · Stage B</div>
      </aside>

      <main className="xl-main">
        <header className="xl-topbar">
          <div className="history-buttons">
            <button type="button" onClick={() => window.history.back()} aria-label="后退"><ChevronLeft size={18} /></button>
            <button className="forward" type="button" onClick={() => window.history.forward()} aria-label="前进"><ChevronLeft size={18} /></button>
            <button type="button" onClick={() => void syncData(true)} aria-label="刷新"><RefreshCw size={16} /></button>
          </div>
          <label className="xl-search">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={page === 'links' ? '搜索链接、文件名' : page === 'cloud' ? '搜索云盘任务' : '搜索任务、文件或粘贴链接'} />
          </label>
          <button className="xl-new" type="button" onClick={() => setNewTaskOpen(true)}><Plus size={17} />新建</button>
          <div className="xl-top-spacer" />
          <span className={`runtime-chip ${runtimeConnected ? 'online' : ''}`} title={runtimeConnected ? `Runtime ${runtimeInfo?.version ?? ''} · ${runtimeInfo?.provider ?? ''}` : 'Runtime 未连接'}><i />Runtime</span>
          <div className="top-popover-anchor">
            <button className="top-action" type="button" onClick={() => setTopPopover(topPopover === 'notifications' ? null : 'notifications')} aria-label="通知">
              <Bell size={17} />{preferences.notifications && issueCount > 0 && <span className="notice-badge">{issueCount}</span>}
            </button>
            {topPopover === 'notifications' && <NotificationPopover items={notifications} onOpen={(jobId) => { const job = jobs.find((entry) => entry.job_id === jobId); if (job) openJob(job); setTopPopover(null); }} />}
          </div>
          <div className="top-popover-anchor">
            <button className="user-chip" type="button" onClick={() => setTopPopover(topPopover === 'user' ? null : 'user')}>
              <span className="avatar"><UserRound size={15} /></span><span><strong>本地用户</strong><small>{runtimeConnected ? 'Runtime 在线' : '离线模式'}</small></span><ChevronDown size={14} />
            </button>
            {topPopover === 'user' && <UserPopover runtimeInfo={runtimeInfo} onSettings={() => openSettings('general')} onAbout={() => openSettings('about')} />}
          </div>
        </header>

        {page === 'links' ? (
          <LinkLibraryPage
            items={visibleLibrary}
            tab={libraryTab}
            filter={libraryFilter}
            view={libraryView}
            total={library.length}
            favorites={favoriteCount}
            query={query}
            onTab={setLibraryTab}
            onFilter={setLibraryFilter}
            onView={setLibraryView}
            onOpen={openLibraryItem}
            onFavorite={(item) => void toggleFavorite(item)}
          />
        ) : (
          <DownloadPage
            cloudOnly={page === 'cloud'}
            jobs={visibleJobs}
            tab={tab}
            activeCount={activeCount}
            completedCount={completedCount}
            totalSpeed={totalSpeed}
            query={query}
            selectedId={drawerOpen ? selectedId : ''}
            actionJobId={actionJobId}
            filter={taskFilter}
            activeFilterCount={activeFilterCount}
            filterOpen={filterOpen}
            batchMenuOpen={batchMenuOpen}
            onTab={switchTab}
            onRefresh={() => void syncData(true)}
            onSelect={openJob}
            onAction={(job) => void handleJobAction(job)}
            onFilterOpen={() => { setFilterOpen((value) => !value); setBatchMenuOpen(false); }}
            onFilter={setTaskFilter}
            onClearFilter={() => setTaskFilter({ kind: 'all', state: 'all', sort: 'newest' })}
            onBatchOpen={() => { setBatchMenuOpen((value) => !value); setFilterOpen(false); }}
            onPauseAll={() => void handleBatch('pause')}
            onResumeAll={() => void handleBatch('resume')}
          />
        )}
      </main>

      {drawerOpen && selectedJob && (
        <JobDrawer
          job={selectedJob}
          busy={actionJobId === selectedJob.job_id}
          showTechnical={preferences.showTechnical}
          onClose={() => setDrawerOpen(false)}
          onAction={() => void handleJobAction(selectedJob)}
          onCopy={(value) => void copyText(value)}
          onOpenSource={(value) => window.open(value, '_blank', 'noopener,noreferrer')}
        />
      )}

      {newTaskOpen && <NewTaskModal defaultTarget={preferences.defaultDelivery} onClose={() => setNewTaskOpen(false)} onCreate={createManualTask} />}
      {settingsOpen && (
        <SettingsModal
          section={settingsSection}
          preferences={preferences}
          runtimeInfo={runtimeInfo}
          runtimeConnected={runtimeConnected}
          onSection={setSettingsSection}
          onChange={setPreferences}
          onReset={() => setPreferences(defaultPreferences)}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {toast && <div className={`xl-toast ${toast.tone === 'warning' ? 'warning' : ''}`} role="status">{toast.message}</div>}
    </div>
  );
}

function DownloadPage(props: {
  cloudOnly: boolean;
  jobs: ResourceJobSnapshot[];
  tab: DownloadTab;
  activeCount: number;
  completedCount: number;
  totalSpeed: number;
  query: string;
  selectedId: string;
  actionJobId: string | null;
  filter: TaskFilter;
  activeFilterCount: number;
  filterOpen: boolean;
  batchMenuOpen: boolean;
  onTab: (tab: DownloadTab) => void;
  onRefresh: () => void;
  onSelect: (job: ResourceJobSnapshot) => void;
  onAction: (job: ResourceJobSnapshot) => void;
  onFilterOpen: () => void;
  onFilter: (filter: TaskFilter) => void;
  onClearFilter: () => void;
  onBatchOpen: () => void;
  onPauseAll: () => void;
  onResumeAll: () => void;
}) {
  const {
    cloudOnly, jobs, tab, activeCount, completedCount, totalSpeed, query, selectedId, actionJobId,
    filter, activeFilterCount, filterOpen, batchMenuOpen, onTab, onRefresh, onSelect, onAction,
    onFilterOpen, onFilter, onClearFilter, onBatchOpen, onPauseAll, onResumeAll
  } = props;
  return (
    <section className="xl-page download-page">
      {cloudOnly && (
        <div className="cloud-banner">
          <div className="cloud-art"><Cloud size={25} /></div>
          <div><strong>迅雷云盘</strong><span>智取任务可直接保存到云盘，资源目标与恢复上下文保持不变。</span></div>
          <div className="cloud-capacity"><strong>2.6 TB</strong><span>演示空间</span></div>
        </div>
      )}
      <div className="page-tabs">
        <button className={tab === 'active' ? 'active' : ''} type="button" onClick={() => onTab('active')}>{cloudOnly ? '保存中' : '下载中'} <span>{activeCount}</span></button>
        <button className={tab === 'completed' ? 'active' : ''} type="button" onClick={() => onTab('completed')}>已完成 <span>{completedCount}</span></button>
        <div className="page-tab-spacer" />
        <button className="icon-button" type="button" onClick={onRefresh} title="刷新"><RefreshCw size={16} /></button>
        <div className="popover-anchor">
          <button className="icon-button" type="button" onClick={onBatchOpen} title="更多"><MoreHorizontal size={18} /></button>
          {batchMenuOpen && <BatchMenu onRefresh={onRefresh} onPauseAll={onPauseAll} onResumeAll={onResumeAll} />}
        </div>
      </div>
      <div className="task-toolbar">
        <div className="speed-block">
          <strong>{tab === 'active' && totalSpeed > 0 ? formatSpeed(totalSpeed) : tab === 'active' ? activeCount : completedCount}</strong>
          <span>{tab === 'active' && totalSpeed > 0 ? (cloudOnly ? '云盘任务速度' : '当前总速度') : tab === 'active' ? '个进行中任务' : '个已完成任务'}</span>
        </div>
        <span className="task-toolbar-copy">{cloudOnly ? '保存到云盘的 ResourceJob' : '本地 ResourceJob 与普通下载统一管理'}</span>
        <div className="task-toolbar-actions">
          <span className="list-mode"><ListChecks size={15} />列表</span>
          <div className="popover-anchor">
            <button className={`filter-button ${activeFilterCount ? 'active' : ''}`} type="button" onClick={onFilterOpen}><Filter size={15} />筛选{activeFilterCount > 0 && <b>{activeFilterCount}</b>}</button>
            {filterOpen && <TaskFilterPopover filter={filter} onChange={onFilter} onClear={onClearFilter} />}
          </div>
        </div>
      </div>
      <div className="task-column-head"><span>文件名</span><span>进度 / 大小</span><span>状态</span><span /></div>
      <section className="task-list">
        {jobs.map((job) => (
          <TaskRow key={job.job_id} job={job} selected={selectedId === job.job_id} busy={actionJobId === job.job_id} onSelect={() => onSelect(job)} onAction={() => onAction(job)} />
        ))}
        {jobs.length === 0 && <EmptyTaskState cloudOnly={cloudOnly} query={query} tab={tab} />}
      </section>
    </section>
  );
}

function TaskRow({ job, selected, busy, onSelect, onAction }: { job: ResourceJobSnapshot; selected: boolean; busy: boolean; onSelect: () => void; onAction: () => void }) {
  const waiting = job.status === 'waiting_for_source';
  const completed = job.status === 'completed';
  const paused = job.status === 'paused';
  const planning = job.status === 'planning';
  const cloud = job.delivery_target === 'cloud';
  return (
    <article className={`xl-task-row ${selected ? 'selected' : ''} ${waiting ? 'issue' : ''}`}>
      <button className="task-click-area" type="button" onClick={onSelect}>
        <span className={`task-file-icon ${cloud ? 'cloud' : job.kind === 'zhiqu' ? 'zhiqu' : ''}`}>
          {cloud ? <Cloud size={20} /> : job.kind === 'zhiqu' ? <Sparkles size={20} /> : <HardDriveDownload size={20} />}
        </span>
        <span className="task-name-block">
          <span className="task-name-line"><strong>{job.title}</strong>{job.kind === 'zhiqu' && <i className="zhiqu-label">智取</i>}{cloud && <i className="cloud-label">云盘</i>}</span>
          <small>{job.subtitle}</small>
          <span className="task-origin">{job.source_page ? shortHost(job.source_page) : job.kind === 'normal' ? '手工任务' : 'Runtime 任务'}</span>
        </span>
        <span className="task-progress-block">
          {!completed ? <><span className="progress-line"><i className={waiting ? 'warning' : paused ? 'paused' : ''} style={{ width: `${job.progress}%` }} /></span><small>{formatBytes(job.downloaded_bytes)} / {formatBytes(job.total_bytes)} · {job.progress.toFixed(1)}%</small></> : <><strong>{formatBytes(job.total_bytes)}</strong><small>{formatDateTime(job.created_at)}</small></>}
        </span>
        <span className="task-status-block">
          {waiting ? <><strong className="warning-text">需要续取</strong><small>{job.stage_label}</small></> : completed ? <><strong>{cloud ? '已存云盘' : '已完成'}</strong><small>{job.destination || '交付完成'}</small></> : paused ? <><strong>已暂停</strong><small>{job.progress.toFixed(1)}%</small></> : planning ? <><strong>准备任务</strong><small>{job.stage_label}</small></> : <><strong>{job.speed_bytes_per_second > 0 ? formatSpeed(job.speed_bytes_per_second) : `${job.progress.toFixed(1)}%`}</strong><small>{job.eta_seconds ? `剩余 ${formatEta(job.eta_seconds)}` : job.stage_label}</small></>}
        </span>
      </button>
      <button className={`task-row-action ${waiting ? 'warning' : ''}`} type="button" onClick={onAction} disabled={busy} title={waiting ? '一键续取' : completed ? '复制交付位置' : paused ? '继续' : '暂停'}>
        {busy ? <LoaderCircle className="spin" size={17} /> : waiting ? <RefreshCw size={17} /> : completed ? cloud ? <Cloud size={17} /> : <FolderOpen size={17} /> : paused ? <Play size={17} /> : <CirclePause size={18} />}
      </button>
    </article>
  );
}

function TaskFilterPopover({ filter, onChange, onClear }: { filter: TaskFilter; onChange: (filter: TaskFilter) => void; onClear: () => void }) {
  return (
    <div className="task-filter-popover popover-card">
      <div className="popover-title"><strong>筛选任务</strong><button type="button" onClick={onClear}>重置</button></div>
      <FilterGroup title="任务类型" options={[['all', '全部'], ['zhiqu', '智取任务'], ['normal', '普通下载']]} value={filter.kind} onChange={(value) => onChange({ ...filter, kind: value as TaskKindFilter })} />
      <FilterGroup title="当前状态" options={[['all', '全部'], ['running', '进行中'], ['paused', '已暂停'], ['issue', '有问题']]} value={filter.state} onChange={(value) => onChange({ ...filter, state: value as TaskStateFilter })} />
      <FilterGroup title="排序" options={[['newest', '最新创建'], ['speed', '速度优先'], ['progress', '进度优先']]} value={filter.sort} onChange={(value) => onChange({ ...filter, sort: value as SortMode })} />
    </div>
  );
}

function FilterGroup({ title, options, value, onChange }: { title: string; options: Array<[string, string]>; value: string; onChange: (value: string) => void }) {
  return <div className="filter-group"><span>{title}</span><div>{options.map(([key, label]) => <button className={value === key ? 'active' : ''} type="button" key={key} onClick={() => onChange(key)}>{value === key && <Check size={12} />}{label}</button>)}</div></div>;
}

function BatchMenu({ onRefresh, onPauseAll, onResumeAll }: { onRefresh: () => void; onPauseAll: () => void; onResumeAll: () => void }) {
  return <div className="batch-menu popover-card"><button type="button" onClick={onRefresh}><RefreshCw size={15} />刷新任务</button><button type="button" onClick={onPauseAll}><CirclePause size={15} />暂停当前页任务</button><button type="button" onClick={onResumeAll}><Play size={15} />继续已暂停任务</button></div>;
}

function LinkLibraryPage(props: {
  items: LinkHistoryItem[];
  tab: LibraryTab;
  filter: LibraryFilter;
  view: LibraryView;
  total: number;
  favorites: number;
  query: string;
  onTab: (tab: LibraryTab) => void;
  onFilter: (filter: LibraryFilter) => void;
  onView: (view: LibraryView) => void;
  onOpen: (item: LinkHistoryItem) => void;
  onFavorite: (item: LinkHistoryItem) => void;
}) {
  const { items, tab, filter, view, total, favorites, query, onTab, onFilter, onView, onOpen, onFavorite } = props;
  const filters: Array<[LibraryFilter, string]> = [['all', '全部'], ['media', '音视频'], ['image', '图片'], ['document', '文档'], ['archive', '压缩包'], ['software', '软件']];
  return (
    <section className="xl-page link-library-page">
      <div className="library-tabs">
        <button className={tab === 'favorites' ? 'active' : ''} type="button" onClick={() => onTab('favorites')}><Star size={15} />收藏 <span>{favorites}</span></button>
        <button className={tab === 'history' ? 'active' : ''} type="button" onClick={() => onTab('history')}><History size={15} />历史 <span>{total}</span></button>
        <div className="library-sync"><Cloud size={13} />本机 Runtime 链接库</div>
      </div>
      <div className="library-toolbar">
        <div className="library-filters">{filters.map(([key, label]) => <button className={filter === key ? 'active' : ''} type="button" key={key} onClick={() => onFilter(key)}>{label}</button>)}</div>
        <div className="view-switch"><button className={view === 'list' ? 'active' : ''} type="button" onClick={() => onView('list')} title="列表"><List size={15} /></button><button className={view === 'grid' ? 'active' : ''} type="button" onClick={() => onView('grid')} title="网格"><LayoutGrid size={15} /></button></div>
      </div>
      {view === 'list' && items.length > 0 && <div className="library-columns"><span>文件名 / 来源</span><span>状态</span><span>添加时间</span><span /></div>}
      <div className={view === 'grid' ? 'library-grid' : 'library-list'}>
        {items.map((item) => <LibraryItem key={item.history_id} item={item} view={view} onOpen={() => onOpen(item)} onFavorite={() => onFavorite(item)} />)}
        {items.length === 0 && <div className="library-empty"><span className="empty-library-icon">{tab === 'favorites' ? <Star size={28} /> : <Link2 size={28} />}</span><strong>{query ? '没有匹配结果' : tab === 'favorites' ? '还没有收藏' : '暂无链接历史'}</strong><span>{tab === 'favorites' ? '可在智取扩展的资源计划中直接收藏，也可从历史记录点星标。' : '创建 ResourceJob 后，主来源会自动进入这里。'}</span></div>}
      </div>
    </section>
  );
}

function LibraryItem({ item, view, onOpen, onFavorite }: { item: LinkHistoryItem; view: LibraryView; onOpen: () => void; onFavorite: () => void }) {
  const kind = classifyLibrary(item);
  return (
    <article className={`library-item ${view}`}>
      <button className="library-open" type="button" onClick={onOpen}>
        <span className={`library-file-icon ${kind}`}>{libraryIcon(kind)}</span>
        <span className="library-main"><strong>{item.title}</strong><span><Link2 size={11} />{item.display_link}</span><small>{item.size_bytes ? formatBytes(item.size_bytes) : '大小未知'}{item.delivery_target ? ` · ${item.delivery_target === 'cloud' ? '云盘任务' : '本地任务'}` : ' · 仅收藏'}</small></span>
        <span className={`library-status ${item.status}`}><strong>{libraryStatusLabel(item)}</strong><small>{libraryTypeLabel(item, kind)}</small></span>
        <span className="library-time">{formatDateTime(item.added_at)}</span>
      </button>
      <button className={`favorite-button ${item.favorite ? 'active' : ''}`} type="button" onClick={onFavorite} title={item.favorite ? '取消收藏' : '收藏'}><Star size={16} fill={item.favorite ? 'currentColor' : 'none'} /></button>
    </article>
  );
}

function JobDrawer({ job, busy, showTechnical, onClose, onAction, onCopy, onOpenSource }: { job: ResourceJobSnapshot; busy: boolean; showTechnical: boolean; onClose: () => void; onAction: () => void; onCopy: (value: string) => void; onOpenSource: (value: string) => void }) {
  const waiting = job.status === 'waiting_for_source';
  const completed = job.status === 'completed';
  const paused = job.status === 'paused';
  const cloud = job.delivery_target === 'cloud';
  const selectedItems = job.selected_items?.length ? job.selected_items : [job.subtitle];
  return (
    <aside className="job-drawer" aria-label="任务详情">
      <div className="drawer-header">
        <span className={`task-file-icon large ${cloud ? 'cloud' : job.kind === 'zhiqu' ? 'zhiqu' : ''}`}>{cloud ? <Cloud size={23} /> : job.kind === 'zhiqu' ? <Sparkles size={23} /> : <HardDriveDownload size={23} />}</span>
        <div><small>{job.kind === 'zhiqu' ? '迅雷智取任务' : '普通下载任务'}</small><h2>{job.title}</h2><span>{job.stage_label}</span></div>
        <button type="button" onClick={onClose}><X size={18} /></button>
      </div>
      <div className="drawer-progress-card"><div><span>{cloud ? '云盘交付进度' : '总体进度'}</span><strong>{job.progress.toFixed(1)}%</strong></div><span className="progress-line large"><i className={waiting ? 'warning' : paused ? 'paused' : completed ? 'complete' : ''} style={{ width: `${job.progress}%` }} /></span><small>{formatBytes(job.downloaded_bytes)} / {formatBytes(job.total_bytes)}{job.speed_bytes_per_second > 0 ? ` · ${formatSpeed(job.speed_bytes_per_second)}` : ''}</small></div>

      <DrawerSection title="目标">
        <p className="drawer-copy">{job.plan_overview || job.subtitle}</p>
        {job.source_page && <div className="source-line"><span><Link2 size={14} />{job.source_page}</span><button type="button" onClick={() => onOpenSource(job.source_page!)}><ExternalLink size={14} /></button></div>}
      </DrawerSection>

      <DrawerSection title="选择">
        <div className="selected-chips">{selectedItems.map((item) => <span key={item}><Check size={12} />{item}</span>)}</div>
        <div className="selection-summary"><span>来源 <strong>{job.source_count}</strong></span><span>备用 <strong>{job.alternative_count ?? 0}</strong></span><span>排除 <strong>{job.excluded_count}</strong></span></div>
      </DrawerSection>

      <DrawerSection title="问题">
        {waiting ? <div className="issue-card"><TriangleAlert size={17} /><div><strong>当前来源不可用</strong><p>{job.issue || '任务上下文已保留，可进入重新智取。'}</p></div></div> : <div className="healthy-card"><ShieldCheck size={17} /><div><strong>当前没有阻断问题</strong><p>{completed ? '任务已完成交付。' : 'Runtime 正常持有任务上下文并持续同步状态。'}</p></div></div>}
      </DrawerSection>

      <DrawerSection title="下一步">
        <div className={`next-step-card ${waiting ? 'warning' : ''}`}><strong>{waiting ? '重新获取可信来源' : completed ? (cloud ? '查看云盘交付位置' : '查看本地交付位置') : paused ? '继续当前任务' : cloud ? '继续保存到云盘' : '继续托管下载'}</strong><p>{waiting ? '优先使用已保存备用来源；仍不可用时再携带原任务目标回到浏览器。' : completed ? '任务完成后仍保留来源历史与智取选择摘要。' : '阶段 B 负责状态与交互闭环，真实下载执行将在后续下载引擎阶段接入。'}</p></div>
      </DrawerSection>

      <DrawerSection title="交付">
        <DetailFact icon={cloud ? <Cloud size={15} /> : <HardDrive size={15} />} label={cloud ? '云盘位置' : '本地位置'} value={job.destination || '未设置'} action={<button type="button" onClick={() => onCopy(job.destination || '')}><Copy size={13} />复制</button>} />
        {showTechnical && <DetailFact icon={<Activity size={15} />} label="Runtime" value={`${job.execution_mode === 'download_engine' ? 'Download Engine' : 'Stage B 演示执行'} · ${job.job_id}`} />}
      </DrawerSection>

      <div className="drawer-footer"><button className={`drawer-main-action ${waiting ? 'warning' : ''}`} type="button" onClick={onAction} disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : waiting ? <RefreshCw size={17} /> : completed ? cloud ? <Cloud size={17} /> : <FolderOpen size={17} /> : paused ? <Play size={17} /> : <CirclePause size={17} />}{waiting ? '一键续取' : completed ? '复制交付位置' : paused ? '继续任务' : '暂停任务'}</button></div>
    </aside>
  );
}

function DrawerSection({ title, children }: { title: string; children: ReactNode }) { return <section className="drawer-section"><h3>{title}</h3><div>{children}</div></section>; }
function DetailFact({ icon, label, value, action }: { icon: ReactNode; label: string; value: string; action?: ReactNode }) { return <div className="detail-fact"><span>{icon}</span><div><small>{label}</small><strong>{value}</strong></div>{action}</div>; }

function NotificationPopover({ items, onOpen }: { items: Array<{ id: string; title: string; detail: string }>; onOpen: (id: string) => void }) {
  return <div className="notification-popover popover-card"><div className="popover-title"><strong>通知</strong><span>{items.length ? `${items.length} 条需处理` : '暂无新通知'}</span></div>{items.length ? items.map((item) => <button type="button" key={item.id} onClick={() => onOpen(item.id)}><span className="notification-icon"><TriangleAlert size={15} /></span><span><strong>{item.title}</strong><small>{item.detail}</small></span></button>) : <div className="popover-empty"><Bell size={21} />当前没有需要处理的任务</div>}</div>;
}

function UserPopover({ runtimeInfo, onSettings, onAbout }: { runtimeInfo: RuntimeInfo | null; onSettings: () => void; onAbout: () => void }) {
  return <div className="user-popover popover-card"><div className="user-profile"><span className="avatar large"><UserRound size={20} /></span><div><strong>本地用户</strong><span>本地 Runtime 模式</span></div></div><div className="user-runtime"><span>模型适配器</span><strong>{runtimeInfo?.provider || '未连接'}</strong></div><button type="button" onClick={onSettings}><Settings size={15} />设置</button><button type="button" onClick={onAbout}><Info size={15} />关于迅雷智取</button></div>;
}

function NewTaskModal({ defaultTarget, onClose, onCreate }: { defaultTarget: DeliveryTarget; onClose: () => void; onCreate: (payload: ManualJobCreateRequest) => Promise<void> }) {
  const [links, setLinks] = useState('');
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState<DeliveryTarget>(defaultTarget);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    const parsed = links.split(/\s+/).map((value) => value.trim()).filter(Boolean);
    if (!parsed.length) { setError('请至少粘贴一个 HTTP / Magnet 链接'); return; }
    setBusy(true); setError('');
    try {
      await onCreate({ schema_version: '0.1', links: parsed, title: title.trim() || null, delivery_target: target });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '创建任务失败');
      setBusy(false);
    }
  }
  return <Modal title="新建任务" onClose={onClose}><div className="new-task-modal"><label><span>下载链接</span><textarea value={links} onChange={(event) => setLinks(event.target.value)} placeholder="粘贴 HTTP、HTTPS 或 Magnet；多个链接可换行" autoFocus /></label><label><span>任务名称 <small>可选</small></span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="默认从链接识别文件名" /></label><div className="new-target"><span>交付到</span><div><button className={target === 'local' ? 'active' : ''} type="button" onClick={() => setTarget('local')}><HardDrive size={17} /><span><strong>本地</strong><small>D:/Downloads</small></span></button><button className={target === 'cloud' ? 'active' : ''} type="button" onClick={() => setTarget('cloud')}><Cloud size={17} /><span><strong>云盘</strong><small>迅雷云盘 / 智取下载</small></span></button></div></div><p className="modal-tip"><Sparkles size={14} />复杂网页、版本选择和多资源场景仍建议使用浏览器“迅雷智取 Lens”。</p>{error && <div className="modal-error">{error}</div>}<div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button className="primary" type="button" onClick={() => void submit()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}创建任务</button></div></div></Modal>;
}

function SettingsModal({ section, preferences, runtimeInfo, runtimeConnected, onSection, onChange, onReset, onClose }: { section: SettingsSection; preferences: Preferences; runtimeInfo: RuntimeInfo | null; runtimeConnected: boolean; onSection: (section: SettingsSection) => void; onChange: (preferences: Preferences) => void; onReset: () => void; onClose: () => void }) {
  const sections: Array<[SettingsSection, string]> = [['general', '常规'], ['download', '下载'], ['notifications', '通知'], ['about', '关于']];
  return <Modal title="设置" wide onClose={onClose}><div className="settings-layout"><nav>{sections.map(([key, label]) => <button className={section === key ? 'active' : ''} type="button" key={key} onClick={() => onSection(key)}>{label}</button>)}</nav><section className="settings-content">{section === 'general' && <><SettingsHeading title="常规" detail="任务中心显示与同步" /><SettingRow title="自动刷新" detail="Runtime 任务快照刷新频率"><select value={preferences.refreshMs} onChange={(event) => onChange({ ...preferences, refreshMs: Number(event.target.value) as Preferences['refreshMs'] })}><option value={1500}>1.5 秒</option><option value={3000}>3 秒</option><option value={5000}>5 秒</option></select></SettingRow><SettingRow title="列表密度" detail="更接近桌面客户端下载密度"><Segmented value={preferences.density} options={[['comfortable', '标准'], ['compact', '紧凑']]} onChange={(value) => onChange({ ...preferences, density: value as Preferences['density'] })} /></SettingRow><SettingRow title="技术状态" detail="在详情中显示 Runtime 执行模式"><Toggle checked={preferences.showTechnical} onChange={(checked) => onChange({ ...preferences, showTechnical: checked })} /></SettingRow></>}{section === 'download' && <><SettingsHeading title="下载" detail="阶段 B 的默认交付偏好" /><SettingRow title="新建任务默认位置" detail="只影响任务中心手工新建"><Segmented value={preferences.defaultDelivery} options={[['local', '本地'], ['cloud', '云盘']]} onChange={(value) => onChange({ ...preferences, defaultDelivery: value as DeliveryTarget })} /></SettingRow><div className="settings-note"><HardDrive size={16} /><div><strong>本地默认目录</strong><span>D:/Downloads</span></div></div><div className="settings-note"><Cloud size={16} /><div><strong>云盘默认目录</strong><span>迅雷云盘 / 智取下载</span></div></div></>}{section === 'notifications' && <><SettingsHeading title="通知" detail="只保留与任务交付有关的提醒" /><SettingRow title="任务异常提醒" detail="来源失效时在右上角显示提醒"><Toggle checked={preferences.notifications} onChange={(checked) => onChange({ ...preferences, notifications: checked })} /></SettingRow></>}{section === 'about' && <><SettingsHeading title="关于迅雷智取" detail="闭环资源交付 Agent" /><div className="about-card"><span className="xl-bird large"><Bird size={26} /></span><div><strong>迅雷智取</strong><span>Stage B · 高保真任务中心与任务数据流</span></div></div><div className="about-grid"><span>Runtime</span><strong>{runtimeConnected ? '已连接' : '未连接'}</strong><span>版本</span><strong>{runtimeInfo?.version || '0.1.0'}</strong><span>Model Provider</span><strong>{runtimeInfo?.provider || '—'}</strong></div></>}<button className="reset-settings" type="button" onClick={onReset}>恢复默认设置</button></section></div></Modal>;
}

function SettingsHeading({ title, detail }: { title: string; detail: string }) { return <div className="settings-heading"><h3>{title}</h3><p>{detail}</p></div>; }
function SettingRow({ title, detail, children }: { title: string; detail: string; children: ReactNode }) { return <div className="setting-row"><div><strong>{title}</strong><span>{detail}</span></div>{children}</div>; }
function Segmented({ value, options, onChange }: { value: string; options: Array<[string, string]>; onChange: (value: string) => void }) { return <div className="segmented">{options.map(([key, label]) => <button className={value === key ? 'active' : ''} type="button" key={key} onClick={() => onChange(key)}>{label}</button>)}</div>; }
function Toggle({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) { return <button className={`toggle ${checked ? 'on' : ''}`} type="button" onClick={() => onChange(!checked)} aria-pressed={checked}><i /></button>; }

function Modal({ title, wide = false, onClose, children }: { title: string; wide?: boolean; onClose: () => void; children: ReactNode }) { return <div className="modal-backdrop" role="presentation"><div className={`modal-shell ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}><div className="modal-header"><strong>{title}</strong><button type="button" onClick={onClose}><X size={18} /></button></div>{children}</div></div>; }

function EmptyTaskState({ cloudOnly, query, tab }: { cloudOnly: boolean; query: string; tab: DownloadTab }) { return <div className="empty-task"><span>{cloudOnly ? <Cloud size={29} /> : <FileClock size={29} />}</span><strong>{query ? '没有匹配任务' : cloudOnly ? '暂无云盘任务' : tab === 'active' ? '暂无下载任务' : '暂无已完成任务'}</strong><small>{query ? '调整关键词或筛选条件。' : cloudOnly ? '在智取扩展或新建任务中选择保存到云盘。' : '新任务会出现在这里。'}</small></div>; }

function classifyLibrary(item: LinkHistoryItem): LibraryFilter {
  if (item.resource_type === 'video' || item.resource_type === 'audio' || item.link_type === 'media') return 'media';
  if (item.resource_type === 'image') return 'image';
  if (item.resource_type === 'archive') return 'archive';
  if (item.resource_type === 'software') return 'software';
  const name = item.title.toLowerCase();
  if (/\.(mp4|mkv|m3u8|mp3|flac|aac|wav)$/i.test(name)) return 'media';
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)) return 'image';
  if (/\.(pdf|docx?|xlsx?|pptx?|txt|md)$/i.test(name)) return 'document';
  if (/\.(zip|rar|7z|tar|gz|xz)$/i.test(name)) return 'archive';
  if (/\.(exe|msi|dmg|pkg|deb|rpm)$/i.test(name)) return 'software';
  return 'all';
}
function libraryIcon(kind: LibraryFilter): ReactNode { if (kind === 'image') return <FileImage size={20} />; if (kind === 'document') return <FileText size={20} />; if (kind === 'archive') return <Archive size={20} />; if (kind === 'software') return <HardDriveDownload size={20} />; if (kind === 'media') return <Play size={20} />; return <Link2 size={20} />; }
function libraryTypeLabel(item: LinkHistoryItem, kind: LibraryFilter): string { if (item.link_type === 'magnet') return 'Magnet'; if (kind === 'media') return '音视频'; if (kind === 'image') return '图片'; if (kind === 'document') return '文档'; if (kind === 'archive') return '压缩包'; if (kind === 'software') return '软件'; return '链接'; }
function libraryStatusLabel(item: LinkHistoryItem): string { if (item.status === 'failed') return '链接失效'; if (item.status === 'completed') return '已完成'; if (item.status === 'saved') return '已收藏'; return '使用中'; }
function shortHost(value: string): string { try { return new URL(value).host; } catch { return value; } }
function pageFromHash(): PageKey { const value = window.location.hash.replace(/^#\//, ''); return value === 'cloud' || value === 'links' ? value : 'downloads'; }
function loadPreferences(): Preferences { try { const raw = window.localStorage.getItem(SETTINGS_KEY); return raw ? { ...defaultPreferences, ...JSON.parse(raw) as Partial<Preferences> } : defaultPreferences; } catch { return defaultPreferences; } }
function formatBytes(value: number): string { if (!Number.isFinite(value) || value <= 0) return '0 B'; const units = ['B', 'KB', 'MB', 'GB', 'TB']; const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1); const amount = value / 1024 ** index; return `${amount >= 100 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`; }
function formatSpeed(value: number): string { if (!Number.isFinite(value) || value <= 0) return '0 KB/s'; if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(value >= 10 * 1024 ** 2 ? 1 : 2)} MB/s`; return `${(value / 1024).toFixed(1)} KB/s`; }
function formatEta(seconds: number): string { if (seconds < 60) return `${seconds} 秒`; const minutes = Math.floor(seconds / 60); const rest = seconds % 60; return `${minutes}:${String(rest).padStart(2, '0')}`; }
function formatDateTime(value: string): string { const date = new Date(value); if (Number.isNaN(date.getTime())) return value; return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date); }
