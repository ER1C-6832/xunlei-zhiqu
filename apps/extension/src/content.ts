import type { CaptureBatch, DomRect, ResourcePlan } from '@xunlei-zhiqu/contracts';
import { buildAutomaticCaptureBatch, buildFullPageCaptureBatch } from './autoCapture';
import { buildCaptureBatchFromRect } from './capture';
import { enrichFusedCandidateMetadata } from './captureEnrichment';
import { clearPlanAnnotations, focusCandidate, renderPlanAnnotations } from './pageAnnotations';
import {
  applyPersistentDiscoveryEnabled,
  getPersistentDiscoveryState,
  initializePersistentDiscovery,
  refreshPersistentDiscovery
} from './persistentDiscovery';

type CaptureResponse =
  | { ok: true; batch: CaptureBatch }
  | { ok: false; error: string };

let activeCleanup: (() => void) | null = null;

function startRectangleSelection(
  tabId: number | undefined,
  sendResponse: (response: CaptureResponse) => void
): void {
  activeCleanup?.();
  clearPlanAnnotations();

  const overlay = document.createElement('div');
  overlay.id = 'xunlei-zhiqu-selection-overlay';
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483646',
    cursor: 'crosshair',
    background: 'rgba(26, 104, 220, 0.035)',
    userSelect: 'none',
    touchAction: 'none'
  });

  const hint = document.createElement('div');
  hint.textContent = '迅雷智取：拖拽框选资源区域 · Esc 取消';
  Object.assign(hint.style, {
    position: 'fixed',
    top: '18px',
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '10px 16px',
    borderRadius: '10px',
    color: '#fff',
    background: 'rgba(25,31,42,.88)',
    font: '600 14px/1.4 Microsoft YaHei UI, system-ui, sans-serif',
    boxShadow: '0 8px 28px rgba(0,0,0,.18)'
  });

  const box = document.createElement('div');
  Object.assign(box.style, {
    position: 'fixed',
    display: 'none',
    border: '2px solid #2478ee',
    borderRadius: '5px',
    background: 'rgba(36,120,238,.12)',
    boxShadow: '0 0 0 1px rgba(255,255,255,.7) inset'
  });

  overlay.append(hint, box);
  document.documentElement.appendChild(overlay);

  let startX = 0;
  let startY = 0;
  let dragging = false;
  let responded = false;

  const cleanup = () => {
    overlay.remove();
    window.removeEventListener('keydown', onKeyDown, true);
    activeCleanup = null;
  };
  const finish = (response: CaptureResponse) => {
    if (responded) return;
    responded = true;
    cleanup();
    sendResponse(response);
  };
  const updateBox = (x: number, y: number) => {
    const left = Math.min(startX, x);
    const top = Math.min(startY, y);
    const width = Math.abs(x - startX);
    const height = Math.abs(y - startY);
    Object.assign(box.style, {
      display: 'block',
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`
    });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') finish({ ok: false, error: '已取消智能框选' });
  };

  overlay.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    overlay.setPointerCapture(event.pointerId);
    updateBox(event.clientX, event.clientY);
    event.preventDefault();
  });

  overlay.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    updateBox(event.clientX, event.clientY);
    event.preventDefault();
  });

  overlay.addEventListener('pointerup', (event) => {
    if (!dragging) return;
    dragging = false;
    const rect: DomRect = {
      x: Math.min(startX, event.clientX),
      y: Math.min(startY, event.clientY),
      width: Math.abs(event.clientX - startX),
      height: Math.abs(event.clientY - startY)
    };
    if (rect.width < 8 || rect.height < 8) {
      finish({ ok: false, error: '框选范围太小，请覆盖实际资源区域' });
      return;
    }

    overlay.style.display = 'none';
    requestAnimationFrame(() => {
      try {
        const batch = enrichFusedCandidateMetadata(buildCaptureBatchFromRect(rect, tabId));
        if (!batch.candidates.length) finish({ ok: false, error: '框选区域内没有发现候选资源' });
        else finish({ ok: true, batch });
      } catch (error) {
        finish({ ok: false, error: error instanceof Error ? error.message : '框选采集失败' });
      }
    });
  });

  window.addEventListener('keydown', onKeyDown, true);
  activeCleanup = cleanup;
}

function runAutomaticScan(tabId: number | undefined): CaptureResponse {
  activeCleanup?.();
  clearPlanAnnotations();
  try {
    const batch = enrichFusedCandidateMetadata(buildAutomaticCaptureBatch(tabId));
    if (!batch.candidates.length) {
      return { ok: false, error: '当前可见区域没有发现明显的文件、媒体、Magnet 或下载入口；可改用框选或整个网页。' };
    }
    return { ok: true, batch };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '自动扫描失败' };
  }
}

function runFullPageScan(tabId: number | undefined): CaptureResponse {
  activeCleanup?.();
  clearPlanAnnotations();
  try {
    const batch = enrichFusedCandidateMetadata(buildFullPageCaptureBatch(tabId));
    if (!batch.candidates.length) {
      return { ok: false, error: '整个网页没有发现明显的文件、媒体、Magnet 或下载入口。' };
    }
    return { ok: true, batch };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '整个网页扫描失败' };
  }
}

function runPersistentDiscoveryCapture(tabId: number | undefined): CaptureResponse {
  activeCleanup?.();
  clearPlanAnnotations();
  try {
    const discovery = refreshPersistentDiscovery();
    const wanted = new Set(discovery.items.map((item) => discoveryIdentity(item.value)));
    if (!wanted.size) {
      return { ok: false, error: '当前可见区域没有自动发现到高置信资源。' };
    }

    const rect: DomRect = {
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: window.innerHeight
    };
    const base = enrichFusedCandidateMetadata(buildCaptureBatchFromRect(rect, tabId));
    const candidates = base.candidates.filter((candidate) => wanted.has(discoveryIdentity(candidate.value)));
    if (!candidates.length) {
      return { ok: false, error: '自动发现结果已变化，请等待页面稳定后重试。' };
    }

    return {
      ok: true,
      batch: {
        ...base,
        trigger: 'automatic',
        selection: {
          type: 'automatic',
          candidate_ids: candidates.map((candidate) => candidate.candidate_id),
          rect
        },
        candidates,
        metadata: {
          ...(base.metadata || {}),
          capture_version: 'stage-d.3',
          automatic_scan: 'persistent_discovery_visible_high_confidence',
          capture_scope: 'viewport',
          discovery_count: discovery.count
        }
      }
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '自动发现候选读取失败' };
  }
}

function discoveryIdentity(value: string): string {
  if (!value.toLowerCase().startsWith('magnet:')) return value;
  const match = value.match(/[?&]xt=urn:btih:([^&]+)/i);
  return match?.[1] ? `magnet:btih:${decodeURIComponent(match[1]).toLowerCase()}` : value;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'XUNLEI_ZHIQU_START_SELECTION' || message?.type === 'XUNLEI_ZHIQU_CAPTURE') {
    startRectangleSelection(typeof message.tabId === 'number' ? message.tabId : undefined, sendResponse);
    return true;
  }

  if (message?.type === 'XUNLEI_ZHIQU_AUTO_SCAN') {
    sendResponse(runAutomaticScan(typeof message.tabId === 'number' ? message.tabId : undefined));
    return false;
  }

  if (message?.type === 'XUNLEI_ZHIQU_FULL_PAGE_SCAN') {
    sendResponse(runFullPageScan(typeof message.tabId === 'number' ? message.tabId : undefined));
    return false;
  }

  if (message?.type === 'XUNLEI_ZHIQU_DISCOVERY_CAPTURE') {
    sendResponse(runPersistentDiscoveryCapture(typeof message.tabId === 'number' ? message.tabId : undefined));
    return false;
  }

  if (message?.type === 'XUNLEI_ZHIQU_RENDER_PLAN') {
    const count = renderPlanAnnotations(message.batch as CaptureBatch, message.plan as ResourcePlan);
    sendResponse({ ok: true, count });
    return false;
  }

  if (message?.type === 'XUNLEI_ZHIQU_CLEAR_PLAN') {
    clearPlanAnnotations();
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'XUNLEI_ZHIQU_FOCUS_CANDIDATE') {
    const focused = focusCandidate(message.batch as CaptureBatch, String(message.candidateId || ''));
    sendResponse({ ok: focused });
    return false;
  }

  if (message?.type === 'XUNLEI_ZHIQU_SET_AUTO_DISCOVERY') {
    const state = applyPersistentDiscoveryEnabled(Boolean(message.enabled));
    sendResponse({ ok: true, state: message.enabled ? refreshPersistentDiscovery() : state });
    return false;
  }

  if (message?.type === 'XUNLEI_ZHIQU_DISCOVERY_STATUS') {
    sendResponse({ ok: true, state: getPersistentDiscoveryState() });
    return false;
  }

  return false;
});

void initializePersistentDiscovery();
