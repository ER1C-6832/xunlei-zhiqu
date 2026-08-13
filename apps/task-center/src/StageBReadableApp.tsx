import type {
  DeliveryTarget,
  LinkHistoryItem,
  ManualJobCreateRequest,
  ResourceJobSnapshot
} from '@xunlei-zhiqu/contracts';
import {
  Bell,
  Bird,
  Check,
  ChevronDown,
  ChevronLeft,
  CirclePause,
  Cloud,
  Copy,
  Download,
  FileArchive,
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
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { taskService, type RuntimeInfo } from './services/taskServiceClient';

const SETTINGS_KEY = 'xunlei-zhiqu.stage-b.readable.preferences';
const CLOUD_TOTAL_BYTES = 3 * 1024 ** 4;

type PageKey = 'downloads' | 'cloud' | 'links';
type DownloadTab = 'active' | 'completed';
type LibraryTab = 'favorites' | 'history';
type LibraryFilter = 'all' | 'media' | 'image' | 'document' | 'archive' | 'software';
type LibraryView = 'list' | 'grid';
type TaskKindFilter = 'all' | 'zhiqu' | 'normal';
type TaskStateFilter = 'all' | 'running' | 'paused' | 'issue';
type SortMode = 'newest' | 'progress' | 'speed';
type ToastState = { message: string; tone?: 'normal' | 'warning' } | null;
type TaskFilter = { kind: TaskKindFilter; state: TaskStateFilter; sort: SortMode };
type Preferences = { refreshMs: 1500 | 3000 | 5000; showTechnical: boolean; notifications: boolean };

const defaultPreferences: Preferences = { refreshMs: 1500, showTechnical: true, notifications: true };

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
    plan_overview: '节点 A 已选出当前设备适合的 Windows x64 版本，并保留必要附件与备用来源。',
    selected_items: ['Windows x64 便携版', '中文语言包', 'SHA-256 校验文件'],
    alternative_count: 2,
    source_page: 'https://example.test/downloads'
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
  },
  {
    job_id: 'job_cloud_001',
    title: 'Open Media Course · 1080p',
    subtitle: '12 个视频 · 中文字幕 · 已保存到云盘',
    kind: 'zhiqu',
    status: 'completed',
    progress: 100,
    downloaded_bytes: 7_643_000_000,
    total_bytes: 7_643_000_000,
    speed_bytes_per_second: 0,
    eta_seconds: null,
    stage_label: '已保存到迅雷云盘',
    next_action: 'open',
    source_count: 2,
    excluded_count: 8,
    created_at: new Date(Date.now() - 72 * 60_000).toISOString(),
    destination: '迅雷云盘/智取下载/Open Media Course',
    delivery_target: 'cloud',
    execution_mode: 'demo',
    resource_type: 'video',
    plan_overview: '智取结果已写入云盘交付记录，不在任务中心模拟“云盘下载速度”。',
    selected_items: ['1080p 主视频组', '简体中文字幕'],
    alternative_count: 2,
    source_page: 'https://media.example.test/course'
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
  }
];

