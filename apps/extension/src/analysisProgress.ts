import type {
  AnalysisPhase,
  AnalysisStreamEvent,
  CaptureBatch,
  CapturedResourceCandidate
} from '@xunlei-zhiqu/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

const LATENCY_STORAGE_KEY = 'zhiqu_node_a_latency_history_ms';
const DEFAULT_NODE_A_LATENCY_MS = 5600;
const MAX_LATENCY_SAMPLES = 9;

type PreviewGroup = {
  label: string;
  count: number;
};

export type LocalResourcePreview = {
  title: string;
  total: number;
  groups: PreviewGroup[];
};

export type AnalysisProgressController = {
  progress: number;
  label: string;
  begin: () => void;
  onEvent: (event: AnalysisStreamEvent) => void;
  complete: () => void;
  fail: () => void;
};

export function buildLocalResourcePreview(batch: CaptureBatch): LocalResourcePreview {
  const counts = new Map<string, number>();
  for (const candidate of batch.candidates) {
    const group = deterministicPreviewGroup(candidate);
    if (!group) continue;
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }

  const order = ['Windows', 'macOS', 'Linux', '源码', '相关附件', '媒体', '图片', 'Magnet'];
  const groups = order
    .filter((label) => counts.has(label))
    .map((label) => ({ label, count: counts.get(label) ?? 0 }))
    .slice(0, 5);

  return {
    title: compactText(batch.page.title, 72) || '当前页面资源',
    total: batch.candidates.length,
    groups
  };
}

export function useAnalysisProgress(active: boolean): AnalysisProgressController {
  const [progress, setProgress] = useState(0);
  const [label, setLabel] = useState('整理已发现资源');
  const phaseRef = useRef<AnalysisPhase | null>(null);
  const startedAtRef = useRef(0);
  const modelStartedAtRef = useRef<number | null>(null);
  const medianLatencyRef = useRef(DEFAULT_NODE_A_LATENCY_MS);
  const cacheHitRef = useRef(false);

  const begin = useCallback(() => {
    startedAtRef.current = performance.now();
    modelStartedAtRef.current = null;
    phaseRef.current = null;
    cacheHitRef.current = false;
    setProgress(12);
    setLabel('整理已发现资源');
    void readLatencyMedian().then((value) => {
      medianLatencyRef.current = value;
    });
  }, []);

  const onEvent = useCallback((event: AnalysisStreamEvent) => {
    if (event.type !== 'phase') return;
    phaseRef.current = event.phase;
    switch (event.phase) {
      case 'evidence_ready':
        setProgress((value) => Math.max(value, 22));
        setLabel('准备资源说明');
        break;
      case 'cache_hit':
        cacheHitRef.current = true;
        setProgress((value) => Math.max(value, 88));
        setLabel('正在恢复整理结果…');
        break;
      case 'model_request_started':
        modelStartedAtRef.current = performance.now();
        setProgress((value) => Math.max(value, 26));
        setLabel('正在理解版本区别');
        break;
      case 'model_first_token':
        setProgress((value) => Math.max(value, 55));
        setLabel('正在生成推荐');
        break;
      case 'model_completed':
        setProgress((value) => Math.max(value, 94));
        setLabel('正在确认结果');
        break;
      case 'plan_validated':
        setProgress((value) => Math.max(value, 98));
        setLabel('正在确认结果');
        break;
      case 'done':
        setProgress(100);
        setLabel('整理完成');
        break;
    }
  }, []);

  const complete = useCallback(() => {
    setProgress(100);
    setLabel('整理完成');
    const startedAt = startedAtRef.current;
    if (!cacheHitRef.current && startedAt > 0) {
      const elapsed = Math.round(performance.now() - startedAt);
      if (elapsed >= 500) void recordLatency(elapsed);
    }
  }, []);

  const fail = useCallback(() => {
    phaseRef.current = null;
    setLabel('分析未完成');
  }, []);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      const phase = phaseRef.current;
      if (phase !== 'model_request_started' && phase !== 'model_first_token') return;
      const modelStartedAt = modelStartedAtRef.current;
      if (modelStartedAt === null) return;
      const elapsed = performance.now() - modelStartedAt;
      const synthetic = interpolateModelProgress(elapsed, medianLatencyRef.current);
      setProgress((value) => Math.max(value, synthetic));
    }, 120);
    return () => window.clearInterval(timer);
  }, [active]);

  return { progress, label, begin, onEvent, complete, fail };
}

