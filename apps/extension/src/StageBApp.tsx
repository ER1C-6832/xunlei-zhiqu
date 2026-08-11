import type {
  CaptureBatch,
  DeliveryTarget,
  LinkFavoriteCreateRequest,
  LinkHistoryItem,
  ResourceJobCreateRequest,
  ResourceJobSnapshot,
  ResourcePlan
} from '@xunlei-zhiqu/contracts';
import {
  Bird,
  BrainCircuit,
  Check,
  Cloud,
  Download,
  ExternalLink,
  FileSearch,
  HardDrive,
  LoaderCircle,
  RefreshCw,
  Star,
  X
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import './stage-b.css';

const RUNTIME_URL = 'http://127.0.0.1:8765';

const demoBatch: CaptureBatch = {
  schema_version: '0.1',
  batch_id: 'batch_demo_extension',
  trigger: 'rectangle',
  page: {
    url: 'https://example.test/downloads',
    title: 'Example App 下载',
    relevant_text: ['Windows 版本', '语言包与补丁', '备用地址']
  },
  selection: { type: 'rectangle', candidate_ids: ['c1', 'c2', 'c3', 'c4'] },
  device: { os: 'windows', arch: 'x64', locale: 'zh-CN' },
  candidates: [
    {
      candidate_id: 'c1',
      value: 'https://example.test/ExampleApp_5.2.1_win_x64_portable.zip',
      candidate_type: 'file',
      capture_channel: 'dom_link',
      page_url: 'https://example.test/downloads',
      display_name: 'ExampleApp_5.2.1_win_x64_portable.zip',
      anchor_text: 'Windows 64 位免安装版',
      nearby_text: '解压后直接运行，无需管理员权限',
      probe_status: 'ok',
      probe_facts: { content_length: 241172103, reachable: true }
    },
    {
      candidate_id: 'c2',
      value: 'https://example.test/ExampleApp_5.2.1_zh-CN_language.zip',
      candidate_type: 'file',
      capture_channel: 'dom_link',
      page_url: 'https://example.test/downloads',
      display_name: 'ExampleApp_5.2.1_zh-CN_language.zip',
      anchor_text: '中文语言包',
      nearby_text: '适用于 5.2.1 完整版',
      probe_status: 'pending'
    },
    {
      candidate_id: 'c3',
      value: 'https://mirror.example.test/ExampleApp_5.2.1_win_x64_setup.exe',
      candidate_type: 'file',
      capture_channel: 'dom_link',
      page_url: 'https://example.test/downloads',
      display_name: 'ExampleApp_5.2.1_win_x64_setup.exe',
      anchor_text: 'Windows x64 安装版',
      nearby_text: '适合长期使用，需要安装',
      probe_status: 'pending'
    },
    {
      candidate_id: 'c4',
      value: 'https://example.test/index.html',
      candidate_type: 'page',
      capture_channel: 'dom_link',
      page_url: 'https://example.test/downloads',
      display_name: 'index.html',
      anchor_text: '返回下载首页',
      probe_status: 'skipped'
    }
  ]
};

type Status = 'idle' | 'capturing' | 'analyzing' | 'creating' | 'favoriting' | 'error';

export function StageBExtensionApp() {
  const [batch, setBatch] = useState<CaptureBatch | null>(null);
  const [plan, setPlan] = useState<ResourcePlan | null>(null);
  const [createdJob, setCreatedJob] = useState<ResourceJobSnapshot | null>(null);
  const [favoriteItem, setFavoriteItem] = useState<LinkHistoryItem | null>(null);
  const [deliveryTarget, setDeliveryTarget] = useState<DeliveryTarget>('local');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  const candidateSummary = useMemo(() => {
    if (!batch) return '尚未读取当前页面';
    const counts = batch.candidates.reduce<Record<string, number>>((acc, candidate) => {
      acc[candidate.candidate_type] = (acc[candidate.candidate_type] || 0) + 1;
      return acc;
    }, {});
    return Object.entries(counts).map(([key, value]) => `${key} ${value}`).join(' · ');
  }, [batch]);

  async function captureCurrentPage() {
    setStatus('capturing');
    setError(null);
    setPlan(null);
    setCreatedJob(null);
    setFavoriteItem(null);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('未找到当前标签页');
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'XUNLEI_ZHIQU_CAPTURE', tabId: tab.id });
      if (!response?.ok || !response.batch?.candidates?.length) throw new Error('当前页面未发现可分析候选');
      setBatch(response.batch as CaptureBatch);
      setStatus('idle');
    } catch (captureError) {
      setBatch(demoBatch);
      setStatus('error');
      setError(`${captureError instanceof Error ? captureError.message : '页面采集失败'}。已切换到内置演示候选。`);
    }
  }

  async function analyze() {
    const payload = batch ?? demoBatch;
    setBatch(payload);
    setStatus('analyzing');
    setError(null);
    setCreatedJob(null);
    setFavoriteItem(null);
    try {
      const response = await fetch(`${RUNTIME_URL}/v1/capture/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error(`Runtime 返回 ${response.status}`);
      setPlan((await response.json()) as ResourcePlan);
      setStatus('idle');
    } catch (analyzeError) {
      setStatus('error');
      setError(`${analyzeError instanceof Error ? analyzeError.message : '分析失败'}。请确认 Runtime 已在 127.0.0.1:8765 启动。`);
    }
  }

  async function favoriteResource() {
    if (!plan) return;
    const payload: LinkFavoriteCreateRequest = { schema_version: '0.1', plan, capture: batch };
    setStatus('favoriting');
    setError(null);
    try {
      const response = await fetch(`${RUNTIME_URL}/v1/link-library/favorites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error(`收藏失败：Runtime 返回 ${response.status}`);
      setFavoriteItem((await response.json()) as LinkHistoryItem);
      setStatus('idle');
    } catch (favoriteError) {
      setStatus('error');
      setError(favoriteError instanceof Error ? favoriteError.message : '收藏失败');
    }
  }

  async function createResourceJob() {
    if (!plan) return;
    const payload: ResourceJobCreateRequest = {
      schema_version: '0.1',
      plan,
      capture: batch,
      delivery_target: deliveryTarget
    };
    setStatus('creating');
    setError(null);
    try {
      const response = await fetch(`${RUNTIME_URL}/v1/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error(`创建任务失败：Runtime 返回 ${response.status}`);
      setCreatedJob((await response.json()) as ResourceJobSnapshot);
      setStatus('idle');
    } catch (createError) {
      setStatus('error');
      setError(createError instanceof Error ? createError.message : '创建 ResourceJob 失败');
    }
  }

  function openTaskCenter(target: 'downloads' | 'links' = 'downloads') {
    void chrome.tabs.create({ url: `${RUNTIME_URL}/app/#/${target}` });
  }

  return (
    <main className="panel-shell stage-b-extension">
      <header className="brand-row">
        <div className="brand-mark stage-b-bird" aria-hidden="true"><Bird size={20} strokeWidth={2.4} /></div>
        <div><strong>迅雷智取 Lens</strong><span>资源理解 · 可解释选型 · 任务闭环</span></div>
        <span className="prototype-badge">Stage B</span>
      </header>

      <section className="hero-card">
        <div><p className="eyebrow">当前页面</p><h1>{batch?.page.title || '读取页面候选资源'}</h1><p>{candidateSummary}</p></div>
        <button className="secondary-button" onClick={captureCurrentPage} disabled={status === 'capturing'}>{status === 'capturing' ? <LoaderCircle className="spin" size={16} /> : <FileSearch size={16} />}采集当前页</button>
      </section>

      {error && <div className="notice" role="status"><RefreshCw size={16} /><span>{error}</span></div>}

      <section className="candidate-card">
        <div className="section-heading"><div><p className="eyebrow">CaptureBatch</p><h2>候选摘要</h2></div><span>{batch?.candidates.length ?? 0} 项</span></div>
        <div className="candidate-list">
          {(batch?.candidates ?? []).slice(0, 5).map((candidate) => <div className="candidate-row" key={candidate.candidate_id}><span className="file-dot" /><div><strong>{candidate.display_name || candidate.anchor_text || candidate.value}</strong><span>{candidate.candidate_type} · {candidate.capture_channel}</span></div></div>)}
          {!batch && <p className="empty-copy">先采集当前页面，或直接使用演示数据分析。</p>}
        </div>
      </section>

      <button className="primary-button" onClick={analyze} disabled={status === 'analyzing' || status === 'creating' || status === 'favoriting'}>{status === 'analyzing' ? <LoaderCircle className="spin" size={18} /> : <BrainCircuit size={18} />}{status === 'analyzing' ? '正在理解资源…' : '交给节点 A 分析'}</button>

      {plan && (
        <section className="plan-card" aria-live="polite">
          <div className="section-heading"><div><p className="eyebrow">ResourcePlan · {plan.provider}</p><h2>{plan.resource_title}</h2></div><Check size={18} /></div>
          <p className="overview">{plan.overview}</p>
          <PlanGroup title="建议下载" tone="selected" items={plan.selected} icon={<Download size={15} />} />
          <PlanGroup title="备用来源" tone="alternative" items={plan.alternatives} icon={<RefreshCw size={15} />} />
          <PlanGroup title="已排除" tone="excluded" items={plan.excluded} icon={<X size={15} />} />

          <div className="delivery-block">
            <div className="delivery-title"><strong>交付到</strong><span>同一 ResourceJob，只改变交付目的地</span></div>
            <div className="delivery-choices" role="group" aria-label="交付位置">
              <button type="button" className={deliveryTarget === 'local' ? 'delivery-choice active' : 'delivery-choice'} onClick={() => !createdJob && setDeliveryTarget('local')} disabled={Boolean(createdJob)}><HardDrive size={17} /><span><strong>本地下载</strong><small>D:/Downloads</small></span></button>
              <button type="button" className={deliveryTarget === 'cloud' ? 'delivery-choice active' : 'delivery-choice'} onClick={() => !createdJob && setDeliveryTarget('cloud')} disabled={Boolean(createdJob)}><Cloud size={17} /><span><strong>保存到云盘</strong><small>迅雷云盘 / 智取下载</small></span></button>
            </div>
          </div>

          <div className="stage-b-plan-actions">
            <button className={`stage-b-favorite ${favoriteItem ? 'active' : ''}`} type="button" onClick={favoriteResource} disabled={status === 'favoriting' || Boolean(favoriteItem)}>{status === 'favoriting' ? <LoaderCircle className="spin" size={17} /> : <Star size={17} fill={favoriteItem ? 'currentColor' : 'none'} />}{favoriteItem ? '已收藏到链接库' : '收藏到链接库'}</button>
            <button className="primary-button compact stage-b-create" type="button" onClick={createResourceJob} disabled={status === 'creating' || Boolean(createdJob)}>{status === 'creating' ? <LoaderCircle className="spin" size={18} /> : deliveryTarget === 'cloud' ? <Cloud size={17} /> : <Download size={17} />}{status === 'creating' ? '正在创建 ResourceJob…' : createdJob ? '任务已创建' : deliveryTarget === 'cloud' ? '智取并保存到云盘' : '交给迅雷智取'}</button>
          </div>

          {favoriteItem && <div className="stage-b-result success" role="status"><Star size={15} fill="currentColor" /><div><strong>已收藏：{favoriteItem.title}</strong><span>{favoriteItem.display_link}</span></div><button type="button" onClick={() => openTaskCenter('links')}><ExternalLink size={14} />查看收藏</button></div>}
          {createdJob && <div className="stage-b-result" role="status"><span className="file-dot" /><div><strong>已进入任务中心：{createdJob.title}</strong><span>{createdJob.delivery_target === 'cloud' ? '云盘任务' : '本地任务'} · {createdJob.stage_label} · {createdJob.job_id}</span></div><button type="button" onClick={() => openTaskCenter('downloads')}><ExternalLink size={14} />打开任务中心</button></div>}
        </section>
      )}
    </main>
  );
}

function PlanGroup({ title, items, tone, icon }: { title: string; items: ResourcePlan['selected']; tone: string; icon: ReactNode }) {
  if (!items.length) return null;
  return <div className={`plan-group ${tone}`}><h3>{icon}{title}<span>{items.length}</span></h3>{items.map((item) => <div className="plan-item" key={item.item_id}><strong>{item.label}</strong><p>{item.plain_explanation}</p><small>{item.reason}</small></div>)}</div>;
}