export function StageBReadableApp() {
  const [page, setPage] = useState<PageKey>(() => pageFromHash());
  const [jobs, setJobs] = useState<ResourceJobSnapshot[]>(fallbackJobs);
  const [library, setLibrary] = useState<LinkHistoryItem[]>(fallbackLibrary);
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null);
  const [runtimeConnected, setRuntimeConnected] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [tab, setTab] = useState<DownloadTab>('active');
  const [libraryTab, setLibraryTab] = useState<LibraryTab>('history');
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>('all');
  const [libraryView, setLibraryView] = useState<LibraryView>('list');
  const [query, setQuery] = useState('');
  const [taskFilter, setTaskFilter] = useState<TaskFilter>({ kind: 'all', state: 'all', sort: 'newest' });
  const [filterOpen, setFilterOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [topPopover, setTopPopover] = useState<'user' | 'notifications' | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [actionJobId, setActionJobId] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<Preferences>(() => loadPreferences());

  const syncData = useCallback(async (showError = false) => {
    try {
      const [nextJobs, nextLibrary, nextRuntimeInfo] = await Promise.all([
        taskService.listJobs(),
        taskService.listLinkLibrary(),
        taskService.getRuntimeInfo()
      ]);
      setJobs(nextJobs);
      setLibrary(nextLibrary);
      setRuntimeInfo(nextRuntimeInfo);
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
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const localJobs = useMemo(() => jobs.filter((job) => job.delivery_target !== 'cloud'), [jobs]);
  const cloudJobs = useMemo(() => jobs.filter((job) => job.delivery_target === 'cloud'), [jobs]);
  const activeLocalCount = localJobs.filter((job) => job.status !== 'completed').length;
  const completedLocalCount = localJobs.filter((job) => job.status === 'completed').length;
  const totalSpeed = localJobs.filter((job) => job.status === 'downloading').reduce((sum, job) => sum + job.speed_bytes_per_second, 0);
  const favoriteCount = library.filter((item) => item.favorite).length;
  const issueCount = jobs.filter((job) => job.status === 'waiting_for_source').length;
  const cloudUsedBytes = cloudJobs.reduce((sum, job) => sum + Math.max(job.total_bytes, job.downloaded_bytes), 0);
  const cloudRemainingBytes = Math.max(0, CLOUD_TOTAL_BYTES - cloudUsedBytes);
  const cloudUsedPercent = Math.min(100, cloudUsedBytes / CLOUD_TOTAL_BYTES * 100);

  const visibleLocalJobs = useMemo(() => {
    const lower = query.trim().toLowerCase();
    const filtered = localJobs.filter((job) => {
      const matchesTab = tab === 'completed' ? job.status === 'completed' : job.status !== 'completed';
      const matchesQuery = !lower || `${job.title} ${job.subtitle} ${job.destination ?? ''}`.toLowerCase().includes(lower);
      const matchesKind = taskFilter.kind === 'all' || job.kind === taskFilter.kind;
      const matchesState = taskFilter.state === 'all'
        || (taskFilter.state === 'running' && ['planning', 'downloading', 'verifying'].includes(job.status))
        || (taskFilter.state === 'paused' && job.status === 'paused')
        || (taskFilter.state === 'issue' && job.status === 'waiting_for_source');
      return matchesTab && matchesQuery && matchesKind && matchesState;
    });
    return sortJobs(filtered, taskFilter.sort);
  }, [localJobs, query, tab, taskFilter]);

  const visibleCloudJobs = useMemo(() => {
    const lower = query.trim().toLowerCase();
    return cloudJobs
      .filter((job) => !lower || `${job.title} ${job.subtitle} ${job.destination ?? ''}`.toLowerCase().includes(lower))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [cloudJobs, query]);

  const visibleLibrary = useMemo(() => {
    const lower = query.trim().toLowerCase();
    return library
      .filter((item) => libraryTab === 'history' || Boolean(item.favorite))
      .filter((item) => libraryFilter === 'all' || classifyLibrary(item) === libraryFilter)
      .filter((item) => !lower || `${item.title} ${item.display_link} ${item.source_page ?? ''}`.toLowerCase().includes(lower))
      .sort((a, b) => new Date(b.added_at).getTime() - new Date(a.added_at).getTime());
  }, [library, libraryFilter, libraryTab, query]);

  function changePage(next: PageKey) {
    setPage(next);
    setQuery('');
    setSelectedId('');
    setFilterOpen(false);
    setBatchOpen(false);
    setTopPopover(null);
    window.location.hash = `/${next}`;
  }

  function toggleTask(jobId: string) {
    setSelectedId((current) => current === jobId ? '' : jobId);
  }

  async function handleJobAction(job: ResourceJobSnapshot) {
    if (job.delivery_target === 'cloud') {
      setToast({ message: `云盘位置：${job.destination || '迅雷云盘 / 智取下载'}` });
      return;
    }
    if (job.status === 'waiting_for_source') {
      setToast({ message: '一键续取入口已保留，真实重新智取在阶段 F 接入。', tone: 'warning' });
      return;
    }
    if (job.status === 'completed') {
      await copyText(job.destination || '未设置交付位置', '本地交付位置已复制');
      return;
    }
    const operation = job.status === 'paused' ? 'resume' : 'pause';
    setActionJobId(job.job_id);
    try {
      const updated = operation === 'pause'
        ? await taskService.pauseJob(job.job_id)
        : await taskService.resumeJob(job.job_id);
      setJobs((current) => current.map((item) => item.job_id === updated.job_id ? updated : item));
      setToast({ message: operation === 'pause' ? '任务已暂停' : '任务已恢复' });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : '任务操作失败', tone: 'warning' });
    } finally {
      setActionJobId(null);
    }
  }

  async function handleBatch(operation: 'pause' | 'resume') {
    const targets = localJobs.filter((job) => operation === 'pause'
      ? ['planning', 'downloading', 'verifying'].includes(job.status)
      : job.status === 'paused');
    setBatchOpen(false);
    if (!targets.length) {
      setToast({ message: operation === 'pause' ? '当前没有可暂停任务' : '当前没有已暂停任务' });
      return;
    }
    try {
      await Promise.all(targets.map((job) => operation === 'pause'
        ? taskService.pauseJob(job.job_id)
        : taskService.resumeJob(job.job_id)));
      await syncData();
      setToast({ message: operation === 'pause' ? `已暂停 ${targets.length} 个任务` : `已恢复 ${targets.length} 个任务` });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : '批量操作失败', tone: 'warning' });
    }
  }

  async function toggleFavorite(item: LinkHistoryItem) {
    try {
      const updated = await taskService.setFavorite(item.history_id, { favorite: !item.favorite });
      setLibrary((current) => current.map((entry) => entry.history_id === updated.history_id ? updated : entry));
      setToast({ message: updated.favorite ? '已加入收藏' : '已取消收藏' });
    } catch (error) {
      setToast({ message: error instanceof Error ? `收藏失败：${error.message}` : '收藏失败', tone: 'warning' });
    }
  }

  async function createManualTask(payload: ManualJobCreateRequest) {
    const job = await taskService.createManualJob(payload);
    await syncData();
    setNewTaskOpen(false);
    changePage(job.delivery_target === 'cloud' ? 'cloud' : 'downloads');
    setSelectedId(job.job_id);
    setToast({ message: job.delivery_target === 'cloud' ? '已加入云盘' : '任务已创建' });
  }

  async function copyText(text: string, message = '已复制') {
    try {
      await navigator.clipboard.writeText(text);
      setToast({ message });
    } catch {
      setToast({ message: text });
    }
  }

  const notifications = jobs.filter((job) => job.status === 'waiting_for_source');

  return (
    <div className="readable-stage-b">
      <aside className="rr-sidebar">
        <button className="rr-brand" type="button" onClick={() => changePage('downloads')}>
          <Bird size={28} strokeWidth={2.2} />
          <strong>迅雷</strong>
        </button>
        <nav className="rr-nav">
          <NavButton active={page === 'downloads'} icon={<Download size={18} />} label="下载" badge={activeLocalCount || undefined} onClick={() => changePage('downloads')} />
          <NavButton active={page === 'cloud'} icon={<Cloud size={18} />} label="云盘" badge={cloudJobs.length || undefined} onClick={() => changePage('cloud')} />
          <NavButton active={page === 'links'} icon={<Link2 size={18} />} label="链接库" badge={favoriteCount || undefined} onClick={() => changePage('links')} />
        </nav>
        <div className="rr-sidebar-spacer" />
        <NavButton active={false} icon={<Settings size={18} />} label="设置" onClick={() => setSettingsOpen(true)} />
      </aside>

      <main className="rr-main">
        <header className="rr-topbar">
          <div className="rr-history-buttons">
            <button type="button" aria-label="后退" onClick={() => window.history.back()}><ChevronLeft size={19} /></button>
            <button className="forward" type="button" aria-label="前进" onClick={() => window.history.forward()}><ChevronLeft size={19} /></button>
            <button type="button" aria-label="刷新" onClick={() => void syncData(true)}><RefreshCw size={17} /></button>
          </div>
          <label className="rr-search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={page === 'links' ? '搜索链接、文件名' : page === 'cloud' ? '搜索云盘文件' : '搜索任务、文件名'} /></label>
          <button className="rr-new" type="button" onClick={() => setNewTaskOpen(true)}><Plus size={18} />新建</button>
          <div className="rr-top-spacer" />
          <span className={`rr-runtime ${runtimeConnected ? 'online' : ''}`}><i />Runtime</span>
          <div className="rr-popover-anchor">
            <button className="rr-top-icon" type="button" aria-label="通知" onClick={() => setTopPopover(topPopover === 'notifications' ? null : 'notifications')}>
              <Bell size={18} />{preferences.notifications && issueCount > 0 && <b>{issueCount}</b>}
            </button>
            {topPopover === 'notifications' && <NotificationPopover jobs={notifications} onOpen={(job) => { changePage(job.delivery_target === 'cloud' ? 'cloud' : 'downloads'); setSelectedId(job.job_id); }} />}
          </div>
          <div className="rr-popover-anchor">
            <button className="rr-user" type="button" onClick={() => setTopPopover(topPopover === 'user' ? null : 'user')}>
              <span><UserRound size={17} /></span><div><strong>本地用户</strong><small>{runtimeConnected ? 'Runtime 在线' : '离线模式'}</small></div><ChevronDown size={15} />
            </button>
            {topPopover === 'user' && <UserPopover runtimeInfo={runtimeInfo} onSettings={() => { setSettingsOpen(true); setTopPopover(null); }} />}
          </div>
        </header>

        {page === 'downloads' && (
          <DownloadPage
            jobs={visibleLocalJobs}
            tab={tab}
            activeCount={activeLocalCount}
            completedCount={completedLocalCount}
            totalSpeed={totalSpeed}
            selectedId={selectedId}
            actionJobId={actionJobId}
            filter={taskFilter}
            filterOpen={filterOpen}
            batchOpen={batchOpen}
            onTab={(next) => { setTab(next); setSelectedId(''); }}
            onSelect={toggleTask}
            onAction={(job) => void handleJobAction(job)}
            onFilterOpen={() => { setFilterOpen((value) => !value); setBatchOpen(false); }}
            onFilter={setTaskFilter}
            onBatchOpen={() => { setBatchOpen((value) => !value); setFilterOpen(false); }}
            onRefresh={() => void syncData(true)}
            onPauseAll={() => void handleBatch('pause')}
            onResumeAll={() => void handleBatch('resume')}
            onCopy={(value) => void copyText(value)}
            showTechnical={preferences.showTechnical}
          />
        )}

        {page === 'cloud' && (
          <CloudPage
            jobs={visibleCloudJobs}
            usedBytes={cloudUsedBytes}
            remainingBytes={cloudRemainingBytes}
            usedPercent={cloudUsedPercent}
            selectedId={selectedId}
            onSelect={toggleTask}
            onCopy={(value) => void copyText(value)}
            showTechnical={preferences.showTechnical}
          />
        )}

        {page === 'links' && (
          <LinkLibraryPage
            items={visibleLibrary}
            tab={libraryTab}
            filter={libraryFilter}
            view={libraryView}
            total={library.length}
            favorites={favoriteCount}
            onTab={setLibraryTab}
            onFilter={setLibraryFilter}
            onView={setLibraryView}
            onFavorite={(item) => void toggleFavorite(item)}
            onOpen={(item) => {
              const job = item.job_id ? jobs.find((candidate) => candidate.job_id === item.job_id) : null;
              if (job) {
                changePage(job.delivery_target === 'cloud' ? 'cloud' : 'downloads');
                if (job.delivery_target !== 'cloud') setTab(job.status === 'completed' ? 'completed' : 'active');
                setSelectedId(job.job_id);
              } else if (item.source_page?.startsWith('http')) {
                window.open(item.source_page, '_blank', 'noopener,noreferrer');
              } else {
                void copyText(item.display_link, '资源链接已复制');
              }
            }}
          />
        )}
      </main>

      {newTaskOpen && <NewTaskModal onClose={() => setNewTaskOpen(false)} onCreate={createManualTask} />}
      {settingsOpen && <SettingsModal preferences={preferences} runtimeInfo={runtimeInfo} onChange={setPreferences} onClose={() => setSettingsOpen(false)} />}
      {toast && <div className={`rr-toast ${toast.tone === 'warning' ? 'warning' : ''}`} role="status">{toast.message}</div>}
    </div>
  );
}