export function interpolateModelProgress(elapsedMs: number, medianMs: number): number {
  const safeMedian = clamp(medianMs, 1500, 20000);
  const ratio = Math.max(0, elapsedMs) / safeMedian;
  if (ratio >= 1) {
    return Math.min(92, 90 + (ratio - 1) * 2);
  }
  const eased = 1 - Math.pow(1 - ratio, 1.6);
  return Math.min(90, 25 + 65 * eased);
}

function deterministicPreviewGroup(candidate: CapturedResourceCandidate): string | null {
  const metadata = candidate.metadata ?? {};
  const attachment = lowerString(metadata.attachment_kind);
  const family = lowerString(metadata.resource_family_hint);
  const platform = lowerString(metadata.platform_hint);
  const extension = lowerString(metadata.extension) || extensionFromText(
    lowerString(metadata.filename) || candidate.display_name || candidate.anchor_text || ''
  );
  const text = [
    candidate.section_heading,
    candidate.display_name,
    candidate.anchor_text,
    lowerString(metadata.filename)
  ].filter((value): value is string => Boolean(value)).join(' ').toLowerCase();

  if (attachment === 'source' || /(?:\bsource\b|源码)/i.test(text)) return '源码';
  if (
    ['verification', 'subtitle', 'checksum', 'signature'].includes(attachment)
    || ['asc', 'gpg', 'md5', 'sha1', 'sha256', 'sha512', 'sig', 'sigstore', 'spdx', 'srt', 'vtt'].includes(extension)
  ) return '相关附件';

  if (platform === 'windows' || /\b(?:windows|win32|win64)\b/i.test(text)) return 'Windows';
  if (platform === 'macos' || /\b(?:macos|mac\s+os|osx|darwin)\b/i.test(text)) return 'macOS';
  if (platform === 'linux' || /\b(?:linux|ubuntu|debian|appimage)\b/i.test(text)) return 'Linux';
  if (candidate.candidate_type === 'media' || ['video', 'audio'].includes(family)) return '媒体';
  if (candidate.candidate_type === 'image' || family === 'image') return '图片';
  if (candidate.candidate_type === 'magnet') return 'Magnet';
  return null;
}

async function readLatencyMedian(): Promise<number> {
  try {
    const values = await chrome.storage.local.get(LATENCY_STORAGE_KEY);
    const samples = sanitizeSamples(values[LATENCY_STORAGE_KEY]);
    return samples.length ? median(samples) : DEFAULT_NODE_A_LATENCY_MS;
  } catch {
    return DEFAULT_NODE_A_LATENCY_MS;
  }
}

async function recordLatency(value: number): Promise<void> {
  try {
    const values = await chrome.storage.local.get(LATENCY_STORAGE_KEY);
    const samples = sanitizeSamples(values[LATENCY_STORAGE_KEY]);
    samples.push(clamp(Math.round(value), 500, 30000));
    await chrome.storage.local.set({
      [LATENCY_STORAGE_KEY]: samples.slice(-MAX_LATENCY_SAMPLES)
    });
  } catch {
    // Progress history is a UX hint only. Analysis must not fail because storage is unavailable.
  }
}

function sanitizeSamples(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
    .map((item) => clamp(Math.round(item), 500, 30000))
    .slice(-MAX_LATENCY_SAMPLES);
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle] ?? DEFAULT_NODE_A_LATENCY_MS;
  const left = sorted[middle - 1] ?? DEFAULT_NODE_A_LATENCY_MS;
  const right = sorted[middle] ?? left;
  return Math.round((left + right) / 2);
}

function lowerString(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function extensionFromText(value: string): string {
  return value.match(/\.([a-z0-9]{1,10})(?:\?.*)?$/i)?.[1]?.toLowerCase() ?? '';
}

function compactText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
