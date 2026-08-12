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
  Sparkles,
  Star,
  TriangleAlert
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  buildAlternativeGroups,
  recommendationForItem,
  type PresentedResourceGroup
} from './resourcePresentation';

const RUNTIME_URL = 'http://127.0.0.1:8765';
// Keep this duplicated intentionally: side-panel entry must not import content-script modules,
// otherwise Rollup can extract a shared ESM chunk that MV3 content_scripts cannot execute.
const AUTO_DISCOVERY_STORAGE_KEY = 'zhiqu_auto_discovery_enabled';

type Status = 'idle' | 'selecting' | 'scanning' | 'analyzing' | 'creating' | 'favoriting' | 'error';
type CaptureMode = 'automatic' | 'rectangle';
type DiscoveryKind = 'file' | 'media' | 'magnet' | 'entry';
type DiscoveryItem = {
  value: string;
  kind: DiscoveryKind;
  label: string;
  host: string | null;
  extension: string | null;
};
type DiscoveryState = {
  enabled: boolean;
  count: number;
  fileCount: number;
  mediaCount: number;
  magnetCount: number;
  entryCount: number;
  items: DiscoveryItem[];
};
type CapturedCandidate = CaptureBatch['candidates'][number];

const EMPTY_DISCOVERY: DiscoveryState = {
  enabled: false,
  count: 0,
  fileCount: 0,
  mediaCount: 0,
  magnetCount: 0,
  entryCount: 0,
  items: []
};

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
  const [discovery, setDiscovery] = useState<DiscoveryState>(EMPTY_DISCOVERY);
  const [discoveryUpdating, setDiscoveryUpdating] = useState(false);

  const alternativeGroups = useMemo(
    () => plan ? buildAlternativeGroups(plan) : [],
    [plan]
  );

  const busy = ['selecting', 'scanning', 'analyzing', 'creating', 'favoriting'].includes(status);

  useEffect(() => {
    let disposed = false;

    const syncCurrentTab = async () => {
      try {
        const values = await chrome.storage.local.get(AUTO_DISCOVERY_STORAGE_KEY);
        const enabled = values[AUTO_DISCOVERY_STORAGE_KEY] === true;
        if (!disposed) setDiscovery((current) => ({ ...current, enabled }));

        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return;
        const response = await sendContentMessage(tab.id, { type: 'XUNLEI_ZHIQU_DISCOVERY_STATUS' });
        if (!disposed && response?.ok && response.state) setDiscovery(readDiscoveryState(response.state));
      } catch {
        if (!disposed) setDiscovery((current) => ({ ...current, count: 0, items: [] }));
      }
    };

    const onDiscoveryUpdate = (message: unknown, sender: chrome.runtime.MessageSender) => {
      const update = message as { type?: string; state?: unknown };
      if (update.type !== 'XUNLEI_ZHIQU_DISCOVERY_UPDATE' || !update.state || !sender.tab?.id) return;
      void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (!disposed && tab?.id === sender.tab?.id) setDiscovery(readDiscoveryState(update.state));
      });
    };

    chrome.runtime.onMessage.addListener(onDiscoveryUpdate);
    void syncCurrentTab();
    return () => {
      disposed = true;
      chrome.runtime.onMessage.removeListener(onDiscoveryUpdate);
    };
  }, []);

  function prepareLocalCapture(mode: CaptureMode) {
    setError(null);
    setPlan(null);
    setBatch(null);
    setCreatedJob(null);
    setFavoriteItem(null);
    setConfirmedIds(new Set());
    setAnnotationCount(0);
    setStatus(mode === 'automatic' ? 'scanning' : 'selecting');
  }

  function acceptLocalBatch(nextBatch: CaptureBatch) {
    setBatch(nextBatch);
    setStatus('idle');
    console.debug('[迅雷智取] local capture', nextBatch);
  }

  async function captureResources(mode: CaptureMode) {
    prepareLocalCapture(mode);

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

      acceptLocalBatch(captureResponse.batch as CaptureBatch);
    } catch (captureError) {
      setStatus('error');
      setError(captureError instanceof Error ? humanizeError(captureError.message) : '整理失败，请重试。');
    }
  }

  async function captureDiscoveryResources() {
    prepareLocalCapture('automatic');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('未找到当前标签页');
      const response = await sendContentMessage(tab.id, { type: 'XUNLEI_ZHIQU_DISCOVERY_CAPTURE', tabId: tab.id });
      if (!response?.ok || !response.batch?.candidates?.length) {
        throw new Error(response?.error || '自动发现结果已变化，请重新查看。');
      }
      acceptLocalBatch(response.batch as CaptureBatch);
    } catch (captureError) {
      setStatus('error');
      setError(captureError instanceof Error ? humanizeError(captureError.message) : '读取自动发现结果失败。');
    }
  }

  async function analyzeCurrentBatch() {
    if (!batch) return;
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
      if (!response.ok) throw new Error(await runtimeError(response, '智能分析失败'));

      const nextPlan = (await response.json()) as ResourcePlan;
      setPlan(nextPlan);
      setConfirmedIds(new Set(nextPlan.selected.map((item) => item.item_id)));
      setStatus('idle');
      console.debug('[迅雷智取] plan', nextPlan);

      try {
        const count = await projectPlanToPage(batch, nextPlan);
        setAnnotationCount(count);
      } catch (annotationError) {
        console.warn('[迅雷智取] 无法在网页标出推荐项', annotationError);
        setAnnotationCount(0);
      }
    } catch (analysisError) {
      setStatus('error');
      setError(analysisError instanceof Error ? humanizeError(analysisError.message) : '智能分析失败，请重试。');
    }
  }

  async function toggleAutoDiscovery() {
    const nextEnabled = !discovery.enabled;
    setDiscoveryUpdating(true);
    setError(null);
    try {
      await chrome.storage.local.set({ [AUTO_DISCOVERY_STORAGE_KEY]: nextEnabled });
      setDiscovery((current) => nextEnabled ? { ...current, enabled: true } : EMPTY_DISCOVERY);

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      const response = await sendContentMessage(tab.id, {
        type: 'XUNLEI_ZHIQU_SET_AUTO_DISCOVERY',
        enabled: nextEnabled
      });
      if (response?.ok && response.state) setDiscovery(readDiscoveryState(response.state));
    } catch (toggleError) {
      setError(toggleError instanceof Error ? humanizeError(toggleError.message) : '无法修改页面自动发现设置。');
    } finally {
      setDiscoveryUpdating(false);
    }
  }

  async function focusLocalCandidate(candidateId: string) {
    if (!batch) return;
    const tabId = await batchTabId(batch);
    if (!tabId) return;
    await sendContentMessage(tabId, {
      type: 'XUNLEI_ZHIQU_FOCUS_CANDIDATE',
      batch,
      candidateId
    }).catch(() => undefined);
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

      {!plan && !batch && (
        <section className="zhiqu-start-card">
          <div className="zhiqu-start-copy">
            <h1>{statusCopy(status).title}</h1>
            <p>{statusCopy(status).description}</p>
          </div>

          {(status === 'selecting' || status === 'scanning') && (
            <div className="zhiqu-working" role="status">
              <LoaderCircle className="spin" size={20} />
              <span>{status === 'selecting' ? '等待你完成框选…' : '正在本地查找资源…'}</span>
            </div>
          )}

          {!busy && (
            <div className="zhiqu-start-actions">
              <button className="zhiqu-primary" type="button" onClick={() => captureResources('automatic')}>
                <Search size={18} />智能整理
              </button>
              <button className="zhiqu-secondary" type="button" onClick={() => captureResources('rectangle')}>
                <MousePointer2 size={18} />框选页面区域
              </button>
            </div>
          )}
        </section>
      )}

      {batch && !plan && (
        <section className="zhiqu-capture-card" aria-live="polite">
          <div className="zhiqu-capture-heading">
            <div>
              <h1>{capturePathTitle(batch)} · {batch.candidates.length} 项</h1>
              <p>{capturePathDescription(batch)}</p>
            </div>
            <Check size={20} aria-hidden="true" />
          </div>
          <div className="zhiqu-capture-summary">{captureSummary(batch)}</div>

          <CapturedResources
            batch={batch}
            onFocus={(candidateId) => void focusLocalCandidate(candidateId)}
          />

          {status === 'analyzing' ? (
            <div className="zhiqu-working" role="status">
              <LoaderCircle className="spin" size={20} />
              <span>正在整理版本、平台和格式…</span>
            </div>
          ) : (
            <div className="zhiqu-capture-actions">
              <button className="zhiqu-primary" type="button" onClick={analyzeCurrentBatch} disabled={busy}>
                <Sparkles size={18} />智能分析
              </button>
              <div className="zhiqu-capture-secondary-actions">
                <button className="zhiqu-secondary" type="button" onClick={() => captureResources('automatic')} disabled={busy}>
                  <Search size={17} />重新扫描
                </button>
                <button className="zhiqu-secondary" type="button" onClick={() => captureResources('rectangle')} disabled={busy}>
                  <MousePointer2 size={17} />框选页面区域
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {!plan && (
        <DiscoveryControl
          state={discovery}
          updating={discoveryUpdating}
          disabled={busy}
          onToggle={toggleAutoDiscovery}
          onUseCandidates={() => void captureDiscoveryResources()}
        />
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

          <div className="zhiqu-reselect-actions">
            <button className="zhiqu-reselect" type="button" onClick={() => captureResources('automatic')} disabled={busy}>
              <Search size={17} />重新扫描当前页
            </button>
            <button className="zhiqu-reselect" type="button" onClick={() => captureResources('rectangle')} disabled={busy}>
              <MousePointer2 size={17} />框选其他区域
            </button>
          </div>

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

function CapturedResources({ batch, onFocus }: {
  batch: CaptureBatch;
  onFocus: (candidateId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="zhiqu-local-resources">
      <button className="zhiqu-local-resources-toggle" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span>{open ? <ChevronDown size={17} /> : <ChevronRight size={17} />}</span>
        <strong>查看候选资源</strong>
        <b>{batch.candidates.length}</b>
      </button>
      {open && (
        <div className="zhiqu-local-resource-list">
          {batch.candidates.map((candidate) => (
            <button
              className="zhiqu-local-resource-row"
              type="button"
              key={candidate.candidate_id}
              onClick={() => onFocus(candidate.candidate_id)}
              title="在网页中定位这个资源"
            >
              <span className="zhiqu-local-resource-main">
                <strong>{candidateLabel(candidate)}</strong>
                <small>{candidateMeta(candidate)}</small>
              </span>
              <em>{candidateKindLabel(candidate)}</em>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function DiscoveryControl({ state, updating, disabled, onToggle, onUseCandidates }: {
  state: DiscoveryState;
  updating: boolean;
  disabled: boolean;
  onToggle: () => void;
  onUseCandidates: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="zhiqu-discovery-control">
      <div className="zhiqu-discovery-head">
        <div>
          <strong>页面自动发现</strong>
          <span>
            {state.enabled
              ? state.count > 0
                ? `高置信发现 ${state.count} 项 · 与“智能整理”是不同候选路径`
                : '已开启 · 只在本地监听页面变化'
              : '关闭时不会在后台扫描页面'}
          </span>
        </div>
        <button
          type="button"
          className={`zhiqu-switch ${state.enabled ? 'active' : ''}`}
          aria-pressed={state.enabled}
          aria-label={state.enabled ? '关闭页面自动发现' : '开启页面自动发现'}
          disabled={disabled || updating}
          onClick={onToggle}
        >
          <span />
        </button>
      </div>

      {state.enabled && state.count > 0 && (
        <div className="zhiqu-discovery-body">
          <div className="zhiqu-capture-summary">{discoverySummary(state)}</div>
          <button className="zhiqu-local-resources-toggle" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
            <span>{open ? <ChevronDown size={17} /> : <ChevronRight size={17} />}</span>
            <strong>查看自动发现资源</strong>
            <b>{state.count}</b>
          </button>
          {open && (
            <div className="zhiqu-local-resource-list discovery">
              {state.items.map((item) => (
                <div className="zhiqu-local-resource-row static" key={`${item.kind}:${item.value}`}>
                  <span className="zhiqu-local-resource-main">
                    <strong>{item.label}</strong>
                    <small>{[item.host, item.extension ? item.extension.toUpperCase() : null].filter(Boolean).join(' · ') || '当前页面'}</small>
                  </span>
                  <em>{discoveryKindLabel(item.kind)}</em>
                </div>
              ))}
            </div>
          )}
          <button className="zhiqu-discovery-use" type="button" onClick={onUseCandidates} disabled={disabled}>
            使用这批资源
          </button>
        </div>
      )}
    </section>
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
    return { title: '在网页上框选资源区域', description: '拖拽覆盖你关心的下载项，松开后只做本地查找。' };
  }
  if (status === 'scanning') {
    return { title: '正在查找可下载资源', description: '只在本地查看当前页面，不会使用智能分析。' };
  }
  if (status === 'error') {
    return { title: '当前页面的下载资源', description: '可以重新智能整理，或框选一个更明确的区域。' };
  }
  return { title: '当前页面的下载资源', description: '先在本地查找资源，需要推荐时再进行智能分析。' };
}

function capturePathTitle(batch: CaptureBatch): string {
  if (batch.trigger === 'rectangle') return '框选结果';
  if (batch.metadata?.automatic_scan === 'persistent_discovery_visible_high_confidence') return '自动发现候选';
  return '当前页扫描结果';
}

function capturePathDescription(batch: CaptureBatch): string {
  if (batch.trigger === 'rectangle') return '来自你框选的区域。先查看资源，需要推荐时再智能分析。';
  if (batch.metadata?.automatic_scan === 'persistent_discovery_visible_high_confidence') return '来自页面自动发现的高置信资源。它和主动扫描可能不同。';
  return '来自当前可见页面的主动扫描。先查看资源，需要推荐时再智能分析。';
}

function captureSummary(batch: CaptureBatch): string {
  const counts = batch.candidates.reduce<Record<string, number>>((acc, candidate) => {
    const key = candidate.candidate_type;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const labels: Array<[string, string]> = [
    ['file', '文件'],
    ['media', '媒体'],
    ['magnet', 'Magnet'],
    ['image', '图片'],
    ['page', '页面'],
    ['unknown', '其他']
  ];
  return labels
    .filter(([key]) => counts[key])
    .map(([key, label]) => `${label} ${counts[key]}`)
    .join(' · ');
}

function discoverySummary(state: DiscoveryState): string {
  const parts = [
    state.fileCount ? `文件 ${state.fileCount}` : null,
    state.mediaCount ? `媒体 ${state.mediaCount}` : null,
    state.magnetCount ? `Magnet ${state.magnetCount}` : null,
    state.entryCount ? `入口 ${state.entryCount}` : null
  ].filter(Boolean);
  return parts.join(' · ') || `${state.count} 项`;
}

function candidateLabel(candidate: CapturedCandidate): string {
  const metadataFilename = typeof candidate.metadata?.filename === 'string' ? candidate.metadata.filename : null;
  return candidate.display_name
    || candidate.anchor_text
    || metadataFilename
    || filenameFromValue(candidate.value)
    || '未命名资源';
}

function candidateMeta(candidate: CapturedCandidate): string {
  const host = hostFromValue(candidate.value);
  const extension = typeof candidate.metadata?.extension === 'string'
    ? candidate.metadata.extension
    : extensionFromValue(candidate.value);
  const parts = [host, extension ? extension.toUpperCase() : null].filter(Boolean);
  if (candidate.candidate_type === 'page') parts.push('下载入口');
  if (candidate.candidate_type === 'unknown') parts.push('待识别');
  return parts.join(' · ') || '当前页面';
}

function candidateKindLabel(candidate: CapturedCandidate): string {
  if (candidate.candidate_type === 'media') return '媒体';
  if (candidate.candidate_type === 'magnet') return '磁力';
  if (candidate.candidate_type === 'image') return '图片';
  if (candidate.candidate_type === 'file') return '文件';
  if (candidate.candidate_type === 'page') return '入口';
  return '待识别';
}

function discoveryKindLabel(kind: DiscoveryKind): string {
  if (kind === 'media') return '媒体';
  if (kind === 'magnet') return '磁力';
  if (kind === 'entry') return '入口';
  return '文件';
}

function filenameFromValue(value: string): string | null {
  if (value.startsWith('magnet:')) {
    const name = value.match(/[?&]dn=([^&]+)/i)?.[1];
    if (!name) return null;
    try {
      return decodeURIComponent(name.replace(/\+/g, ' '));
    } catch {
      return name;
    }
  }
  try {
    const filename = new URL(value).pathname.split('/').filter(Boolean).pop();
    return filename ? decodeURIComponent(filename) : null;
  } catch {
    return null;
  }
}

function extensionFromValue(value: string): string | null {
  return filenameFromValue(value)?.match(/\.([a-z0-9]{1,10})$/i)?.[1]?.toLowerCase() || null;
}

function hostFromValue(value: string): string | null {
  if (value.startsWith('magnet:')) return null;
  try {
    return new URL(value).hostname || null;
  } catch {
    return null;
  }
}

function readDiscoveryState(value: unknown): DiscoveryState {
  const input = value as Partial<DiscoveryState> | null;
  const items = Array.isArray(input?.items)
    ? input.items.filter((item): item is DiscoveryItem => Boolean(
      item
      && typeof item.value === 'string'
      && typeof item.label === 'string'
      && ['file', 'media', 'magnet', 'entry'].includes(item.kind)
    ))
    : [];
  return {
    enabled: input?.enabled === true,
    count: safeNumber(input?.count),
    fileCount: safeNumber(input?.fileCount),
    mediaCount: safeNumber(input?.mediaCount),
    magnetCount: safeNumber(input?.magnetCount),
    entryCount: safeNumber(input?.entryCount),
    items
  };
}

function safeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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