function NavButton({ active, icon, label, badge, onClick }: { active: boolean; icon: ReactNode; label: string; badge?: number; onClick: () => void }) {
  return <button className={`rr-nav-button ${active ? 'active' : ''}`} type="button" onClick={onClick}>{icon}<span>{label}</span>{badge ? <b>{badge}</b> : null}</button>;
}

function DownloadPage(props: {
  jobs: ResourceJobSnapshot[];
  tab: DownloadTab;
  activeCount: number;
  completedCount: number;
  totalSpeed: number;
  selectedId: string;
  actionJobId: string | null;
  filter: TaskFilter;
  filterOpen: boolean;
  batchOpen: boolean;
  onTab: (tab: DownloadTab) => void;
  onSelect: (jobId: string) => void;
  onAction: (job: ResourceJobSnapshot) => void;
  onFilterOpen: () => void;
  onFilter: (filter: TaskFilter) => void;
  onBatchOpen: () => void;
  onRefresh: () => void;
  onPauseAll: () => void;
  onResumeAll: () => void;
  onCopy: (value: string) => void;
  showTechnical: boolean;
}) {
  const { jobs, tab, activeCount, completedCount, totalSpeed, selectedId, actionJobId, filter, filterOpen, batchOpen, onTab, onSelect, onAction, onFilterOpen, onFilter, onBatchOpen, onRefresh, onPauseAll, onResumeAll, onCopy, showTechnical } = props;
  const activeFilterCount = Number(filter.kind !== 'all') + Number(filter.state !== 'all') + Number(filter.sort !== 'newest');
  return (
    <section className="rr-page">
      <div className="rr-page-tabs">
        <button className={tab === 'active' ? 'active' : ''} type="button" onClick={() => onTab('active')}>下载中 <span>{activeCount}</span></button>
        <button className={tab === 'completed' ? 'active' : ''} type="button" onClick={() => onTab('completed')}>已完成 <span>{completedCount}</span></button>
        <div className="rr-tab-spacer" />
        <button className="rr-icon-button" type="button" onClick={onRefresh} title="刷新"><RefreshCw size={18} /></button>
        <div className="rr-popover-anchor"><button className="rr-icon-button" type="button" onClick={onBatchOpen} title="更多"><MoreHorizontal size={19} /></button>{batchOpen && <BatchMenu onRefresh={onRefresh} onPauseAll={onPauseAll} onResumeAll={onResumeAll} />}</div>
      </div>
      <div className="rr-toolbar">
        <div className="rr-speed"><strong>{totalSpeed > 0 && tab === 'active' ? formatSpeed(totalSpeed) : tab === 'active' ? activeCount : completedCount}</strong><span>{totalSpeed > 0 && tab === 'active' ? '当前总速度' : tab === 'active' ? '个进行中任务' : '个已完成任务'}</span></div>
        <span className="rr-toolbar-copy">本地 ResourceJob 与普通下载统一管理</span>
        <div className="rr-toolbar-actions"><span className="rr-list-label"><ListChecks size={16} />列表</span><div className="rr-popover-anchor"><button className={`rr-filter-button ${activeFilterCount ? 'active' : ''}`} type="button" onClick={onFilterOpen}><Filter size={16} />筛选{activeFilterCount > 0 && <b>{activeFilterCount}</b>}</button>{filterOpen && <TaskFilterPopover filter={filter} onChange={onFilter} />}</div></div>
      </div>
      <div className="rr-task-head"><span>文件名</span><span>进度 / 大小</span><span>状态</span><span /></div>
      <div className="rr-task-list">
        {jobs.map((job) => (
          <Fragment key={job.job_id}>
            <TaskRow job={job} selected={selectedId === job.job_id} busy={actionJobId === job.job_id} onSelect={() => onSelect(job.job_id)} onAction={() => onAction(job)} />
            {selectedId === job.job_id && <InlineTaskDetails job={job} showTechnical={showTechnical} onCopy={onCopy} onAction={() => onAction(job)} />}
          </Fragment>
        ))}
        {!jobs.length && <EmptyState icon={<Download size={30} />} title="暂无任务" detail="新任务会自动出现在这里。" />}
      </div>
    </section>
  );
}

