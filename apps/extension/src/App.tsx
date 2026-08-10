import type { CaptureBatch, ResourcePlan } from '@xunlei-zhiqu/contracts';
import { BrainCircuit, Check, Download, FileSearch, LoaderCircle, RefreshCw, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

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

export function App() {
  const [batch, setBatch] = useState<CaptureBatch | null>(null);
  const [plan, setPlan] = useState<ResourcePlan | null>(null);
  const [status, setStatus] = useState<'idle' | 'capturing' | 'analyzing' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const candidateSummary = useMemo(() => {
    if (!batch) return '尚未读取当前页面';
    const counts = batch.candidates.reduce<Record<string, number>>((acc, candidate) => {
      acc[candidate.candidate_type] = (acc[candidate.candidate_type] || 0) + 1;
      return acc;
    }, {});
    return Object.entries(counts)
      .map(([key, value]) => `${key} ${value}`)
      .join(' · ');
  }, [batch]);

  async function captureCurrentPage() {
    setStatus('capturing');
    setError(null);
    setPlan(null);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('未找到当前标签页');
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'XUNLEI_ZHIQU_CAPTURE',
        tabId: tab.id
      });
      if (!response?.ok || !response.batch?.candidates?.length) {
        throw new Error('当前页面未发现可分析候选');
      }
      setBatch(response.batch as CaptureBatch);
      setStatus('idle');
    } catch (captureError) {
      setBatch(demoBatch);
      setStatus('error');
      setError(
        `${captureError instanceof Error ? captureError.message : '页面采集失败'}。已切换到内置演示候选。`
      );
    }
  }

  async function analyze() {
    const payload = batch ?? demoBatch;
    setBatch(payload);
    setStatus('analyzing');
    setError(null);
    try {
      const response = await fetch(`${RUNTIME_URL}/v1/capture/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        throw new Error(`Runtime 返回 ${response.status}`);
      }
      setPlan((await response.json()) as ResourcePlan);
      setStatus('idle');
    } catch (analyzeError) {
      setStatus('error');
      setError(
        `${analyzeError instanceof Error ? analyzeError.message : '分析失败'}。请确认 Runtime 已在 127.0.0.1:8765 启动。`
      );
    }
  }

  return (
    <main className="panel-shell">
      <header className="brand-row">
        <div className="brand-mark" aria-hidden="true">
          <BrainCircuit size={20} />
        </div>
        <div>
          <strong>迅雷智取 Lens</strong>
          <span>候选融合 · 资源理解 · 可修改选型</span>
        </div>
        <span className="prototype-badge">v0.1</span>
      </header>

      <section className="hero-card">
        <div>
          <p className="eyebrow">当前页面</p>
          <h1>{batch?.page.title || '读取页面候选资源'}</h1>
          <p>{candidateSummary}</p>
        </div>
        <button className="secondary-button" onClick={captureCurrentPage} disabled={status === 'capturing'}>
          {status === 'capturing' ? <LoaderCircle className="spin" size={16} /> : <FileSearch size={16} />}
          采集当前页
        </button>
      </section>

      {error && (
        <div className="notice" role="status">
          <RefreshCw size={16} />
          <span>{error}</span>
        </div>
      )}

      <section className="candidate-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">CaptureBatch</p>
            <h2>候选摘要</h2>
          </div>
          <span>{batch?.candidates.length ?? 0} 项</span>
        </div>
        <div className="candidate-list">
          {(batch?.candidates ?? []).slice(0, 5).map((candidate) => (
            <div className="candidate-row" key={candidate.candidate_id}>
              <span className="file-dot" />
              <div>
                <strong>{candidate.display_name || candidate.anchor_text || candidate.value}</strong>
                <span>{candidate.candidate_type} · {candidate.capture_channel}</span>
              </div>
            </div>
          ))}
          {!batch && <p className="empty-copy">先采集当前页面，或直接使用演示数据分析。</p>}
        </div>
      </section>

      <button className="primary-button" onClick={analyze} disabled={status === 'analyzing'}>
        {status === 'analyzing' ? <LoaderCircle className="spin" size={18} /> : <BrainCircuit size={18} />}
        {status === 'analyzing' ? '正在理解资源…' : '交给节点 A 分析'}
      </button>

      {plan && (
        <section className="plan-card" aria-live="polite">
          <div className="section-heading">
            <div>
              <p className="eyebrow">ResourcePlan · {plan.provider}</p>
              <h2>{plan.resource_title}</h2>
            </div>
            <Check size={18} />
          </div>
          <p className="overview">{plan.overview}</p>

          <PlanGroup title="建议下载" tone="selected" items={plan.selected} icon={<Download size={15} />} />
          <PlanGroup title="备用来源" tone="alternative" items={plan.alternatives} icon={<RefreshCw size={15} />} />
          <PlanGroup title="已排除" tone="excluded" items={plan.excluded} icon={<X size={15} />} />

          <button className="primary-button compact" type="button">
            交给迅雷智取
          </button>
        </section>
      )}
    </main>
  );
}

function PlanGroup({
  title,
  items,
  tone,
  icon
}: {
  title: string;
  items: ResourcePlan['selected'];
  tone: string;
  icon: ReactNode;
}) {
  if (!items.length) return null;
  return (
    <div className={`plan-group ${tone}`}>
      <h3>{icon}{title}<span>{items.length}</span></h3>
      {items.map((item) => (
        <div className="plan-item" key={item.item_id}>
          <strong>{item.label}</strong>
          <p>{item.plain_explanation}</p>
          <small>{item.reason}</small>
        </div>
      ))}
    </div>
  );
}
