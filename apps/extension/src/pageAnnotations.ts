import type { CaptureBatch, PlanItem, ResourcePlan } from '@xunlei-zhiqu/contracts';

type AnnotationTone = 'selected' | 'alternative' | 'uncertain' | 'excluded';

type AnnotationInfo = {
  tone: AnnotationTone;
  label: string;
  item: PlanItem;
};

const ROOT_ID = 'xunlei-zhiqu-plan-annotations';
const POPOVER_ID = 'xunlei-zhiqu-plan-popover';
const ANNOTATION_SELECTOR = '[data-xunlei-zhiqu-annotation="true"]';

export function clearPlanAnnotations(): void {
  document.getElementById(ROOT_ID)?.remove();
  document.getElementById(POPOVER_ID)?.remove();
  document.querySelectorAll<HTMLElement>(ANNOTATION_SELECTOR).forEach((element) => element.remove());
}

export function renderPlanAnnotations(batch: CaptureBatch, plan: ResourcePlan): number {
  clearPlanAnnotations();
  const lookup = buildAnnotationLookup(plan);
  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.style.position = 'absolute';
  root.style.inset = '0';
  root.style.zIndex = '2147483644';
  root.style.pointerEvents = 'none';
  document.documentElement.appendChild(root);

  let count = 0;
  for (const candidate of batch.candidates) {
    const info = lookup.get(candidate.candidate_id);
    if (!info) continue;
    const target = findCandidateElement(candidate.value);
    if (target) {
      appendInlineBadge(target, candidate.candidate_id, info);
      count += 1;
      continue;
    }
    if (candidate.dom_rect) {
      appendFloatingBadge(root, candidate.dom_rect, candidate.candidate_id, info);
      count += 1;
    }
  }

  if (!count) root.remove();
  return count;
}

export function focusCandidate(batch: CaptureBatch, candidateId: string): boolean {
  const candidate = batch.candidates.find((item) => item.candidate_id === candidateId);
  if (!candidate) return false;
  const target = findCandidateElement(candidate.value);
  if (!target) return false;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const html = target as HTMLElement;
  const previousOutline = html.style.outline;
  const previousOffset = html.style.outlineOffset;
  html.style.outline = '3px solid #2478ee';
  html.style.outlineOffset = '3px';
  window.setTimeout(() => {
    html.style.outline = previousOutline;
    html.style.outlineOffset = previousOffset;
  }, 1800);
  return true;
}

function buildAnnotationLookup(plan: ResourcePlan): Map<string, AnnotationInfo> {
  const result = new Map<string, AnnotationInfo>();
  putGroup(result, plan.excluded, 'excluded', 'AI 不建议');
  putGroup(result, plan.uncertainties, 'uncertain', '待确认');
  putGroup(result, plan.alternatives, 'alternative', '备用');
  putGroup(result, plan.selected, 'selected', '最建议');
  return result;
}

function putGroup(
  result: Map<string, AnnotationInfo>,
  items: PlanItem[],
  tone: AnnotationTone,
  label: string
): void {
  for (const item of items) {
    for (const candidateId of item.candidate_ids) {
      result.set(candidateId, { tone, label, item });
    }
  }
}

function findCandidateElement(value: string): HTMLElement | null {
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = resolveValue(anchor.getAttribute('href'));
    if (href === value) return anchor;
  }
  for (const media of document.querySelectorAll<HTMLVideoElement | HTMLAudioElement>('video, audio')) {
    const values = [media.currentSrc, media.getAttribute('src')]
      .filter((item): item is string => Boolean(item))
      .map((item) => resolveValue(item));
    if (values.includes(value)) return media;
    for (const source of media.querySelectorAll<HTMLSourceElement>('source[src]')) {
      if (resolveValue(source.getAttribute('src')) === value) return media;
    }
  }
  return null;
}

function appendInlineBadge(
  target: HTMLElement,
  candidateId: string,
  info: AnnotationInfo
): void {
  const badge = createBadge(candidateId, info);
  badge.style.marginInlineStart = '6px';
  badge.style.verticalAlign = 'middle';
  target.insertAdjacentElement('afterend', badge);
}

