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
  ChevronDown,
  ChevronRight,
  Cloud,
  Download,
  ExternalLink,
  HardDrive,
  LoaderCircle,
  MousePointer2,
  Search,
  Star,
  TriangleAlert
} from 'lucide-react';
import { useMemo, useState } from 'react';

const RUNTIME_URL = 'http://127.0.0.1:8765';

type Status = 'idle' | 'selecting' | 'scanning' | 'analyzing' | 'creating' | 'favoriting' | 'error';
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
  const [captureOpen, setCaptureOpen] = useState(false);
  const [annotationCount, setAnnotationCount] = useState(0);

  const candidateSummary = useMemo(() => {
    if (!batch) return '尚未采集页面候选';
    const channels = new Map<string, number>();
    for (const candidate of batch.candidates) {
      const provenance = Array.isArray(candidate.metadata?.capture_provenance)
        ? candidate.metadata.capture_provenance as Array<{ channel?: string }>
        : [{ channel: candidate.capture_channel }];
      for (const source of provenance) {
        const channel = source.channel || candidate.capture_channel;
        channels.set(channel, (channels.get(channel) || 0) + 1);
      }
    }
    return `${batch.candidates.length} 个融合候选 · ${Array.from(channels.entries()).map(([key, count]) => `${channelLabel(key)} ${count}`).join(' · ')}`;
  }, [batch]);

  const typeSummary = useMemo(() => {
    if (!batch) return '';
    const counts = new Map<string, number>();
    for (const candidate of batch.candidates) {
      counts.set(candidate.candidate_type, (counts.get(candidate.candidate_type) || 0) + 1);
    }
    return Array.from(counts.entries()).map(([key, count]) => `${candidateTypeLabel(key)} ${count}`).join(' · ');
  }, [batch]);

  function resetCaptureState() {
    setError(null);
    setPlan(null);
    setBatch(null);
    setCreatedJob(null);
    setFavoriteItem(null);
    setConfirmedIds(new Set());
    setAnnotationCount(0);
    setCaptureOpen(false);
  }

  async function startSelection() {
    resetCaptureState();
    setStatus('selecting');
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

  async function automaticScan() {
    resetCaptureState();
    setStatus('scanning');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('未找到当前标签页');
      const response = await requestAutomaticScan(tab.id);
      if (!response?.ok) throw new Error(response?.error || '自动扫描失败');
      if (!response.batch?.candidates?.length) throw new Error('当前可见区域没有发现明显资源');
      setBatch(response.batch as CaptureBatch);
      setStatus('idle');
    } catch (scanError) {
      setStatus('error');
      setError(scanError instanceof Error ? scanError.message : '自动扫描失败');
    }
  }

  async function analyze() {
    if (!batch) {
      setStatus('error');
      setError('请先智能框选，或自动扫描当前页面。');
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
      setCaptureOpen(false);
      setStatus('idle');
      try {
        const count = await projectPlanToPage(batch, nextPlan);
        setAnnotationCount(count);
      } catch (annotationError) {
        console.warn('Unable to project ResourcePlan to page', annotationError);
        setAnnotationCount(0);
      }
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

  async function locateCandidate(candidateId: string) {
    if (!batch) return;
    const tabId = await batchTabId(batch);
    if (!tabId) return;
    try {
      await sendContentMessage(tabId, {
        type: 'XUNLEI_ZHIQU_FOCUS_CANDIDATE',
        batch,
        candidateId
      });
    } catch (focusError) {
      console.warn('Unable to focus candidate', focusError);
    }
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

  const busy = ['selecting', 'scanning', 'analyzing', 'creating', 'favoriting'].includes(status);

  return (
    <main className="panel-shell stage-c-extension">
      <header className="brand-row stage-c-brand">
        <div className="brand-mark stage-b-bird" aria-hidden="true"><Bird size={20} strokeWidth={2.4} /></div>
        <div><strong>迅雷智取 Lens</strong><span>智能多选 · 节点 A 真实分析</span></div>
        <span className="prototype-badge">Stage C</span>
      </header>

      <section className={`hero-card stage-c-hero ${batch ? 'compact' : ''}`}>
        <div>
          <p className="eyebrow">{batch?.trigger === 'automatic' ? 'AUTO DISCOVERY' : 'SELECTIONSCOPE'}</p>
          <h1>{batch?.page.title || '从真实网页发现并理解资源'}</h1>
          <p>{candidateSummary}</p>
        </div>
        <div className="stage-c-capture-actions">
          <button className="secondary-button stage-c-select" onClick={startSelection} disabled={busy}>
            {status === 'selecting' ? <LoaderCircle className="spin" size={17} /> : <MousePointer2 size={17} />}
            {status === 'selecting' ? '等待框选…' : batch ? '重新框选' : '智能框选'}
          </button>
          <button className="secondary-button stage-c-scan" onClick={automaticScan} disabled={busy}>
            {status === 'scanning' ? <LoaderCircle className="spin" size={17} /> : <Search size={17} />}
            {status === 'scanning' ? '扫描中…' : '自动扫描'}
          </button>
        </div>
      </section>

      {error && <div className="notice stage-c-error" role="status"><TriangleAlert size={16} /><span>{error}</span></div>}

      {batch && (
        <section className="candidate-card stage-c-candidates compact-card">
          <button className="compact-section-toggle" type="button" onClick={() => setCaptureOpen((open) => !open)} aria-expanded={captureOpen}>
            <span>{captureOpen ? <ChevronDown size={17} /> : <ChevronRight size={17} />}</span>
            <span className="compact-section-copy">
              <strong>候选融合</strong>
              <small>{batch.trigger === 'automatic' ? '自动扫描' : '矩形框选'} · {typeSummary || '待分类'}</small>
            </span>
            <b>{batch.candidates.length}</b>
          </button>
          {captureOpen && (
            <div className="capture-disclosure-body">
              <div className="selection-facts">
                {batch.selection?.rect && <span>范围 {Math.round(batch.selection.rect.width)} × {Math.round(batch.selection.rect.height)}</span>}
                <span>只硬过滤无效协议与完全重复</span>
                <span>点击候选可在网页定位</span>
              </div>
              <div className="candidate-list stage-c-candidate-scroll">
                {batch.candidates.map((candidate) => (
                  <button className="candidate-row stage-c-candidate" type="button" key={candidate.candidate_id} onClick={() => locateCandidate(candidate.candidate_id)}>
                    <span className="file-dot" />
                    <span>
                      <strong>{candidate.display_name || candidate.anchor_text || candidate.candidate_id}</strong>
                      <small>{candidate.candidate_id} · {candidate.candidate_type} · overlap {Math.round((candidate.selection_overlap || 0) * 100)}% · {provenanceLabel(candidate)}</small>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      <button className="primary-button stage-c-analyze" onClick={analyze} disabled={!batch || busy}>
        {status === 'analyzing' ? <LoaderCircle className="spin" size={18} /> : <BrainCircuit size={18} />}
        {status === 'analyzing' ? '节点 A 正在理解与比较…' : '让节点 A 分析候选'}
      </button>

      {plan && (
        <section className="plan-card stage-c-plan" aria-live="polite">
          <div className="section-heading stage-c-plan-heading">
            <div><p className="eyebrow">ResourcePlan · {plan.provider}</p><h2>{plan.resource_title}</h2></div>
            <Check size={18} />
          </div>
          <p className="overview">{plan.overview}</p>
          <div className="ai-plan-note"><BrainCircuit size={15} /><span>这是节点 A 的分析，不是最终决定。你可以重新勾选后再创建任务。</span></div>
          {annotationCount > 0 && <div className="page-projection-note"><Check size={14} /><span>已在真实网页标注 {annotationCount} 个候选；点击网页上的“最建议 / 备用 / 待确认 / 不建议”可直接看解释。</span></div>}

          <EditablePlanGroup title="AI 建议" tone="selected" group="selected" items={plan.selected} confirmedIds={confirmedIds} onToggle={toggleItem} />

          <div className="stage-c-primary-decision">
            <div className="confirmation-summary compact-confirmation">
              <span>当前确认</span><strong>{confirmedIds.size} 项</strong><small>ResourcePlan 是建议，只有勾选项进入任务。</small>
            </div>
            <div className="delivery-block compact-delivery">
              <div className="delivery-title"><strong>交付到</strong><span>可稍后修改</span></div>
              <div className="delivery-choices" role="group" aria-label="交付位置">
                <button type="button" className={deliveryTarget === 'local' ? 'delivery-choice active' : 'delivery-choice'} onClick={() => !createdJob && setDeliveryTarget('local')} disabled={Boolean(createdJob)}><HardDrive size={17} /><span><strong>本地下载</strong><small>D:/Downloads</small></span></button>
                <button type="button" className={deliveryTarget === 'cloud' ? 'delivery-choice active' : 'delivery-choice'} onClick={() => !createdJob && setDeliveryTarget('cloud')} disabled={Boolean(createdJob)}><Cloud size={17} /><span><strong>保存到云盘</strong><small>迅雷云盘</small></span></button>
              </div>
            </div>
            <div className="stage-b-plan-actions stage-c-top-actions">
              <button className={`stage-b-favorite ${favoriteItem ? 'active' : ''}`} type="button" onClick={favoriteResource} disabled={status === 'favoriting' || Boolean(favoriteItem)}>{status === 'favoriting' ? <LoaderCircle className="spin" size={17} /> : <Star size={17} fill={favoriteItem ? 'currentColor' : 'none'} />}{favoriteItem ? '已收藏' : '收藏'}</button>
              <button className="primary-button compact stage-b-create" type="button" onClick={createResourceJob} disabled={status === 'creating' || Boolean(createdJob) || confirmedIds.size === 0}>{status === 'creating' ? <LoaderCircle className="spin" size={18} /> : <Download size={17} />}{status === 'creating' ? '正在创建…' : createdJob ? '任务已创建' : `按确认结果创建任务 (${confirmedIds.size})`}</button>
            </div>
          </div>

          <CollapsiblePlanGroup title="备用方案" tone="alternative" group="alternatives" items={plan.alternatives} confirmedIds={confirmedIds} onToggle={toggleItem} />
          <CollapsiblePlanGroup title="不确定项" tone="uncertain" group="uncertainties" items={plan.uncertainties} confirmedIds={confirmedIds} onToggle={toggleItem} />
          <CollapsiblePlanGroup title="AI 不建议" tone="excluded" group="excluded" items={plan.excluded} confirmedIds={confirmedIds} onToggle={toggleItem} />

          {plan.recommendations.length > 0 && <ScenarioDisclosure plan={plan} />}

          {favoriteItem && <div className="stage-b-result success" role="status"><Star size={15} fill="currentColor" /><div><strong>已收藏：{favoriteItem.title}</strong><span>{favoriteItem.display_link}</span></div><button type="button" onClick={() => openTaskCenter('links')}><ExternalLink size={14} />查看收藏</button></div>}
          {createdJob && <div className="stage-b-result" role="status"><span className="file-dot" /><div><strong>已进入任务中心：{createdJob.title}</strong><span>用户确认 {confirmedIds.size} 项 · {createdJob.stage_label}</span></div><button type="button" onClick={() => openTaskCenter('downloads')}><ExternalLink size={14} />打开任务中心</button></div>}

          <div className="stage-c-sticky-action">
            <span>已选 <strong>{confirmedIds.size}</strong> 项</span>
            <button type="button" onClick={createResourceJob} disabled={status === 'creating' || Boolean(createdJob) || confirmedIds.size === 0}>
              {createdJob ? '任务已创建' : status === 'creating' ? '创建中…' : '创建任务'}
            </button>
          </div>
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
      {items.map((item) => <EditablePlanItem key={item.item_id} item={item} group={group} checked={confirmedIds.has(item.item_id)} onToggle={onToggle} />)}
    </div>
  );
}

function CollapsiblePlanGroup(props: {
  title: string;
  items: PlanItem[];
  tone: string;
  group: PlanGroupKey;
  confirmedIds: Set<string>;
  onToggle: (itemId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!props.items.length) return null;
  return (
    <div className={`plan-disclosure ${props.tone}`}>
      <button type="button" className="plan-disclosure-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span>{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
        <strong>{props.title}</strong>
        <b>{props.items.length}</b>
      </button>
      {open && <EditablePlanGroup {...props} title="" />}
    </div>
  );
}

function EditablePlanItem({ item, group, checked, onToggle }: {
  item: PlanItem;
  group: PlanGroupKey;
  checked: boolean;
  onToggle: (itemId: string) => void;
}) {
  return (
    <button type="button" className={`editable-plan-item ${checked ? 'confirmed' : ''}`} onClick={() => onToggle(item.item_id)}>
      <span className={`plan-check ${checked ? 'checked' : ''}`}>{checked && <Check size={13} />}</span>
      <span className="editable-plan-copy">
        <strong>{item.label}<small>{groupLabel(group)}</small></strong>
        <p>{item.plain_explanation}</p>
        <em>{item.reason}</em>
        <code>{item.candidate_ids.join(', ')}</code>
      </span>
    </button>
  );
}

function ScenarioDisclosure({ plan }: { plan: ResourcePlan }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="scenario-block compact-scenario">
      <button type="button" className="plan-disclosure-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span>{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
        <strong>场景化建议</strong>
        <b>{plan.recommendations.length}</b>
      </button>
      {open && <div className="scenario-content">{plan.recommendations.map((recommendation, index) => (
        <div key={`${recommendation.scenario}-${index}`}><span>{scenarioLabel(recommendation.scenario)}</span><p>{recommendation.summary}</p></div>
      ))}</div>}
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
function candidateTypeLabel(type: string): string {
  return ({ file: '文件', media: '媒体', magnet: 'Magnet', image: '图片', page: '页面', unknown: '待识别' } as Record<string, string>)[type] || type;
}
function groupLabel(group: PlanGroupKey): string {
  return ({ selected: 'AI 推荐', alternatives: '备用', uncertainties: '待确认', excluded: 'AI 不建议' } as Record<PlanGroupKey, string>)[group];
}
function scenarioLabel(scenario: string): string {
  return ({ current_device: '当前设备', compatibility: '兼容优先', quality: '质量优先', small_size: '体积优先', manual: '手动选择' } as Record<string, string>)[scenario] || scenario;
}

async function requestRectangleSelection(tabId: number) {
  return sendContentMessage(tabId, { type: 'XUNLEI_ZHIQU_START_SELECTION', tabId });
}

async function requestAutomaticScan(tabId: number) {
  return sendContentMessage(tabId, { type: 'XUNLEI_ZHIQU_AUTO_SCAN', tabId });
}

async function projectPlanToPage(batch: CaptureBatch, plan: ResourcePlan): Promise<number> {
  const tabId = await batchTabId(batch);
  if (!tabId) return 0;
  const response = await sendContentMessage(tabId, {
    type: 'XUNLEI_ZHIQU_RENDER_PLAN',
    batch,
    plan
  });
  return response?.ok && typeof response.count === 'number' ? response.count : 0;
}

async function batchTabId(batch: CaptureBatch): Promise<number | null> {
  if (typeof batch.tab_id === 'number') return batch.tab_id;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function sendContentMessage(tabId: number, message: Record<string, unknown>) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!isMissingContentScriptError(error)) throw error;
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    } catch (injectionError) {
      const detail = injectionError instanceof Error ? injectionError.message : String(injectionError);
      throw new Error(`当前页面尚未连接迅雷智取，自动注入失败：${detail}`);
    }
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (retryError) {
      const detail = retryError instanceof Error ? retryError.message : String(retryError);
      throw new Error(`已重新注入网页采集脚本，但通信仍失败：${detail}`);
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