function TaskRow({ job, selected, busy, onSelect, onAction }: { job: ResourceJobSnapshot; selected: boolean; busy: boolean; onSelect: () => void; onAction: () => void }) {
  const completed = job.status === 'completed';
  const paused = job.status === 'paused';
  const waiting = job.status === 'waiting_for_source';
  return (
    <article className={`rr-task-row ${selected ? 'selected' : ''} ${waiting ? 'issue' : ''}`}>
      <button className="rr-task-open" type="button" onClick={onSelect}>
        <span className={`rr-file-icon ${job.kind === 'zhiqu' ? 'zhiqu' : ''}`}>{job.kind === 'zhiqu' ? <Sparkles size={22} /> : <HardDriveDownload size={22} />}</span>
        <span className="rr-task-name"><span><strong>{job.title}</strong>{job.kind === 'zhiqu' && <i>智取</i>}</span><small>{job.subtitle}</small><em>{job.source_page ? shortHost(job.source_page) : '本地任务'}</em></span>
        <span className="rr-task-progress">{completed ? <><strong>{formatBytes(job.total_bytes)}</strong><small>{formatDateTime(job.created_at)}</small></> : <><span className="rr-progress"><i className={waiting ? 'warning' : paused ? 'paused' : ''} style={{ width: `${job.progress}%` }} /></span><small>{formatBytes(job.downloaded_bytes)} / {formatBytes(job.total_bytes)} · {job.progress.toFixed(1)}%</small></>}</span>
        <span className="rr-task-status">{waiting ? <><strong className="warning">需要续取</strong><small>{job.stage_label}</small></> : completed ? <><strong>已完成</strong><small>{job.destination || '交付完成'}</small></> : paused ? <><strong>已暂停</strong><small>{job.progress.toFixed(1)}%</small></> : <><strong>{job.speed_bytes_per_second > 0 ? formatSpeed(job.speed_bytes_per_second) : `${job.progress.toFixed(1)}%`}</strong><small>{job.eta_seconds ? `剩余 ${formatEta(job.eta_seconds)}` : job.stage_label}</small></>}</span>
      </button>
      <button className={`rr-row-action ${waiting ? 'warning' : ''}`} type="button" onClick={onAction} disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : waiting ? <RefreshCw size={18} /> : completed ? <FolderOpen size={18} /> : paused ? <Play size={18} /> : <CirclePause size={19} />}</button>
    </article>
  );
}