function appendFloatingBadge(
  root: HTMLElement,
  rect: { x: number; y: number; width: number; height: number },
  candidateId: string,
  info: AnnotationInfo
): void {
  const badge = createBadge(candidateId, info);
  badge.style.position = 'absolute';
  badge.style.left = `${Math.max(4, window.scrollX + rect.x + rect.width + 4)}px`;
  badge.style.top = `${Math.max(4, window.scrollY + rect.y)}px`;
  root.appendChild(badge);
}

function createBadge(candidateId: string, info: AnnotationInfo): HTMLButtonElement {
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.dataset.xunleiZhiquAnnotation = 'true';
  badge.dataset.xunleiZhiquCandidate = candidateId;
  badge.textContent = info.label;
  badge.title = `${info.item.label}：${info.item.plain_explanation}`;
  const colors = toneColors(info.tone);
  Object.assign(badge.style, {
    pointerEvents: 'auto',
    appearance: 'none',
    border: `1px solid ${colors.border}`,
    borderRadius: '999px',
    padding: '2px 7px',
    color: colors.text,
    background: colors.background,
    font: '600 11px/1.55 Microsoft YaHei UI, system-ui, sans-serif',
    boxShadow: '0 1px 4px rgba(30, 55, 90, .12)',
    cursor: 'pointer',
    whiteSpace: 'nowrap'
  });
  badge.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showPopover(badge, candidateId, info);
  });
  return badge;
}

function showPopover(anchor: HTMLElement, candidateId: string, info: AnnotationInfo): void {
  document.getElementById(POPOVER_ID)?.remove();
  const popover = document.createElement('div');
  popover.id = POPOVER_ID;
  const rect = anchor.getBoundingClientRect();
  const left = Math.min(window.innerWidth - 338, Math.max(12, rect.left));
  const top = Math.min(window.innerHeight - 220, Math.max(12, rect.bottom + 8));
  Object.assign(popover.style, {
    position: 'fixed',
    zIndex: '2147483647',
    left: `${left}px`,
    top: `${top}px`,
    width: '310px',
    maxHeight: '200px',
    overflow: 'auto',
    padding: '12px 14px',
    border: '1px solid #dce5f0',
    borderRadius: '10px',
    color: '#273448',
    background: '#fff',
    boxShadow: '0 14px 38px rgba(33, 54, 84, .2)',
    font: '13px/1.55 Microsoft YaHei UI, system-ui, sans-serif'
  });
  const label = document.createElement('strong');
  label.textContent = `${info.label} · ${info.item.label}`;
  label.style.display = 'block';
  label.style.marginBottom = '6px';
  label.style.fontSize = '14px';
  const explanation = document.createElement('div');
  explanation.textContent = info.item.plain_explanation;
  explanation.style.marginBottom = '7px';
  const reason = document.createElement('div');
  reason.textContent = info.item.reason;
  reason.style.color = '#6b7788';
  reason.style.fontSize = '12px';
  const meta = document.createElement('div');
  meta.textContent = candidateId;
  meta.style.marginTop = '8px';
  meta.style.color = '#8c96a4';
  meta.style.fontSize = '11px';
  popover.append(label, explanation, reason, meta);
  document.documentElement.appendChild(popover);

  const close = (event: MouseEvent) => {
    if (!popover.contains(event.target as Node) && event.target !== anchor) {
      popover.remove();
      document.removeEventListener('click', close, true);
    }
  };
  window.setTimeout(() => document.addEventListener('click', close, true), 0);
}

function toneColors(tone: AnnotationTone) {
  if (tone === 'selected') return { text: '#ffffff', background: '#1677ff', border: '#1677ff' };
  if (tone === 'alternative') return { text: '#1767bd', background: '#edf6ff', border: '#9bc8f7' };
  if (tone === 'uncertain') return { text: '#8b5a09', background: '#fff7df', border: '#efcc73' };
  return { text: '#65717f', background: '#f2f4f7', border: '#cfd6df' };
}

function resolveValue(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase().startsWith('magnet:')) return trimmed;
  try {
    return new URL(trimmed, window.location.href).toString();
  } catch {
    return null;
  }
}
