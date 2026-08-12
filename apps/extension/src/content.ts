import type { DomRect } from '@xunlei-zhiqu/contracts';
import { buildCaptureBatchFromRect } from './capture';
import { enrichFusedCandidateMetadata } from './captureEnrichment';

type CaptureResponse =
  | { ok: true; batch: ReturnType<typeof buildCaptureBatchFromRect> }
  | { ok: false; error: string };

let activeCleanup: (() => void) | null = null;

function startRectangleSelection(
  tabId: number | undefined,
  sendResponse: (response: CaptureResponse) => void
): void {
  activeCleanup?.();

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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    message?.type !== 'XUNLEI_ZHIQU_START_SELECTION'
    && message?.type !== 'XUNLEI_ZHIQU_CAPTURE'
  ) return false;

  startRectangleSelection(typeof message.tabId === 'number' ? message.tabId : undefined, sendResponse);
  return true;
});
