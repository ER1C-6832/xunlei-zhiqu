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
import {
  buildAlternativeGroups,
  recommendationForItem,
  type PresentedResourceGroup
} from './resourcePresentation';

const RUNTIME_URL = 'http://127.0.0.1:8765';

type Status = 'idle' | 'selecting' | 'scanning' | 'analyzing' | 'creating' | 'favoriting' | 'error';
type CaptureMode = 'automatic' | 'rectangle';

export function StageDExtensionApp() {
  const [batch, setBatch] = useState<CaptureBatch | null>(null);
  const [plan, setPlan] = useState<ResourcePlan | null>(null);
  const [confirmedIds, setConfirmedIds] = useState<Set<string>>(new Set());
  const [createdJob, setCreatedJob] = useState<ResourceJobSnapshot | null>(null);
  const [favoriteItem, setFavoriteItem] = useState<LinkHistoryItem | null>(null);
  const [deliveryTarget, setDeliveryTarget] = useState<DeliveryTarget>('local');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [annotationCount, setAnnotationCount] = useState(0);

  const alternativeGroups = useMemo(
    () => plan ? buildAlternativeGroups(plan) : [],
    [plan]
  );

  const busy = ['selecting', 'scanning', 'analyzing', 'creating', 'favoriting'].includes(status);

  async function organize(mode: CaptureMode) {
    setError(null);
    setPlan(null);
    setBatch(null);
    setCreatedJob(null);
    setFavoriteItem(null);
    setConfirmedIds(new Set());
    setAnnotationCount(0);
    setStatus(mode === 'automatic' ? 'scanning' : 'selecting');

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('未找到当前标签页');

      const captureResponse = mode === 'automatic'
        ? await requestAutomaticScan(tab.id)
        : await requestRectangleSelection(tab.id);

      if (!captureResponse?.ok) {
        throw new Error(captureResponse?.error || (mode === 'automatic' ? '没有找到可整理的资源' : '框选失败'));
      }
      if (!captureResponse.batch?.candidates?.length) {
        throw new Error(mode === 'automatic' ? '当前页面没有找到明显的可下载资源，可以改用框选。' : '框选区域内没有找到可下载资源。');
      }

      const nextBatch = captureResponse.batch as CaptureBatch;
      setBatch(nextBatch);
      console.debug('[迅雷智取] capture', nextBatch);
      await analyzeBatch(nextBatch);
    } catch (captureError) {
      setStatus('error');
      setError(captureError instanceof Error ? humanizeError(captureError.message) : '整理失败，请重试。');
    }
  }

  async function analyzeBatch(nextBatch: CaptureBatch) {
    setStatus('analyzing');
    const response = await fetch(`${RUNTIME_URL}/v1/capture/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nextBatch)
    });
    if (!response.ok) throw new Error(await runtimeError(response, '智能整理失败'));

    const nextPlan = (await response.json()) as ResourcePlan;
    setPlan(nextPlan);
    setConfirmedIds(new Set(nextPlan.selected.map((item) => item.item_id)));
    setStatus('idle');
    console.debug('[迅雷智取] plan', nextPlan);

    try {
      const count = await projectPlanToPage(nextBatch, nextPlan);
      setAnnotationCount(count);
    } catch (annotationError) {
      console.warn('[迅雷智取] 无法在网页标出推荐项', annotationError);
      setAnnotationCount(0);
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
    if (!plan || !batch || createdJob) return;
    if (!confirmedIds.size) {
      setStatus('error');
      setError('请至少选择一个要下载的资源。');
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
      if (!response.ok) throw new Error(await runtimeError(response, '创建下载任务失败'));
      const job = (await response.json()) as ResourceJobSnapshot;
      setCreatedJob(job);
      setStatus('idle');
      void chrome.tabs.create({ url: `${RUNTIME_URL}/app/#/downloads` });
    } catch (createError) {
      setStatus('error');
      setError(createError instanceof Error ? humanizeError(createError.message) : '创建下载任务失败，请重试。');
    }
  }

  async function favoriteResource() {
    if (!plan || favoriteItem) return;
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
      setError(favoriteError instanceof Error ? humanizeError(favoriteError.message) : '收藏失败，请重试。');
    }
  }

  function openTaskCenter(target: 'downloads' | 'links') {
    void chrome.tabs.create({ url: `${RUNTIME_URL}/app/#/${target}` });
  }

  return (
    <main className="zhiqu-shell">
      <header className="zhiqu-header">
        <span className="zhiqu-logo" aria-hidden="true"><Bird size={21} strokeWidth={2.5} /></span>
        <strong>迅雷智取</strong>
      </header>

      {!plan && (
        <section className="zhiqu-start-card">
          <div className="zhiqu-start-copy">
            <h1>{statusCopy(status).title}</h1>
            <p>{statusCopy(status).description}</p>
          </div>

          {status === 'analyzing' && (
            <div className="zhiqu-working" role="status">
              <LoaderCircle className="spin" size={20} />
              <span>正在整理版本、平台和格式…</span>
            </div>
          )}

          {!busy && (
            <div className="zhiqu-start-actions">
              <button className="zhiqu-primary" type="button" onClick={() => organize('automatic')}>
                <Search size={18} />智能整理
              </button>
              <button className="zhiqu-secondary" type="button" onClick={() => organize('rectangle')}>
                <MousePointer2 size={18} />框选页面区域
              </button>
            </div>
          )}
        </section>
      )}

      {error && (
        <div className="zhiqu-error" role="alert">
          <TriangleAlert size={18} />
          <span>{error}</span>
        </div>
      )}

      {plan && (
        <section className="zhiqu-result" aria-live="polite">
          <div className="zhiqu-resource-heading">
            <div>
              <h1>{plan.resource_title}</h1>
              <p>{plan.overview}</p>
            </div>
            <Check size={20} aria-hidden="true" />
          </div>

          {annotationCount > 0 && (
            <div className="zhiqu-page-note">
              网页中的推荐下载项已经标出，点击“推荐”可以直接查看解释。
            </div>
          )}

          <section className="zhiqu-recommended">
            <h2>推荐下载</h2>
            {plan.selected.length ? (
              plan.selected.map((item) => (
                <ResourceChoice
                  key={item.item_id}
                  item={item}
                  checked={confirmedIds.has(item.item_id)}
                  recommendation={recommendationForItem(plan, item)}
                  emphasized
                  onToggle={toggleItem}
                />
              ))
            ) : (
              <p className="zhiqu-no-recommendation">暂时没有唯一推荐，请从“需要确认”中选择。</p>
            )}
          </section>

          <div className="zhiqu-delivery">
            <span>保存到</span>
            <div className="zhiqu-delivery-options" role="group" aria-label="保存位置">
              <button
                type="button"
                className={deliveryTarget === 'local' ? 'active' : ''}
                onClick={() => !createdJob && setDeliveryTarget('local')}
                disabled={Boolean(createdJob)}
              >
                <HardDrive size={16} /><span>本地</span>
              </button>
              <button
                type="button"
                className={deliveryTarget === 'cloud' ? 'active' : ''}
                onClick={() => !createdJob && setDeliveryTarget('cloud')}
                disabled={Boolean(createdJob)}
              >
                <Cloud size={16} /><span>云盘</span>
              </button>
            </div>
          </div>

          <div className="zhiqu-action-bar">
            <button
              className="zhiqu-favorite"
              type="button"
              onClick={favoriteResource}
              disabled={status === 'favoriting' || Boolean(favoriteItem)}
            >
              {status === 'favoriting' ? <LoaderCircle className="spin" size={17} /> : <Star size={17} fill={favoriteItem ? 'currentColor' : 'none'} />}
              {favoriteItem ? '已收藏' : '收藏'}
            </button>
            <button
              className="zhiqu-download"
              type="button"
              onClick={createResourceJob}
              disabled={status === 'creating' || Boolean(createdJob) || confirmedIds.size === 0}
            >
              {status === 'creating' ? <LoaderCircle className="spin" size={18} /> : <Download size={18} />}
              {status === 'creating' ? '正在创建…' : createdJob ? '任务已创建' : '开始下载'}
            </button>
          </div>

          <div className="zhiqu-groups">
            {alternativeGroups.map((group) => (
              <ResourceGroup
                key={group.key}
                group={group}
                plan={plan}
                confirmedIds={confirmedIds}
                onToggle={toggleItem}
              />
            ))}

            {plan.uncertainties.length > 0 && (
              <ResourceGroup
                group={{ key: 'uncertain', title: '需要确认', items: plan.uncertainties }}
                plan={plan}
                confirmedIds={confirmedIds}
                onToggle={toggleItem}
              />
            )}

            {plan.excluded.length > 0 && (
              <HiddenResources
                items={plan.excluded}
                confirmedIds={confirmedIds}
                onToggle={toggleItem}
              />
            )}
          </div>

          <button className="zhiqu-reselect" type="button" onClick={() => organize('rectangle')} disabled={busy}>
            <MousePointer2 size={17} />框选其他区域
          </button>

          {favoriteItem && (
            <div className="zhiqu-success" role="status">
              <Star size={16} fill="currentColor" />
              <span>已收藏到链接库</span>
              <button type="button" onClick={() => openTaskCenter('links')}><ExternalLink size={15} />查看</button>
            </div>
          )}

          {createdJob && (
            <div className="zhiqu-success" role="status">
              <Check size={16} />
              <span>任务已加入迅雷智取任务中心</span>
              <button type="button" onClick={() => openTaskCenter('downloads')}><ExternalLink size={15} />打开</button>
            </div>
          )}
        </section>
      )}
    </main>
  );
}