function InlineTaskDetails({ job, showTechnical, onCopy, onAction }: { job: ResourceJobSnapshot; showTechnical: boolean; onCopy: (value: string) => void; onAction: () => void }) {
  const waiting = job.status === 'waiting_for_source';
  const completed = job.status === 'completed';
  const paused = job.status === 'paused';
  const selectedItems = job.selected_items?.length ? job.selected_items : [job.subtitle];
  return (
    <section className="rr-inline-detail" aria-label={`${job.title} 任务详情`}>
      <div className="rr-detail-header"><div><strong>{job.title}</strong><span>{job.stage_label}</span></div><span className="rr-detail-progress">{job.progress.toFixed(1)}%</span></div>
      {!completed && <div className="rr-detail-progressbar"><i className={waiting ? 'warning' : paused ? 'paused' : ''} style={{ width: `${job.progress}%` }} /></div>}
      <div className="rr-detail-grid">
        <DetailBlock title="目标"><p>{job.plan_overview || job.subtitle}</p>{job.source_page && <button type="button" className="rr-link-button" onClick={() => window.open(job.source_page!, '_blank', 'noopener,noreferrer')}><Link2 size={15} />{shortHost(job.source_page)}</button>}</DetailBlock>
        <DetailBlock title="选择"><div className="rr-selected-items">{selectedItems.map((item) => <span key={item}><Check size={14} />{item}</span>)}</div><small>来源 {job.source_count} · 备用 {job.alternative_count ?? 0} · 排除 {job.excluded_count}</small></DetailBlock>
        <DetailBlock title="问题">{waiting ? <div className="rr-problem warning"><TriangleAlert size={18} /><span><strong>当前来源不可用</strong><small>{job.issue || '任务上下文已保留。'}</small></span></div> : <div className="rr-problem healthy"><ShieldCheck size={18} /><span><strong>当前没有阻断问题</strong><small>{completed ? '任务已完成交付。' : 'Runtime 正常持有上下文。'}</small></span></div>}</DetailBlock>
        <DetailBlock title="下一步"><p>{waiting ? '继续获取可信来源；必要时把原任务目标带回浏览器重新智取。' : completed ? '查看或复制交付位置，来源历史继续保留在链接库。' : paused ? '继续当前任务。' : '继续托管当前本地下载。'}</p><div className="rr-detail-actions"><button className="primary" type="button" onClick={onAction}>{waiting ? <RefreshCw size={16} /> : completed ? <FolderOpen size={16} /> : paused ? <Play size={16} /> : <CirclePause size={16} />}{waiting ? '一键续取' : completed ? '复制交付位置' : paused ? '继续任务' : '暂停任务'}</button>{job.destination && <button type="button" onClick={() => onCopy(job.destination!)}><Copy size={15} />复制路径</button>}</div></DetailBlock>
      </div>
      {showTechnical && <div className="rr-technical">Runtime · {job.execution_mode === 'download_engine' ? 'Download Engine' : 'Stage B 演示执行'} · {job.job_id}</div>}
    </section>
  );
}

function DetailBlock({ title, children }: { title: string; children: ReactNode }) {
  return <section className="rr-detail-block"><h3>{title}</h3><div>{children}</div></section>;
}

