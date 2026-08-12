import type {
  CaptureBatch,
  DeliveryTarget,
  LinkFavoriteCreateRequest,
  LinkHistoryItem,
  PlanItem,
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
  HardDrive,
  LoaderCircle,
  MousePointer2,
  Star,
  TriangleAlert
} from 'lucide-react';
import { useMemo, useState } from 'react';

const RUNTIME_URL = 'http://127.0.0.1:8765';

type Status = 'idle' | 'selecting' | 'analyzing' | 'creating' | 'favoriting' | 'error';
type PlanGroupKey = 'selected' | 'alternatives' | 'uncertainties' | 'excluded';

export function StageCExtensionApp() {
  const [batch, setBatch] = useState<CaptureBatch | null>(null);
  const [plan, setPlan] = useState<ResourcePlan | null>(null);
  const [confirmedIds, setConfirmedIds] = useState<Set<string>>(new Set());
  const [createdJob, setCreatedJob] = useState<ResourceJobSnapshot | null>(null);
  const [favoriteItem, setFavoriteItem] = useState<LinkHistoryItem | null>(null);
  const [deliveryTarget, setDeliveryTarget] = useState<DeliveryTarget>('local');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  const candidateSummary = useMemo(() => {
    if (!batch) return '尚未框选页面区域';
    const channels = new Map<string, number>();
    for (const candidate of batch.candidates) {
      const provenance = Array.isArray(candidate.metadata?.capture_provenance)
        ? candidate.metadata?.capture_provenance as Array<{ channel?: string }>
        : [{ channel: candidate.capture_channel }];
      for (const source of provenance) {
        const channel = source.channel || candidate.capture_channel;
        channels.set(channel, (channels.get(channel) || 0) + 1);
      }
    }
    return `${batch.candidates.length} 个融合候选 · ${Array.from(channels.entries()).map(([key, count]) => `${channelLabel(key)} ${count}`).join(' · ')}`;
  }, [batch]);

  async function startSelection() {
    setStatus('selecting');
    setError(null);
    setPlan(null);
    setBatch(null);
    setCreatedJob(null);
    setFavoriteItem(null);
    setConfirmedIds(new Set());
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('未找到当前标签页');
      const response = await requestRectangleSelection(tab.id);
      if (!response?.ok) throw new Error(response?.error || '框选采集失败');
      if (!response.batch?.candidates?.length) throw new Error('框选区域内没有发现候选资源');
      setBatch(response.batch as CaptureBatch);
      setStatus('idle');
    } catch (selectionError) {
      setStatus('error');
      setError(selectionError instanceof Error ? selectionError.message : '智能框选失败');
    }
  }

  async function analyze() {
    if (!batch) {
      setStatus('error');
      setError('请先在真实页面中拖拽框选资源区域。');
      return;
    }
    setStatus('analyzing');
    setError(null);
    setCreatedJob(null);
    setFavoriteItem(null);
    try {
      const response = await fetch(`${RUNTIME_URL}/v1/capture/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch)
      });
      if (!response.ok) throw new Error(await runtimeError(response, '节点 A 分析失败'));
      const nextPlan = (await response.json()) as ResourcePlan;
      setPlan(nextPlan);
      setConfirmedIds(new Set(nextPlan.selected.map((item) => item.item_id)));
      setStatus('idle');
    } catch (analysisError) {
      setStatus('error');
      setError(analysisError instanceof Error ? analysisError.message : '节点 A 分析失败');
    }
  }

  function toggleItem(itemId: string) {
    if (createdJob) return;
    setConfirmedIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  async function createResourceJob() {
    if (!plan || !batch) return;
    if (!confirmedIds.size) {
      setStatus('error');
      setError('至少确认一个资源项后才能创建 ResourceJob。');
      return;
    }
    const payload: ResourceJobCreateRequest = {
      schema_version: '0.1',
      plan,
      confirmed_item_ids: Array.from(confirmedIds),
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
      if (!response.ok) throw new Error(await runtimeError(response, '创建 ResourceJob 失败'));
      setCreatedJob((await response.json()) as ResourceJobSnapshot);
      setStatus('idle');
    } catch (createError) {
      setStatus('error');
      setError(createError instanceof Error ? createError.message : '创建 ResourceJob 失败');
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
      if (!response.ok) throw new Error(await runtimeError(response, '收藏失败'));
      setFavoriteItem((await response.json()) as LinkHistoryItem);
      setStatus('idle');
    } catch (favoriteError) {
      setStatus('error');
      setError(favoriteError instanceof Error ? favoriteError.message : '收藏失败');
    }
  }

  function openTaskCenter(target: 'downloads' | 'links' = 'downloads') {
    void chrome.tabs.create({ url: `${RUNTIME_URL}/app/#/${target}` });
  }

  const busy = status === 'selecting' || status === 'analyzing' || status === 'creating' || status === 'favoriting';

  return (
    <main className="panel-shell stage-c-extension">
      <header className="brand-row stage-c-brand">
        <div className="brand-mark stage-b-bird" aria-hidden="true"><Bird size={20} strokeWidth={2.4} /></div>
        <div><strong>迅雷智取 Lens</strong><span>智能多选 · 节点 A 真实分析</span></div>
        <span className="prototype-badge">Stage C</span>
      </header>

      <section className="hero-card stage-c-hero">
        <div>
          <p className="eyebrow">SelectionScope</p>
          <h1>{batch?.page.title || '在网页上框选你关心的资源区域'}</h1>
          <p>{candidateSummary}</p>
        </div>
        <button className="secondary-button stage-c-select" onClick={startSelection} disabled={busy}>
          {status === 'selecting' ? <LoaderCircle className="spin" size={17} /> : <MousePointer2 size={17} />}
          {status === 'selecting' ? '等待网页框选…' : batch ? '重新框选' : '开始智能框选'}
        </button>
      </section>

      {error && <div className="notice stage-c-error" role="status"><TriangleAlert size={16} /><span>{error}</span></div>}

      {batch && (
        <section className="candidate-card stage-c-candidates">
          <div className="section-heading">
            <div><p className="eyebrow">Capture Fusion</p><h2>框选候选</h2></div>
            <span>{batch.candidates.length} 项</span>
          </div>
          <div className="selection-facts">
            <span>矩形 {Math.round(batch.selection?.rect?.width || 0)} × {Math.round(batch.selection?.rect?.height || 0)}</span>
            <span>只硬过滤无效协议与完全重复</span>
          </div>
          <div className="candidate-list">
            {batch.candidates.slice(0, 10).map((candidate) => (
              <div className="candidate-row stage-c-candidate" key={candidate.candidate_id}>
                <span className="file-dot" />
                <div>
                  <strong>{candidate.display_name || candidate.anchor_text || candidate.candidate_id}</strong>
                  <span>{candidate.candidate_id} · {candidate.candidate_type} · overlap {Math.round((candidate.selection_overlap || 0) * 100)}% · {provenanceLabel(candidate)}</span>
                </div>
              </div>
            ))}
            {batch.candidates.length > 10 && <p className="more-candidates">另有 {batch.candidates.length - 10} 项候选进入 EvidencePack。</p>}
          </div>
        </section>
      )}

      <button className="primary-button stage-c-analyze" onClick={analyze} disabled={!batch || busy}>
        {status === 'analyzing' ? <LoaderCircle className="spin" size={18} /> : <BrainCircuit size={18} />}
        {status === 'analyzing' ? '节点 A 正在理解与比较…' : '让节点 A 分析框选结果'}
      </button>

      {plan && (
        <section className="plan-card stage-c-plan" aria-live="polite">
          <div className="section-heading">
            <div><p className="eyebrow">ResourcePlan · {plan.provider}</p><h2>{plan.resource_title}</h2></div>
            <Check size={18} />
          </div>
          <p className="overview">{plan.overview}</p>
          <div className="ai-plan-note"><BrainCircuit size={15} /><span>这是节点 A 的分析，不是最终决定。你可以重新勾选后再创建任务。</span></div>

          <EditablePlanGroup title="AI 建议" tone="selected" group="selected" items={plan.selected} confirmedIds={confirmedIds} onToggle={toggleItem} />
          <EditablePlanGroup title="备用方案" tone="alternative" group="alternatives" items={plan.alternatives} confirmedIds={confirmedIds} onToggle={toggleItem} />
          <EditablePlanGroup title="不确定项" tone="uncertain" group="uncertainties" items={plan.uncertainties} confirmedIds={confirmedIds} onToggle={toggleItem} />
          <EditablePlanGroup title="AI 不建议" tone="excluded" group="excluded" items={plan.excluded} confirmedIds={confirmedIds} onToggle={toggleItem} />

          {plan.recommendations.length > 0 && (
            <div className="scenario-block">
              <strong>场景化建议</strong>
              {plan.recommendations.map((recommendation, index) => (
                <div key={`${recommendation.scenario}-${index}`}><span>{scenarioLabel(recommendation.scenario)}</span><p>{recommendation.summary}</p></div>
              ))}
            </div>
          )}

          <div className="confirmation-summary">
            <span>用户已确认</span><strong>{confirmedIds.size} 项</strong><small>只有这些 item 会进入 ResourceJob。</small>
          </div>

          <div className="delivery-block">
            <div className="delivery-title"><strong>交付到</strong><span>只改变交付目标，不改变 AI 分析结果</span></div>
            <div className="delivery-choices" role="group" aria-label="交付位置">
              <button type="button" className={deliveryTarget === 'local' ? 'delivery-choice active' : 'delivery-choice'} onClick={() => !createdJob && setDeliveryTarget('local')} disabled={Boolean(createdJob)}><HardDrive size={17} /><span><strong>本地下载</strong><small>D:/Downloads</small></span></button>
              <button type="button" className={deliveryTarget === 'cloud' ? 'delivery-choice active' : 'delivery-choice'} onClick={() => !createdJob && setDeliveryTarget('cloud')} disabled={Boolean(createdJob)}><Cloud size={17} /><span><strong>保存到云盘</strong><small>迅雷云盘 / 智取下载</small></span></button>
            </div>
          </div>

          <div className="stage-b-plan-actions">
            <button className={`stage-b-favorite ${favoriteItem ? 'active' : ''}`} type="button" onClick={favoriteResource} disabled={status === 'favoriting' || Boolean(favoriteItem)}>{status === 'favoriting' ? <LoaderCircle className="spin" size={17} /> : <Star size={17} fill={favoriteItem ? 'currentColor' : 'none'} />}{favoriteItem ? '已收藏' : '收藏 ResourcePlan'}</button>
            <button className="primary-button compact stage-b-create" type="button" onClick={createResourceJob} disabled={status === 'creating' || Boolean(createdJob) || confirmedIds.size === 0}>{status === 'creating' ? <LoaderCircle className="spin" size={18} /> : <Download size={17} />}{status === 'creating' ? '正在创建 ResourceJob…' : createdJob ? '任务已创建' : `按确认结果创建任务 (${confirmedIds.size})`}</button>
          </div>

          {favoriteItem && <div className="stage-b-result success" role="status"><Star size={15} fill="currentColor" /><div><strong>已收藏：{favoriteItem.title}</strong><span>{favoriteItem.display_link}</span></div><button type="button" onClick={() => openTaskCenter('links')}><ExternalLink size={14} />查看收藏</button></div>}
          {createdJob && <div className="stage-b-result" role="status"><span className="file-dot" /><div><strong>已进入任务中心：{createdJob.title}</strong><span>用户确认 {confirmedIds.size} 项 · {createdJob.stage_label}</span></div><button type="button" onClick={() => openTaskCenter('downloads')}><ExternalLink size={14} />打开任务中心</button></div>}
        </section>
      )}
    </main>
  );
}

function EditablePlanGroup({ title, items, tone, group, confirmedIds, onToggle }: {
  title: string;
  items: PlanItem[];
  tone: string;
  group: PlanGroupKey;
  confirmedIds: Set<string>;
  onToggle: (itemId: string) => void;
}) {
  if (!items.length) return null;
  return (
    <div className={`plan-group stage-c-plan-group ${tone}`}>
      <h3>{title}<span>{items.length}</span></h3>
      {items.map((item) => {
        const checked = confirmedIds.has(item.item_id);
        return (
          <button type="button" className={`editable-plan-item ${checked ? 'confirmed' : ''}`} key={item.item_id} onClick={() => onToggle(item.item_id)}>
            <span className={`plan-check ${checked ? 'checked' : ''}`}>{checked && <Check size={13} />}</span>
            <span className="editable-plan-copy">
              <strong>{item.label}<small>{groupLabel(group)}</small></strong>
              <p>{item.plain_explanation}</p>
              <em>{item.reason}</em>
              <code>{item.candidate_ids.join(', ')}</code>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function provenanceLabel(candidate: CaptureBatch['candidates'][number]): string {
  const provenance = candidate.metadata?.capture_provenance;
  if (Array.isArray(provenance)) {
    const channels = provenance.map((item) => item && typeof item === 'object' && 'channel' in item ? String(item.channel) : '').filter(Boolean);
    if (channels.length) return Array.from(new Set(channels)).map(channelLabel).join(' + ');
  }
  return channelLabel(candidate.capture_channel);
}

function channelLabel(channel: string): string {
  return ({ dom_link: 'DOM 链接', selected_text: '选区文本', media_element: '媒体元素', media_network: '媒体网络', image: '图片', manual: '手工' } as Record<string, string>)[channel] || channel;
}
function groupLabel(group: PlanGroupKey): string {
  return ({ selected: 'AI 推荐', alternatives: '备用', uncertainties: '待确认', excluded: 'AI 不建议' } as Record<PlanGroupKey, string>)[group];
}
function scenarioLabel(scenario: string): string {
  return ({ current_device: '当前设备', compatibility: '兼容优先', quality: '质量优先', small_size: '体积优先', manual: '手动选择' } as Record<string, string>)[scenario] || scenario;
}

async function requestRectangleSelection(tabId: number) {
  const message = { type: 'XUNLEI_ZHIQU_START_SELECTION', tabId };
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!isMissingContentScriptError(error)) throw error;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
      });
    } catch (injectionError) {
      const detail = injectionError instanceof Error ? injectionError.message : String(injectionError);
      throw new Error(`当前页面尚未连接迅雷智取，自动注入失败：${detail}`);
    }
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (retryError) {
      const detail = retryError instanceof Error ? retryError.message : String(retryError);
      throw new Error(`已重新注入网页采集脚本，但仍无法开始智能框选：${detail}`);
    }
  }
}

function isMissingContentScriptError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Receiving end does not exist')
    || message.includes('Could not establish connection')
    || message.includes('The message port closed before a response was received');
}

async function runtimeError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { detail?: string };
    return body.detail ? `${fallback}：${body.detail}` : `${fallback}：HTTP ${response.status}`;
  } catch {
    return `${fallback}：HTTP ${response.status}`;
  }
}