function ResourceGroup({ group, plan, confirmedIds, onToggle }: {
  group: PresentedResourceGroup;
  plan: ResourcePlan;
  confirmedIds: Set<string>;
  onToggle: (itemId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="zhiqu-group">
      <button className="zhiqu-group-toggle" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span>{open ? <ChevronDown size={17} /> : <ChevronRight size={17} />}</span>
        <strong>{group.title}</strong>
        <b>{group.items.length}</b>
      </button>
      {open && (
        <div className="zhiqu-group-body">
          {group.items.map((item) => (
            <ResourceChoice
              key={item.item_id}
              item={item}
              checked={confirmedIds.has(item.item_id)}
              recommendation={recommendationForItem(plan, item)}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function HiddenResources({ items, confirmedIds, onToggle }: {
  items: PlanItem[];
  confirmedIds: Set<string>;
  onToggle: (itemId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="zhiqu-group zhiqu-all-resources">
      <button className="zhiqu-group-toggle" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span>{open ? <ChevronDown size={17} /> : <ChevronRight size={17} />}</span>
        <strong>查看全部资源</strong>
        <b>{items.length}</b>
      </button>
      {open && (
        <div className="zhiqu-group-body">
          <p className="zhiqu-muted-help">这些资源默认被忽略。需要时仍可以手动选择。</p>
          {items.map((item) => (
            <ResourceChoice
              key={item.item_id}
              item={item}
              checked={confirmedIds.has(item.item_id)}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ResourceChoice({ item, checked, recommendation, emphasized = false, onToggle }: {
  item: PlanItem;
  checked: boolean;
  recommendation?: string | null;
  emphasized?: boolean;
  onToggle: (itemId: string) => void;
}) {
  return (
    <button
      className={`zhiqu-choice ${checked ? 'selected' : ''} ${emphasized ? 'recommended' : ''}`}
      type="button"
      aria-pressed={checked}
      onClick={() => onToggle(item.item_id)}
    >
      <span className="zhiqu-check" aria-hidden="true">{checked && <Check size={14} />}</span>
      <span className="zhiqu-choice-copy">
        <strong>{item.label}{emphasized && <em>推荐</em>}</strong>
        <p>{item.plain_explanation}</p>
        {recommendation && <small>{recommendation}</small>}
      </span>
    </button>
  );
}

function statusCopy(status: Status) {
  if (status === 'selecting') {
    return { title: '在网页上框选资源区域', description: '拖拽覆盖你关心的下载项，完成后会自动整理。' };
  }
  if (status === 'scanning') {
    return { title: '正在查找可下载资源', description: '只在本地查看当前页面，找到资源后再进行智能整理。' };
  }
  if (status === 'analyzing') {
    return { title: '正在整理下载资源', description: '正在把版本、平台、格式和附件整理成少量可理解的选择。' };
  }
  if (status === 'error') {
    return { title: '当前页面的下载资源', description: '可以重新智能整理，或框选一个更明确的区域。' };
  }
  return { title: '当前页面的下载资源', description: '让迅雷智取帮你整理复杂的版本、格式和附件。' };
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
      throw new Error(`当前页面无法启用迅雷智取：${detail}`);
    }
    return chrome.tabs.sendMessage(tabId, message);
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
    const detail = body.detail ? humanizeError(body.detail) : `HTTP ${response.status}`;
    return `${fallback}：${detail}`;
  } catch {
    return `${fallback}：HTTP ${response.status}`;
  }
}

function humanizeError(value: string): string {
  return value
    .replaceAll('节点 A', '智能整理')
    .replaceAll('ResourcePlan', '整理结果')
    .replaceAll('EvidencePack', '资源信息')
    .replaceAll('candidate_id', '资源标识')
    .replaceAll('candidate', '资源项')
    .replaceAll('MODEL_BASE_URL', '模型服务地址')
    .replaceAll('MODEL_API_KEY', '模型服务密钥')
    .replaceAll('MODEL_MAX_COMPLETION_TOKENS', '模型输出上限');
}