function CloudPage({ jobs, usedBytes, remainingBytes, usedPercent, selectedId, onSelect, onCopy, showTechnical }: { jobs: ResourceJobSnapshot[]; usedBytes: number; remainingBytes: number; usedPercent: number; selectedId: string; onSelect: (jobId: string) => void; onCopy: (value: string) => void; showTechnical: boolean }) {
  return (
    <section className="rr-page rr-cloud-page">
      <div className="rr-cloud-header">
        <div className="rr-cloud-title"><span><Cloud size={26} /></span><div><strong>迅雷云盘</strong><small>智取资源保存到云盘后直接进入文件列表，不模拟“保存中”下载过程。</small></div></div>
        <div className="rr-cloud-space"><div><strong>{formatBytes(remainingBytes)} 可用</strong><span>已用 {formatBytes(usedBytes)} / {formatBytes(CLOUD_TOTAL_BYTES)} · 演示空间</span></div><span className="rr-capacity-bar"><i style={{ width: `${Math.max(1.5, usedPercent)}%` }} /></span></div>
      </div>
      <div className="rr-cloud-toolbar"><div><strong>最近保存</strong><span>{jobs.length} 个云盘资源</span></div><button type="button"><List size={17} />列表</button></div>
      <div className="rr-cloud-head"><span>文件名</span><span>大小</span><span>保存时间</span><span>位置</span></div>
      <div className="rr-task-list rr-cloud-list">
        {jobs.map((job) => (
          <Fragment key={job.job_id}>
            <article className={`rr-cloud-row ${selectedId === job.job_id ? 'selected' : ''}`}>
              <button type="button" onClick={() => onSelect(job.job_id)}><span className="rr-file-icon cloud"><Cloud size={22} /></span><span className="rr-cloud-name"><strong>{job.title}</strong><small>{job.subtitle}</small></span><strong className="rr-cloud-size">{formatBytes(job.total_bytes)}</strong><span>{formatDateTime(job.created_at)}</span><span>{job.destination || '迅雷云盘 / 智取下载'}</span></button>
            </article>
            {selectedId === job.job_id && <InlineCloudDetails job={job} showTechnical={showTechnical} onCopy={onCopy} />}
          </Fragment>
        ))}
        {!jobs.length && <EmptyState icon={<Cloud size={30} />} title="云盘还没有资源" detail="在智取扩展或新建任务中选择“保存到云盘”。" />}
      </div>
    </section>
  );
}

function InlineCloudDetails({ job, showTechnical, onCopy }: { job: ResourceJobSnapshot; showTechnical: boolean; onCopy: (value: string) => void }) {
  return <section className="rr-inline-detail rr-cloud-detail"><div className="rr-detail-grid"><DetailBlock title="资源"><p>{job.plan_overview || job.subtitle}</p></DetailBlock><DetailBlock title="云盘位置"><p>{job.destination || '迅雷云盘 / 智取下载'}</p><button className="rr-link-button" type="button" onClick={() => onCopy(job.destination || '迅雷云盘 / 智取下载')}><Copy size={15} />复制位置</button></DetailBlock><DetailBlock title="智取选择"><div className="rr-selected-items">{(job.selected_items || [job.subtitle]).map((item) => <span key={item}><Check size={14} />{item}</span>)}</div></DetailBlock><DetailBlock title="状态"><div className="rr-problem healthy"><ShieldCheck size={18} /><span><strong>已进入云盘</strong><small>云盘页不展示下载速度和“保存中”进度。</small></span></div></DetailBlock></div>{showTechnical && <div className="rr-technical">ResourceJob · {job.job_id}</div>}</section>;
}

function LinkLibraryPage({ items, tab, filter, view, total, favorites, onTab, onFilter, onView, onFavorite, onOpen }: { items: LinkHistoryItem[]; tab: LibraryTab; filter: LibraryFilter; view: LibraryView; total: number; favorites: number; onTab: (tab: LibraryTab) => void; onFilter: (filter: LibraryFilter) => void; onView: (view: LibraryView) => void; onFavorite: (item: LinkHistoryItem) => void; onOpen: (item: LinkHistoryItem) => void }) {
  const filters: Array<[LibraryFilter, string]> = [['all', '全部'], ['media', '音视频'], ['image', '图片'], ['document', '文档'], ['archive', '压缩包'], ['software', '软件']];
  return <section className="rr-page"><div className="rr-library-tabs"><button className={tab === 'favorites' ? 'active' : ''} type="button" onClick={() => onTab('favorites')}><Star size={17} />收藏 <span>{favorites}</span></button><button className={tab === 'history' ? 'active' : ''} type="button" onClick={() => onTab('history')}><History size={17} />历史 <span>{total}</span></button></div><div className="rr-library-toolbar"><div>{filters.map(([key, label]) => <button className={filter === key ? 'active' : ''} type="button" key={key} onClick={() => onFilter(key)}>{label}</button>)}</div><span><button className={view === 'list' ? 'active' : ''} type="button" onClick={() => onView('list')}><List size={17} /></button><button className={view === 'grid' ? 'active' : ''} type="button" onClick={() => onView('grid')}><LayoutGrid size={17} /></button></span></div>{view === 'list' && <div className="rr-library-head"><span>文件名 / 来源</span><span>状态</span><span>添加时间</span><span /></div>}<div className={view === 'grid' ? 'rr-library-grid' : 'rr-library-list'}>{items.map((item) => <LibraryItem key={item.history_id} item={item} view={view} onOpen={() => onOpen(item)} onFavorite={() => onFavorite(item)} />)}{!items.length && <EmptyState icon={tab === 'favorites' ? <Star size={30} /> : <Link2 size={30} />} title={tab === 'favorites' ? '还没有收藏' : '暂无链接历史'} detail="可从智取扩展直接收藏，也可以在这里点星标。" />}</div></section>;
}

function LibraryItem({ item, view, onOpen, onFavorite }: { item: LinkHistoryItem; view: LibraryView; onOpen: () => void; onFavorite: () => void }) {
  const kind = classifyLibrary(item);
  return <article className={`rr-library-item ${view}`}><button className="rr-library-open" type="button" onClick={onOpen}><span className={`rr-library-icon ${kind}`}>{libraryIcon(kind)}</span><span className="rr-library-main"><strong>{item.title}</strong><span><Link2 size={13} />{item.display_link}</span><small>{item.size_bytes ? formatBytes(item.size_bytes) : '大小未知'} · {libraryTypeLabel(item, kind)}</small></span><span className={`rr-library-status ${item.status}`}><strong>{libraryStatusLabel(item)}</strong><small>{item.delivery_target === 'cloud' ? '云盘' : item.delivery_target === 'local' ? '本地' : '仅收藏'}</small></span><span className="rr-library-time">{formatDateTime(item.added_at)}</span></button><button className={`rr-favorite ${item.favorite ? 'active' : ''}`} type="button" onClick={onFavorite}><Star size={18} fill={item.favorite ? 'currentColor' : 'none'} /></button></article>;
}

