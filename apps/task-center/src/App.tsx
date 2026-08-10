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
  TriangleAlert
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';

const API_URL = import.meta.env.VITE_RUNTIME_URL || 'http://127.0.0.1:8765';

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
    issue: '主来源返回 503，已保存原页面和 42% 下载进度。',
    next_action: 'continue_acquisition',
    source_count: 2,
    excluded_count: 8,
    created_at: new Date(Date.now() - 72 * 60_000).toISOString(),
    destination: 'D:/Downloads/Open Media Course'
  },
  {
    job_id: 'job_normal_001',
    title: 'sample-dataset.zip',
    subtitle: '普通下载',
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
  { label: '下载', icon: Download, active: true },
  { label: '云盘', icon: Cloud },
  { label: '播放', icon: Play },
  { label: '链接库', icon: Link2 },
  { label: '设备', icon: Smartphone },
  { label: '游戏', icon: Gamepad2 }
];

export function App() {
  const [jobs, setJobs] = useState<ResourceJobSnapshot[]>(fallbackJobs);
  const [selectedId, setSelectedId] = useState(fallbackJobs[0].job_id);
  const [tab, setTab] = useState<'active' | 'completed'>('active');
  const [query, setQuery] = useState('');
  const [runtimeConnected, setRuntimeConnected] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_URL}/v1/jobs`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<ResourceJobSnapshot[]>;
      })
      .then((data) => {
        setJobs(data);
        setSelectedId(data[0]?.job_id ?? '');
        setRuntimeConnected(true);
      })
      .catch(() => setRuntimeConnected(false));
    return () => controller.abort();
  }, []);

  const visibleJobs = useMemo(() => {
    const lowerQuery = query.trim().toLowerCase();
    return jobs.filter((job) => {
      const matchesTab = tab === 'completed' ? job.status === 'completed' : job.status !== 'completed';
      const matchesQuery = !lowerQuery || `${job.title} ${job.subtitle}`.toLowerCase().includes(lowerQuery);
      return matchesTab && matchesQuery;
    });
  }, [jobs, query, tab]);

  const selectedJob = visibleJobs.find((job) => job.job_id === selectedId) ?? visibleJobs[0] ?? null;
  const activeCount = jobs.filter((job) => job.status !== 'completed').length;
  const completedCount = jobs.filter((job) => job.status === 'completed').length;

  return (
    <div className="app-frame">
      <aside className="sidebar" aria-label="主导航">
        <div className="logo-row">
          <div className="logo-mark"><Sparkles size={22} /></div>
          <div>
            <strong>迅雷</strong>
            <span>智取任务中心</span>
          </div>
        </div>

        <nav className="primary-nav">
          {navItems.map(({ label, icon: Icon, active }) => (
            <button className={active ? 'nav-item active' : 'nav-item'} type="button" key={label}>
              <Icon size={19} />
              <span>{label}</span>
              {active && <span className="nav-count">{activeCount}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <button className="nav-item" type="button"><Settings size={19} /><span>设置</span></button>
          <div className="prototype-note">
            <Bot size={18} />
            <div>
              <strong>功能原型</strong>
              <span>单编排器 · 双智能节点</span>
            </div>
          </div>
        </div>
      </aside>

      <main className="main-shell">
        <header className="topbar">
          <button className="icon-button" type="button" aria-label="返回"><ChevronLeft size={20} /></button>
          <button className="icon-button" type="button" aria-label="刷新任务"><RefreshCw size={18} /></button>
          <label className="search-box">
            <Search size={17} />
            <input
              aria-label="搜索任务"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索任务、文件或来源"
            />
          </label>
          <button className="paste-button" type="button"><Link2 size={17} />粘贴链接</button>
          <button className="new-button" type="button"><Plus size={18} />新建</button>
        </header>

        <section className="content-shell">
          <div className="page-heading">
            <div>
              <div className="title-line">
                <h1>下载</h1>
                <span className="prototype-pill">迅雷智取功能原型</span>
              </div>
              <p>管理普通下载和带资源目标、上下文与恢复能力的智取任务。</p>
            </div>
            <span className={runtimeConnected ? 'connection connected' : 'connection'}>
              <span />{runtimeConnected ? 'Runtime 已连接' : '演示数据模式'}
            </span>
          </div>

          <div className="tabs" role="tablist">
            <button className={tab === 'active' ? 'tab active' : 'tab'} onClick={() => setTab('active')} type="button">
              下载中 <span>{activeCount}</span>
            </button>
            <button className={tab === 'completed' ? 'tab active' : 'tab'} onClick={() => setTab('completed')} type="button">
              已完成 <span>{completedCount}</span>
            </button>
          </div>

          <div className="workspace">
            <section className="job-list" aria-label="任务列表">
              {visibleJobs.map((job) => (
                <JobRow
                  key={job.job_id}
                  job={job}
                  selected={job.job_id === selectedJob?.job_id}
                  onSelect={() => setSelectedId(job.job_id)}
                />
              ))}
              {visibleJobs.length === 0 && (
                <div className="empty-state">
                  <FileClock size={30} />
                  <strong>没有匹配的任务</strong>
                  <span>调整搜索词或切换任务标签。</span>
                </div>
              )}
            </section>

            <aside className="detail-panel" aria-label="任务详情">
              {selectedJob ? <JobDetail job={selectedJob} /> : <div className="empty-state">选择一个任务查看详情</div>}
            </aside>
          </div>
        </section>
      </main>
    </div>
  );
}

function JobRow({ job, selected, onSelect }: { job: ResourceJobSnapshot; selected: boolean; onSelect: () => void }) {
  const waiting = job.status === 'waiting_for_source';
  const completed = job.status === 'completed';
  return (
    <button className={`job-row ${selected ? 'selected' : ''}`} onClick={onSelect} type="button">
      <div className={`job-icon ${job.kind === 'zhiqu' ? 'zhiqu' : ''}`}>
        {job.kind === 'zhiqu' ? <Sparkles size={21} /> : <HardDriveDownload size={21} />}
      </div>
      <div className="job-main">
        <div className="job-title-line">
          <strong>{job.title}</strong>
          {job.kind === 'zhiqu' && <span className="zhiqu-badge"><Sparkles size={12} />智取任务</span>}
        </div>
        <p>{job.subtitle}</p>
        <div className="progress-track" aria-label={`进度 ${job.progress}%`}>
          <span className={waiting ? 'warning' : completed ? 'complete' : ''} style={{ width: `${job.progress}%` }} />
        </div>
        <div className="job-meta">
          <span>{formatBytes(job.downloaded_bytes)} / {formatBytes(job.total_bytes)}</span>
          <span>来源 {job.source_count}</span>
          {job.excluded_count > 0 && <span>已排除 {job.excluded_count}</span>}
        </div>
      </div>
      <div className="job-status">
        <strong>{waiting ? '需要续取' : completed ? '已完成' : `${job.progress.toFixed(1)}%`}</strong>
        <span>{waiting ? job.stage_label : completed ? job.destination : `${formatBytes(job.speed_bytes_per_second)}/s`}</span>
        {waiting ? (
          <span className="inline-action"><RefreshCw size={14} />一键续取</span>
        ) : completed ? (
          <span className="inline-action neutral"><FolderOpen size={14} />打开</span>
        ) : (
          <span className="inline-action neutral"><CirclePause size={14} />暂停</span>
        )}
      </div>
    </button>
  );
}

function JobDetail({ job }: { job: ResourceJobSnapshot }) {
  const waiting = job.status === 'waiting_for_source';
  const completed = job.status === 'completed';
  return (
    <>
      <div className="detail-header">
        <div className={`job-icon large ${job.kind === 'zhiqu' ? 'zhiqu' : ''}`}>
          {job.kind === 'zhiqu' ? <Sparkles size={24} /> : <HardDriveDownload size={24} />}
        </div>
        <div>
          <p className="detail-eyebrow">{job.kind === 'zhiqu' ? 'RESOURCE JOB' : 'DOWNLOAD JOB'}</p>
          <h2>{job.title}</h2>
          <span>{job.stage_label}</span>
        </div>
        <button className="icon-button" type="button" aria-label="更多操作"><MoreHorizontal size={19} /></button>
      </div>

      {waiting && (
        <div className="incident-card">
          <TriangleAlert size={18} />
          <div><strong>来源失效</strong><p>{job.issue}</p></div>
        </div>
      )}

      <div className="detail-progress">
        <div><span>总体进度</span><strong>{job.progress.toFixed(1)}%</strong></div>
        <div className="progress-track large"><span className={waiting ? 'warning' : completed ? 'complete' : ''} style={{ width: `${job.progress}%` }} /></div>
        <p>{formatBytes(job.downloaded_bytes)} / {formatBytes(job.total_bytes)}</p>
      </div>

      <div className="fact-grid">
        <Fact icon={<ListChecks size={17} />} label="资源目标" value={job.subtitle} />
        <Fact icon={<ShieldCheck size={17} />} label="候选整理" value={`保留 ${job.source_count} 个来源，排除 ${job.excluded_count} 项噪声`} />
        <Fact icon={<Activity size={17} />} label="当前阶段" value={job.stage_label} />
        <Fact icon={<FolderOpen size={17} />} label="交付位置" value={job.destination || '未设置'} />
      </div>

      <div className="detail-section">
        <div className="section-title"><h3>智取活动</h3><span>轻量事件</span></div>
        <TimelineRow label="节点 A 已生成资源计划" time="18 分钟前" state="done" />
        <TimelineRow label={`Selection Hygiene 排除 ${job.excluded_count} 项`} time="18 分钟前" state="done" />
        <TimelineRow label={waiting ? '诊断为 SOURCE_UNAVAILABLE' : completed ? '文件验证完成' : '下载引擎持续执行'} time="刚刚" state={waiting ? 'warning' : 'active'} />
      </div>

      <button className={waiting ? 'primary-action warning' : 'primary-action'} type="button">
        {waiting ? <><RefreshCw size={18} />一键续取</> : completed ? <><FolderOpen size={18} />打开文件夹</> : <><CirclePause size={18} />暂停任务</>}
      </button>
    </>
  );
}

function Fact({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return <div className="fact-item"><span>{icon}</span><div><small>{label}</small><strong>{value}</strong></div></div>;
}

function TimelineRow({ label, time, state }: { label: string; time: string; state: string }) {
  return <div className="timeline-row"><span className={`timeline-dot ${state}`} /><div><strong>{label}</strong><span>{time}</span></div></div>;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** index;
  return `${amount >= 100 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}
