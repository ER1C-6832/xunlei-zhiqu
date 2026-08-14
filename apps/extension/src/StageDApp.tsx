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
  buildLocalResourcePreview,
  type LocalResourcePreview,
  useAnalysisProgress
} from './analysisProgress';
import { useZhiquCapabilities } from './hooks/useZhiquCapabilities';
import {
  buildAlternativeGroups,
  recommendationForItem,
  type PresentedResourceGroup
} from './resourcePresentation';
import { zhiquService } from './services/zhiquServiceClient';

// Keep this duplicated intentionally: side-panel entry must not import content-script modules,
// otherwise Rollup can extract a shared ESM chunk that MV3 content_scripts cannot execute.
const AUTO_DISCOVERY_STORAGE_KEY = 'zhiqu_auto_discovery_enabled';

type Status = 'idle' | 'selecting' | 'scanning' | 'analyzing' | 'creating' | 'favoriting' | 'error';
type CaptureMode = 'automatic' | 'rectangle' | 'full_page';
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
  const [taskNotice, setTaskNotice] = useState(false);
  const [discovery, setDiscovery] = useState<DiscoveryState>(EMPTY_DISCOVERY);
  const [discoveryUpdating, setDiscoveryUpdating] = useState(false);
  const capabilities = useZhiquCapabilities();
  const analysisProgress = useAnalysisProgress(status === 'analyzing');

  const alternativeGroups = useMemo(
    () => plan ? buildAlternativeGroups(plan) : [],
    [plan]
  );
  const localPreview = useMemo(
    () => batch ? buildLocalResourcePreview(batch) : null,
    [batch]
  );

  const busy = ['selecting', 'scanning', 'analyzing', 'creating', 'favoriting'].includes(status);
  const canAnalyze = capabilities?.intelligentAnalysis === true;
  const canUseTaskRuntime = capabilities?.runtimeKind === 'demo_local'
    || capabilities?.runtimeKind === 'client';
  const hasDelivery = capabilities?.localDownload === true
    || capabilities?.cloudDelivery === true;
  const selectedDeliveryAvailable = deliveryTarget === 'local'
    ? capabilities?.localDownload === true
    : capabilities?.cloudDelivery === true;

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

  useEffect(() => {
    if (!capabilities) return;
    setDeliveryTarget((current) => {
      if (current === 'local' && capabilities.localDownload) return current;
      if (current === 'cloud' && capabilities.cloudDelivery) return current;
      if (capabilities.localDownload) return 'local';
      if (capabilities.cloudDelivery) return 'cloud';
      return current;
    });
  }, [capabilities]);

  useEffect(() => {
    if (!taskNotice) return;
    const timer = window.setTimeout(() => setTaskNotice(false), 2400);
    return () => window.clearTimeout(timer);
  }, [taskNotice]);

  function prepareLocalCapture(mode: CaptureMode) {
    setError(null);
    setPlan(null);
    setBatch(null);
    setCreatedJob(null);
    setFavoriteItem(null);
    setTaskNotice(false);
    setConfirmedIds(new Set());
    setStatus(mode === 'rectangle' ? 'selecting' : 'scanning');
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
        : mode === 'full_page'
          ? await requestFullPageScan(tab.id)
          : await requestRectangleSelection(tab.id);

      if (!captureResponse?.ok) {
        const fallback = mode === 'rectangle'
          ? '框选失败'
          : mode === 'full_page'
            ? '整个网页整理失败'
            : '没有找到可整理的资源';
        throw new Error(captureResponse?.error || fallback);
      }
      if (!captureResponse.batch?.candidates?.length) {
        const fallback = mode === 'rectangle'
          ? '框选区域内没有找到可下载资源。'
          : mode === 'full_page'
            ? '整个网页没有找到明显的可下载资源。'
            : '当前页面没有找到明显的可下载资源，可以改用框选或整个网页。';
        throw new Error(fallback);
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

  async function analyzeCurrentBatch(forceRefresh = false) {
    if (!batch) return;
    if (!canAnalyze) {
      setStatus('error');
      setError('当前只提供本地资源发现，智能分析暂不可用。');
      return;
    }
    analysisProgress.begin();
    setStatus('analyzing');
    setError(null);
    setCreatedJob(null);
    setFavoriteItem(null);
    setTaskNotice(false);

    try {
      const nextPlan = await zhiquService.analyzeResources(batch, {
        forceRefresh,
        onEvent: analysisProgress.onEvent
      });
      analysisProgress.complete();
      setPlan(nextPlan);
      setConfirmedIds(new Set(nextPlan.selected.map((item) => item.item_id)));
      setStatus('idle');
      console.debug('[迅雷智取] plan', nextPlan);

      try {
        await projectPlanToPage(batch, nextPlan);
      } catch (annotationError) {
        console.warn('[迅雷智取] 无法在网页标出推荐项', annotationError);
      }
    } catch (analysisError) {
      analysisProgress.fail();
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
      setError(toggleError instanceof Error ? humanizeError(toggleError.message) : '无法修改自动发现设置。');
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

  async function focusRecommendedResource() {
    if (!batch || !plan) return;
    const tabId = await batchTabId(batch);
    if (!tabId) return;
    setError(null);

    for (const item of plan.selected) {
      for (const candidateId of item.candidate_ids) {
        try {
          const response = await sendContentMessage(tabId, {
            type: 'XUNLEI_ZHIQU_FOCUS_CANDIDATE',
            batch,
            candidateId
          });
          if (response?.ok) return;
        } catch {
          // Try the next candidate when one recommendation is not represented by a DOM element.
        }
      }
    }
    setError('网页中暂时无法定位这个下载项。');
  }

  function toggleItem(itemId: string) {
    if (createdJob || status === 'analyzing') return;
    setConfirmedIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  async function createResourceJob() {
    if (createdJob) {
      openTaskCenter('downloads');
      return;
    }
    if (!plan || !batch) return;
    if (!confirmedIds.size) {
      setStatus('error');
      setError('请至少选择一个要下载的资源。');
      return;
    }
    if (!selectedDeliveryAvailable) {
      setStatus('error');
      setError('当前没有可用的下载能力，请连接迅雷客户端后再创建任务。');
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
      const job = await zhiquService.createJob(payload);
      setCreatedJob(job);
      setTaskNotice(true);
      setStatus('idle');
    } catch (createError) {
      setStatus('error');
      setError(createError instanceof Error ? humanizeError(createError.message) : '创建下载任务失败，请重试。');
    }
  }

  async function favoriteResource() {
    if (!plan || favoriteItem) return;
    if (!canUseTaskRuntime) {
      setStatus('error');
      setError('连接迅雷客户端后可使用收藏。');
      return;
    }
    const payload: LinkFavoriteCreateRequest = { schema_version: '0.1', plan, capture: batch };
    setStatus('favoriting');
    setError(null);
    try {
      setFavoriteItem(await zhiquService.favoriteResource(payload));
      setStatus('idle');
    } catch (favoriteError) {
      setStatus('error');
      setError(favoriteError instanceof Error ? humanizeError(favoriteError.message) : '收藏失败，请重试。');
    }
  }

  function openTaskCenter(target: 'downloads' | 'links') {
    if (!canUseTaskRuntime) {
      setStatus('error');
      setError('请先连接迅雷客户端。');
      return;
    }
    void zhiquService.openTaskCenter(target);
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
              <span>{status === 'selecting' ? '等待你完成框选…' : '正在查找可下载内容…'}</span>
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
              <button className="zhiqu-secondary zhiqu-full-page-action" type="button" onClick={() => captureResources('full_page')}>
                <Search size={17} />整理整个网页
              </button>
            </div>
          )}
        </section>
      )}

      {batch && !plan && (
        <section className="zhiqu-capture-card" aria-live="polite">
          <div className="zhiqu-capture-heading">
            <div>
              <h1>发现 {batch.candidates.length} 项可下载内容</h1>
            </div>
            <Check size={20} aria-hidden="true" />
          </div>
          {captureSummary(batch) && <div className="zhiqu-capture-summary">{captureSummary(batch)}</div>}

          <CapturedResources
            batch={batch}
            onFocus={(candidateId) => void focusLocalCandidate(candidateId)}
          />

          {capabilities && !canAnalyze && (
            <div className="zhiqu-page-note">
              <span>连接智能分析服务后，可以继续比较版本并生成推荐。</span>
            </div>
          )}

          {status === 'analyzing' && localPreview ? (
            <AnalysisProgressPanel
              preview={localPreview}
              progress={analysisProgress.progress}
              label={analysisProgress.label}
            />
          ) : (
            <div className="zhiqu-capture-actions">
              <button className="zhiqu-primary" type="button" onClick={() => void analyzeCurrentBatch(false)} disabled={busy || !canAnalyze}>
                <Sparkles size={18} />{canAnalyze ? '智能分析' : '智能分析暂不可用'}
              </button>
              <div className="zhiqu-capture-secondary-actions">
                <button className="zhiqu-secondary" type="button" onClick={() => captureResources('automatic')} disabled={busy}>
                  <Search size={17} />重新扫描
                </button>
                <button className="zhiqu-secondary" type="button" onClick={() => captureResources('rectangle')} disabled={busy}>
                  <MousePointer2 size={17} />框选页面区域
                </button>
              </div>
              <button className="zhiqu-secondary zhiqu-full-page-action" type="button" onClick={() => captureResources('full_page')} disabled={busy}>
                <Search size={17} />{isFullPageBatch(batch) ? '重新整理整个网页' : '整理整个网页'}
              </button>
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
        <section className="zhiqu-result" aria-live="polite" key={plan.plan_id}>
          {status === 'analyzing' && localPreview && (
            <AnalysisProgressPanel
              preview={localPreview}
              progress={analysisProgress.progress}
              label={analysisProgress.label}
              compact
            />
          )}

          <div className="zhiqu-resource-heading">
            <div>
              <h1>{plan.resource_title}</h1>
              <p>{plan.overview}</p>
            </div>
            <Check size={20} aria-hidden="true" />
          </div>

          {capabilities?.runtimeKind === 'cloud_analysis' && (
            <div className="zhiqu-page-note">
              <span>分析已完成。连接迅雷后可创建下载任务或收藏。</span>
            </div>
          )}

          {plan.selected.length > 0 && (
            <div className="zhiqu-locate-row">
              <button type="button" onClick={() => void focusRecommendedResource()} disabled={status === 'analyzing'}>
                <MousePointer2 size={14} />定位到网页
              </button>
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
                disabled={busy || Boolean(createdJob) || capabilities?.localDownload !== true}
                title={capabilities?.localDownload === false ? '当前没有本地下载能力' : undefined}
              >
                <HardDrive size={16} /><span>本地</span>
              </button>
              <button
                type="button"
                className={deliveryTarget === 'cloud' ? 'active' : ''}
                onClick={() => !createdJob && setDeliveryTarget('cloud')}
                disabled={busy || Boolean(createdJob) || capabilities?.cloudDelivery !== true}
                title={capabilities?.cloudDelivery === false ? '当前没有云盘交付能力' : undefined}
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
              disabled={status === 'favoriting' || status === 'analyzing' || Boolean(favoriteItem) || !canUseTaskRuntime}
              title={!canUseTaskRuntime ? '连接迅雷客户端后可使用收藏' : undefined}
            >
              {status === 'favoriting' ? <LoaderCircle className="spin" size={17} /> : <Star size={17} fill={favoriteItem ? 'currentColor' : 'none'} />}
              {favoriteItem ? '已收藏' : '收藏'}
            </button>
            <button
              className="zhiqu-download"
              type="button"
              onClick={() => void createResourceJob()}
              disabled={status === 'creating' || status === 'analyzing' || (!createdJob && (confirmedIds.size === 0 || !selectedDeliveryAvailable))}
            >
              {status === 'creating'
                ? <LoaderCircle className="spin" size={18} />
                : createdJob
                  ? <ExternalLink size={18} />
                  : <Download size={18} />}
              {status === 'creating'
                ? '正在创建…'
                : createdJob
                  ? '打开任务中心'
                  : hasDelivery
                    ? '开始下载'
                    : '连接迅雷后下载'}
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
            <button
              className="zhiqu-reselect zhiqu-reanalyze-action"
              type="button"
              onClick={() => void analyzeCurrentBatch(true)}
              disabled={busy || !canAnalyze}
              title={canAnalyze ? '忽略当前缓存，再调用一次智能分析' : '当前没有智能分析能力'}
            >
              <Sparkles size={17} />
              {status === 'analyzing' ? '重新分析中…' : '重新智能分析'}
            </button>
            <button className="zhiqu-reselect" type="button" onClick={() => captureResources('automatic')} disabled={busy}>
              <Search size={17} />重新扫描当前页
            </button>
            <button className="zhiqu-reselect" type="button" onClick={() => captureResources('rectangle')} disabled={busy}>
              <MousePointer2 size={17} />框选其他区域
            </button>
            <button className="zhiqu-reselect zhiqu-full-page-action" type="button" onClick={() => captureResources('full_page')} disabled={busy}>
              <Search size={17} />整理整个网页
            </button>
          </div>

          {favoriteItem && (
            <div className="zhiqu-success" role="status">
              <Star size={16} fill="currentColor" />
              <span>已收藏到链接库</span>
              <button type="button" onClick={() => openTaskCenter('links')}><ExternalLink size={15} />查看</button>
            </div>
          )}

          {taskNotice && (
            <div className="zhiqu-success zhiqu-task-notice" role="status">
              <Check size={16} />
              <span>已创建下载任务</span>
            </div>
          )}
        </section>
      )}
    </main>
  );
}

function AnalysisProgressPanel({ preview, progress, label, compact = false }: {
  preview: LocalResourcePreview;
  progress: number;
  label: string;
  compact?: boolean;
}) {
  const safeProgress = Math.max(4, Math.min(100, progress));
  return (
    <section className={`zhiqu-analysis-progress ${compact ? 'compact' : ''}`} role="status" aria-live="polite">
      <div className="zhiqu-analysis-preview-head">
        <div>
          <strong>{preview.title}</strong>
          <span>发现 {preview.total} 项可下载内容</span>
        </div>
        <Sparkles size={18} aria-hidden="true" />
      </div>
      {preview.groups.length > 0 && (
        <div className="zhiqu-analysis-preview-groups" aria-label="本地资源概览">
          {preview.groups.map((group) => (
            <span key={group.label}>{group.label} {group.count}</span>
          ))}
        </div>
      )}
      <div
        className="zhiqu-analysis-progress-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
      >
        <span className="zhiqu-analysis-progress-fill" style={{ width: `${safeProgress}%` }} />
      </div>
      <p>{label}</p>
    </section>
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
        <strong>查看全部</strong>
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
          <strong>自动发现</strong>
          <span>
            {state.enabled
              ? state.count > 0
                ? `已发现 ${state.count} 项可下载内容`
                : '已开启'
              : '未开启'}
          </span>
        </div>
        <button
          type="button"
          className={`zhiqu-switch ${state.enabled ? 'active' : ''}`}
          aria-pressed={state.enabled}
          aria-label={state.enabled ? '关闭自动发现' : '开启自动发现'}
          disabled={disabled || updating}
          onClick={onToggle}
        >
          <span />
        </button>
      </div>

      {state.enabled && state.count > 0 && (
        <div className="zhiqu-discovery-body">
          {discoverySummary(state) && <div className="zhiqu-capture-summary">{discoverySummary(state)}</div>}
          <button className="zhiqu-local-resources-toggle" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
            <span>{open ? <ChevronDown size={17} /> : <ChevronRight size={17} />}</span>
            <strong>查看全部</strong>
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
            智能整理
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
          <p className="zhiqu-muted-help">这些资源默认未选中，需要时可以手动添加。</p>
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
    return { title: '框选下载区域', description: '拖拽覆盖你关心的下载内容。' };
  }
  if (status === 'scanning') {
    return { title: '正在查找可下载内容', description: '正在读取当前页面。' };
  }
  if (status === 'error') {
    return { title: '当前页面的下载资源', description: '可以重新整理、框选区域或整理整个网页。' };
  }
  return { title: '当前页面的下载资源', description: '扫描页面或框选区域，找到要下载的内容。' };
}

function isFullPageBatch(batch: CaptureBatch): boolean {
  return batch.metadata?.automatic_scan === 'full_page_obvious_resources'
    || batch.metadata?.capture_scope === 'full_page';
}

function captureSummary(batch: CaptureBatch): string {
  const counts = batch.candidates.reduce<Record<string, number>>((acc, candidate) => {
    const key = candidate.candidate_type;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const labels: Array<[string, string]> = [
    ['file', '文件'],
    ['media', '视频/音频'],
    ['image', '图片'],
    ['magnet', '磁力链接']
  ];
  const summary = labels
    .filter(([key]) => counts[key])
    .map(([key, label]) => `${label} ${counts[key]}`)
    .join(' · ');
  if (!summary) return '';
  return isFullPageBatch(batch) && batch.candidates.length >= 160
    ? `${summary} · 已达到单次上限`
    : summary;
}

function discoverySummary(state: DiscoveryState): string {
  const parts = [
    state.fileCount ? `文件 ${state.fileCount}` : null,
    state.mediaCount ? `视频/音频 ${state.mediaCount}` : null,
    state.magnetCount ? `磁力链接 ${state.magnetCount}` : null
  ].filter(Boolean);
  return parts.join(' · ');
}

function candidateLabel(candidate: CapturedCandidate): string {
  const anchor = candidate.anchor_text?.replace(/\s+/g, ' ').trim() || null;
  const metadataFilename = typeof candidate.metadata?.filename === 'string' ? candidate.metadata.filename : null;
  const genericAnchor = anchor && /^(download|下载|click here|here)$/i.test(anchor) ? null : anchor;
  return genericAnchor
    || candidate.display_name
    || metadataFilename
    || filenameFromValue(candidate.value)
    || '未命名资源';
}

function candidateMeta(candidate: CapturedCandidate): string {
  const host = hostFromValue(candidate.value);
  const extension = typeof candidate.metadata?.extension === 'string'
    ? candidate.metadata.extension
    : extensionFromValue(candidate.value);
  const filename = typeof candidate.metadata?.filename === 'string'
    ? candidate.metadata.filename
    : filenameFromValue(candidate.value);
  const section = candidate.section_heading?.replace(/\s+/g, ' ').trim().slice(0, 80) || null;
  const label = candidateLabel(candidate);
  const parts = [
    section,
    filename && filename !== label ? filename : null,
    host,
    extension ? extension.toUpperCase() : null
  ].filter(Boolean);
  if (candidate.candidate_type === 'page') parts.push('下载入口');
  return parts.join(' · ') || '当前页面';
}

function candidateKindLabel(candidate: CapturedCandidate): string {
  if (candidate.candidate_type === 'media') return '媒体';
  if (candidate.candidate_type === 'magnet') return '磁力';
  if (candidate.candidate_type === 'image') return '图片';
  if (candidate.candidate_type === 'file') return '文件';
  if (candidate.candidate_type === 'page') return '入口';
  return '资源';
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

async function requestFullPageScan(tabId: number) {
  return sendContentMessage(tabId, { type: 'XUNLEI_ZHIQU_FULL_PAGE_SCAN', tabId });
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