function TaskFilterPopover({ filter, onChange }: { filter: TaskFilter; onChange: (filter: TaskFilter) => void }) {
  return <div className="rr-filter-popover rr-popover"><div className="rr-popover-title"><strong>筛选任务</strong><button type="button" onClick={() => onChange({ kind: 'all', state: 'all', sort: 'newest' })}>重置</button></div><FilterGroup title="任务类型" value={filter.kind} options={[['all', '全部'], ['zhiqu', '智取任务'], ['normal', '普通下载']]} onChange={(value) => onChange({ ...filter, kind: value as TaskKindFilter })} /><FilterGroup title="当前状态" value={filter.state} options={[['all', '全部'], ['running', '进行中'], ['paused', '已暂停'], ['issue', '有问题']]} onChange={(value) => onChange({ ...filter, state: value as TaskStateFilter })} /><FilterGroup title="排序" value={filter.sort} options={[['newest', '最新创建'], ['speed', '速度优先'], ['progress', '进度优先']]} onChange={(value) => onChange({ ...filter, sort: value as SortMode })} /></div>;
}

function FilterGroup({ title, value, options, onChange }: { title: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void }) {
  return <section className="rr-filter-group"><span>{title}</span><div>{options.map(([key, label]) => <button className={value === key ? 'active' : ''} type="button" key={key} onClick={() => onChange(key)}>{value === key && <Check size={13} />}{label}</button>)}</div></section>;
}

function BatchMenu({ onRefresh, onPauseAll, onResumeAll }: { onRefresh: () => void; onPauseAll: () => void; onResumeAll: () => void }) {
  return <div className="rr-batch-menu rr-popover"><button type="button" onClick={onRefresh}><RefreshCw size={16} />刷新任务</button><button type="button" onClick={onPauseAll}><CirclePause size={16} />暂停全部本地任务</button><button type="button" onClick={onResumeAll}><Play size={16} />继续已暂停任务</button></div>;
}

function NotificationPopover({ jobs, onOpen }: { jobs: ResourceJobSnapshot[]; onOpen: (job: ResourceJobSnapshot) => void }) {
  return <div className="rr-notifications rr-popover"><div className="rr-popover-title"><strong>通知</strong><span>{jobs.length ? `${jobs.length} 条需处理` : '暂无新通知'}</span></div>{jobs.length ? jobs.map((job) => <button type="button" key={job.job_id} onClick={() => onOpen(job)}><TriangleAlert size={17} /><span><strong>{job.title}</strong><small>{job.issue || job.stage_label}</small></span></button>) : <div className="rr-popover-empty"><Bell size={22} />当前没有需要处理的任务</div>}</div>;
}

function UserPopover({ runtimeInfo, onSettings }: { runtimeInfo: RuntimeInfo | null; onSettings: () => void }) {
  return <div className="rr-user-popover rr-popover"><div className="rr-user-profile"><span><UserRound size={21} /></span><div><strong>本地用户</strong><small>迅雷智取 Runtime</small></div></div><div className="rr-user-provider"><span>模型适配器</span><strong>{runtimeInfo?.provider || '未连接'}</strong></div><button type="button" onClick={onSettings}><Settings size={16} />设置</button><button type="button" onClick={onSettings}><Info size={16} />关于迅雷智取</button></div>;
}

function NewTaskModal({ onClose, onCreate }: { onClose: () => void; onCreate: (payload: ManualJobCreateRequest) => Promise<void> }) {
  const [links, setLinks] = useState('');
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState<DeliveryTarget>('local');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    const parsed = links.split(/\s+/).map((value) => value.trim()).filter(Boolean);
    if (!parsed.length) { setError('请至少粘贴一个 HTTP / Magnet 链接'); return; }
    setBusy(true); setError('');
    try { await onCreate({ schema_version: '0.1', links: parsed, title: title.trim() || null, delivery_target: target }); }
    catch (submitError) { setError(submitError instanceof Error ? submitError.message : '创建失败'); setBusy(false); }
  }
  return <Modal title="新建任务" onClose={onClose}><div className="rr-new-task"><label><span>下载链接</span><textarea value={links} onChange={(event) => setLinks(event.target.value)} placeholder="粘贴 HTTP、HTTPS 或 Magnet；多个链接可换行" autoFocus /></label><label><span>任务名称 <small>可选</small></span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label><div className="rr-target"><span>交付到</span><div><button className={target === 'local' ? 'active' : ''} type="button" onClick={() => setTarget('local')}><HardDrive size={18} />本地</button><button className={target === 'cloud' ? 'active' : ''} type="button" onClick={() => setTarget('cloud')}><Cloud size={18} />云盘</button></div></div>{error && <div className="rr-form-error">{error}</div>}<div className="rr-modal-actions"><button type="button" onClick={onClose}>取消</button><button className="primary" type="button" onClick={() => void submit()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}创建任务</button></div></div></Modal>;
}

