import type { CaptureBatch, PlanItem, ResourcePlan } from '@xunlei-zhiqu/contracts';

type AnnotationInfo = {
  item: PlanItem;
  recommendation: string | null;
};

const ROOT_ID = 'xunlei-zhiqu-plan-annotations';
const POPOVER_ID = 'xunlei-zhiqu-plan-popover';
const ANNOTATION_SELECTOR = '[data-xunlei-zhiqu-annotation="true"]';
const MAX_RECOMMENDED_ANNOTATIONS = 4;

export function clearPlanAnnotations(): void {
  document.getElementById(ROOT_ID)?.remove();
  document.getElementById(POPOVER_ID)?.remove();
  document.querySelectorAll<HTMLElement>(ANNOTATION_SELECTOR).forEach((element) => element.remove());
}

export function renderPlanAnnotations(batch: CaptureBatch, plan: ResourcePlan): number {
  clearPlanAnnotations();
  const lookup = buildRecommendedLookup(plan);
  if (!lookup.size) return 0;

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
      appendInlineBadge(target, info);
      count += 1;
      continue;
    }
    if (candidate.dom_rect) {
      appendFloatingBadge(root, candidate.dom_rect, info);
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
  const previousOutline = target.style.outline;
  const previousOffset = target.style.outlineOffset;
  target.style.outline = '3px solid #2478ee';
  target.style.outlineOffset = '3px';
  window.setTimeout(() => {
    target.style.outline = previousOutline;
    target.style.outlineOffset = previousOffset;
  }, 1800);
  return true;
}

function buildRecommendedLookup(plan: ResourcePlan): Map<string, AnnotationInfo> {
  const result = new Map<string, AnnotationInfo>();
  let count = 0;
  for (const item of plan.selected) {
    const recommendation = plan.recommendations.find((entry) => entry.item_ids.includes(item.item_id))?.summary || null;
    for (const candidateId of item.candidate_ids) {
      if (count >= MAX_RECOMMENDED_ANNOTATIONS) return result;
      result.set(candidateId, { item, recommendation });
      count += 1;
    }
  }
  return result;
}

function findCandidateElement(value: string): HTMLElement | null {
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (resolveValue(anchor.getAttribute('href')) === value) return anchor;
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

function appendInlineBadge(target: HTMLElement, info: AnnotationInfo): void {
  const badge = createBadge(info);
  badge.style.marginInlineStart = '6px';
  badge.style.verticalAlign = 'middle';
  target.insertAdjacentElement('afterend', badge);
}

function appendFloatingBadge(
  root: HTMLElement,
  rect: { x: number; y: number; width: number; height: number },
  info: AnnotationInfo
): void {
  const badge = createBadge(info);
  badge.style.position = 'absolute';
  badge.style.left = `${Math.max(4, window.scrollX + rect.x + rect.width + 4)}px`;
  badge.style.top = `${Math.max(4, window.scrollY + rect.y)}px`;
  root.appendChild(badge);
}

function createBadge(info: AnnotationInfo): HTMLButtonElement {
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.dataset.xunleiZhiquAnnotation = 'true';
  badge.textContent = '推荐';
  badge.title = `${info.item.label}：${info.item.plain_explanation}`;
  Object.assign(badge.style, {
    pointerEvents: 'auto',
    appearance: 'none',
    border: '1px solid #1677ff',
    borderRadius: '999px',
    padding: '2px 8px',
    color: '#ffffff',
    background: '#1677ff',
    font: '700 11px/1.55 Microsoft YaHei UI, system-ui, sans-serif',
    boxShadow: '0 2px 7px rgba(22,119,255,.2)',
    cursor: 'pointer',
    whiteSpace: 'nowrap'
  });
  badge.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showPopover(badge, info);
  });
  return badge;
}

function showPopover(anchor: HTMLElement, info: AnnotationInfo): void {
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
    padding: '13px 14px',
    border: '1px solid #dce5f0',
    borderRadius: '11px',
    color: '#273448',
    background: '#fff',
    boxShadow: '0 14px 38px rgba(33,54,84,.2)',
    font: '13px/1.55 Microsoft YaHei UI, system-ui, sans-serif'
  });

  const kicker = document.createElement('div');
  kicker.textContent = '迅雷智取推荐';
  kicker.style.marginBottom = '4px';
  kicker.style.color = '#1677ff';
  kicker.style.fontSize = '11px';
  kicker.style.fontWeight = '700';

  const label = document.createElement('strong');
  label.textContent = info.item.label;
  label.style.display = 'block';
  label.style.marginBottom = '6px';
  label.style.fontSize = '15px';

  const explanation = document.createElement('div');
  explanation.textContent = info.item.plain_explanation;
  explanation.style.marginBottom = info.recommendation ? '7px' : '0';

  popover.append(kicker, label, explanation);
  if (info.recommendation) {
    const recommendation = document.createElement('div');
    recommendation.textContent = info.recommendation;
    recommendation.style.color = '#58708f';
    recommendation.style.fontSize = '12px';
    popover.appendChild(recommendation);
  }
  document.documentElement.appendChild(popover);

  const close = (event: MouseEvent) => {
    if (!popover.contains(event.target as Node) && event.target !== anchor) {
      popover.remove();
      document.removeEventListener('click', close, true);
    }
  };
  window.setTimeout(() => document.addEventListener('click', close, true), 0);
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