function SettingsModal({ preferences, runtimeInfo, onChange, onClose }: { preferences: Preferences; runtimeInfo: RuntimeInfo | null; onChange: (preferences: Preferences) => void; onClose: () => void }) {
  return <Modal title="设置" onClose={onClose} wide><div className="rr-settings"><section><h3>任务中心</h3><p>保持大字号和桌面客户端密度，优先保证 Demo 可读性。</p></section><SettingRow title="自动刷新" detail="Runtime 任务快照刷新频率"><select value={preferences.refreshMs} onChange={(event) => onChange({ ...preferences, refreshMs: Number(event.target.value) as Preferences['refreshMs'] })}><option value={1500}>1.5 秒</option><option value={3000}>3 秒</option><option value={5000}>5 秒</option></select></SettingRow><SettingRow title="显示技术状态" detail="在任务详情底部显示 Runtime 执行信息"><Toggle checked={preferences.showTechnical} onChange={(checked) => onChange({ ...preferences, showTechnical: checked })} /></SettingRow><SettingRow title="异常通知" detail="来源失效时在右上角提醒"><Toggle checked={preferences.notifications} onChange={(checked) => onChange({ ...preferences, notifications: checked })} /></SettingRow><div className="rr-about"><Bird size={28} /><div><strong>迅雷智取</strong><span>Runtime {runtimeInfo?.version || '0.1.0'} · {runtimeInfo?.provider || '未连接'}</span></div></div></div></Modal>;
}

function SettingRow({ title, detail, children }: { title: string; detail: string; children: ReactNode }) { return <div className="rr-setting-row"><div><strong>{title}</strong><span>{detail}</span></div>{children}</div>; }
function Toggle({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) { return <button className={`rr-toggle ${checked ? 'on' : ''}`} type="button" onClick={() => onChange(!checked)} aria-pressed={checked}><i /></button>; }
function Modal({ title, onClose, wide = false, children }: { title: string; onClose: () => void; wide?: boolean; children: ReactNode }) { return <div className="rr-modal-backdrop"><div className={`rr-modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true"><header><strong>{title}</strong><button type="button" onClick={onClose}><X size={19} /></button></header>{children}</div></div>; }
function EmptyState({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) { return <div className="rr-empty"><span>{icon}</span><strong>{title}</strong><small>{detail}</small></div>; }

function classifyLibrary(item: LinkHistoryItem): LibraryFilter {
  if (item.resource_type === 'video' || item.resource_type === 'audio' || item.link_type === 'media') return 'media';
  if (item.resource_type === 'image') return 'image';
  if (item.resource_type === 'archive') return 'archive';
  if (item.resource_type === 'software') return 'software';
  const name = item.title.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)) return 'image';
  if (/\.(pdf|docx?|xlsx?|pptx?|txt|md)$/i.test(name)) return 'document';
  if (/\.(zip|rar|7z|tar|gz|xz)$/i.test(name)) return 'archive';
  if (/\.(exe|msi|dmg|pkg|deb|rpm)$/i.test(name)) return 'software';
  if (/\.(mp4|mkv|m3u8|mp3|flac|aac|wav)$/i.test(name)) return 'media';
  return 'all';
}
function libraryIcon(kind: LibraryFilter): ReactNode { if (kind === 'image') return <FileImage size={22} />; if (kind === 'document') return <FileText size={22} />; if (kind === 'archive') return <FileArchive size={22} />; if (kind === 'software') return <HardDriveDownload size={22} />; if (kind === 'media') return <Play size={22} />; return <Link2 size={22} />; }
function libraryTypeLabel(item: LinkHistoryItem, kind: LibraryFilter): string { if (item.link_type === 'magnet') return 'Magnet'; if (kind === 'media') return '音视频'; if (kind === 'image') return '图片'; if (kind === 'document') return '文档'; if (kind === 'archive') return '压缩包'; if (kind === 'software') return '软件'; return '链接'; }
function libraryStatusLabel(item: LinkHistoryItem): string { if (item.status === 'failed') return '链接失效'; if (item.status === 'completed') return '已完成'; if (item.status === 'saved') return '已收藏'; return '使用中'; }
function sortJobs(jobs: ResourceJobSnapshot[], sort: SortMode): ResourceJobSnapshot[] { return [...jobs].sort((a, b) => sort === 'speed' ? b.speed_bytes_per_second - a.speed_bytes_per_second : sort === 'progress' ? b.progress - a.progress : new Date(b.created_at).getTime() - new Date(a.created_at).getTime()); }
function shortHost(value: string): string { try { return new URL(value).host; } catch { return value; } }
function pageFromHash(): PageKey { const value = window.location.hash.replace(/^#\//, ''); return value === 'cloud' || value === 'links' ? value : 'downloads'; }
function loadPreferences(): Preferences { try { const raw = window.localStorage.getItem(SETTINGS_KEY); return raw ? { ...defaultPreferences, ...JSON.parse(raw) as Partial<Preferences> } : defaultPreferences; } catch { return defaultPreferences; } }
function formatBytes(value: number): string { if (!Number.isFinite(value) || value <= 0) return '0 B'; const units = ['B', 'KB', 'MB', 'GB', 'TB']; const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1); const amount = value / 1024 ** index; return `${amount >= 100 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`; }
function formatSpeed(value: number): string { if (!Number.isFinite(value) || value <= 0) return '0 KB/s'; if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(value >= 10 * 1024 ** 2 ? 1 : 2)} MB/s`; return `${(value / 1024).toFixed(1)} KB/s`; }
function formatEta(seconds: number): string { if (seconds < 60) return `${seconds} 秒`; const minutes = Math.floor(seconds / 60); const rest = seconds % 60; return `${minutes}:${String(rest).padStart(2, '0')}`; }
function formatDateTime(value: string): string { const date = new Date(value); if (Number.isNaN(date.getTime())) return value; return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date); }
