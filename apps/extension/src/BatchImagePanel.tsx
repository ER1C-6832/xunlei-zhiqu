import type { CaptureBatch, ManualJobCreateRequest } from '@xunlei-zhiqu/contracts';
import { ArrowLeft, Check, Images, LoaderCircle, RefreshCw, Send } from 'lucide-react';
import { useMemo, useState } from 'react';
import { zhiquService } from './services/zhiquServiceClient';

type ImageFilter = 'all' | 'large' | 'original';
type ImageCandidate = CaptureBatch['candidates'][number];

export function BatchImagePanel() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [batch, setBatch] = useState<CaptureBatch | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<ImageFilter>('all');
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(() => {
    const items = batch?.candidates || [];
    if (filter === 'original') return items.filter(isPossibleOriginal);
    if (filter === 'large') return items.filter(isLargeImage);
    return items;
  }, [batch, filter]);

  async function openAndScan() {
    setOpen(true);
    await scanImages();
  }

  async function scanImages() {
    setLoading(true);
    setError(null);
    setSelected(new Set());
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('未找到当前标签页');
      const response = await sendContentMessage(tab.id, {
        type: 'XUNLEI_ZHIQU_IMAGE_SCAN',
        tabId: tab.id
      });
      if (!response?.ok || !response.batch?.candidates?.length) {
        throw new Error(response?.error || '当前页面没有发现图片');
      }
      setBatch(response.batch as CaptureBatch);
    } catch (scanError) {
      setBatch(null);
      setError(scanError instanceof Error ? scanError.message : '批量图片扫描失败');
    } finally {
      setLoading(false);
    }
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < 50) next.add(id);
      return next;
    });
  }

  function selectVisible() {
    setSelected(new Set(visible.slice(0, 50).map((candidate) => candidate.candidate_id)));
  }

  async function createBatchJob() {
    if (!batch || !selected.size) return;
    const links = batch.candidates
      .filter((candidate) => selected.has(candidate.candidate_id) && /^https?:/i.test(candidate.value))
      .map((candidate) => candidate.value)
      .slice(0, 50);
    if (!links.length) {
      setError('当前选择没有可直接交给任务中心的 HTTP/HTTPS 图片链接。');
      return;
    }

    setCreating(true);
    setError(null);
    try {
      const payload: ManualJobCreateRequest = {
        schema_version: '0.1',
        links,
        title: `批量图片（${links.length} 张）`,
        delivery_target: 'local'
      };
      await zhiquService.createManualJob(payload);
      await zhiquService.openTaskCenter('downloads');
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '创建批量图片任务失败');
    } finally {
      setCreating(false);
    }
  }

  if (!open) {
    return (
      <button className="zhiqu-image-launcher" type="button" onClick={() => void openAndScan()}>
        <Images size={17} />批量图片
      </button>
    );
  }

  return (
    <section className="zhiqu-image-panel" aria-label="批量图片">
      <header className="zhiqu-image-header">
        <button type="button" className="zhiqu-image-icon-button" onClick={() => setOpen(false)} aria-label="返回">
          <ArrowLeft size={19} />
        </button>
        <div>
          <strong>批量图片</strong>
          <span>{batch ? `发现 ${batch.candidates.length} 张` : '扫描当前网页'}</span>
        </div>
        <button type="button" className="zhiqu-image-icon-button" onClick={() => void scanImages()} disabled={loading} aria-label="重新扫描">
          <RefreshCw size={17} className={loading ? 'spin' : undefined} />
        </button>
      </header>

      <div className="zhiqu-image-filters">
        <button type="button" className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部</button>
        <button type="button" className={filter === 'large' ? 'active' : ''} onClick={() => setFilter('large')}>大图</button>
        <button type="button" className={filter === 'original' ? 'active' : ''} onClick={() => setFilter('original')}>可能原图</button>
      </div>

      {loading && (
        <div className="zhiqu-image-empty"><LoaderCircle className="spin" size={22} />正在扫描 img、srcset、picture 和背景图…</div>
      )}
      {error && <div className="zhiqu-image-error">{error}</div>}

      {!loading && batch && (
        <>
          <div className="zhiqu-image-selection-bar">
            <span>已选 {selected.size} / 最多 50</span>
            <div>
              <button type="button" onClick={selectVisible}>选择当前</button>
              <button type="button" onClick={() => setSelected(new Set())}>清空</button>
            </div>
          </div>

          <div className="zhiqu-image-grid">
            {visible.map((candidate) => (
              <ImageTile
                key={candidate.candidate_id}
                candidate={candidate}
                selected={selected.has(candidate.candidate_id)}
                onToggle={() => toggle(candidate.candidate_id)}
              />
            ))}
          </div>

          {!visible.length && <div className="zhiqu-image-empty">这个筛选条件下没有图片。</div>}

          <footer className="zhiqu-image-footer">
            <button type="button" className="zhiqu-primary" disabled={!selected.size || creating} onClick={() => void createBatchJob()}>
              {creating ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}
              交给任务中心（{selected.size}）
            </button>
          </footer>
        </>
      )}
    </section>
  );
}

function ImageTile({ candidate, selected, onToggle }: {
  candidate: ImageCandidate;
  selected: boolean;
  onToggle: () => void;
}) {
  const metadata = candidate.metadata || {};
  const width = numberMeta(metadata.natural_width) || numberMeta(metadata.rendered_width);
  const height = numberMeta(metadata.natural_height) || numberMeta(metadata.rendered_height);
  const extension = stringMeta(metadata.extension)?.toUpperCase() || formatFromUrl(candidate.value);
  const original = isPossibleOriginal(candidate);
  const previewable = /^https?:/i.test(candidate.value);

  return (
    <button type="button" className={`zhiqu-image-tile${selected ? ' selected' : ''}`} onClick={onToggle}>
      <span className="zhiqu-image-thumb">
        {previewable ? <img src={candidate.value} alt="" loading="lazy" /> : <Images size={25} />}
        {selected && <span className="zhiqu-image-check"><Check size={13} /></span>}
      </span>
      <span className="zhiqu-image-meta">
        <strong>{candidate.display_name || '网页图片'}</strong>
        <span>{width && height ? `${width} × ${height}` : '尺寸未知'}{extension ? ` · ${extension}` : ''}</span>
        <span>{original ? '可能原图' : imageSourceLabel(stringMeta(metadata.image_source))}</span>
      </span>
    </button>
  );
}

function isLargeImage(candidate: ImageCandidate): boolean {
  const metadata = candidate.metadata || {};
  const width = numberMeta(metadata.natural_width) || numberMeta(metadata.rendered_width) || 0;
  const height = numberMeta(metadata.natural_height) || numberMeta(metadata.rendered_height) || 0;
  return width >= 1000 || height >= 800 || width * height >= 1_000_000;
}

function isPossibleOriginal(candidate: ImageCandidate): boolean {
  return candidate.metadata?.possible_original === true;
}

function numberMeta(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

function stringMeta(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function formatFromUrl(value: string): string | null {
  try {
    return new URL(value).pathname.match(/\.([a-z0-9]{2,8})$/i)?.[1]?.toUpperCase() || null;
  } catch {
    return null;
  }
}

function imageSourceLabel(source: string | null): string {
  if (source === 'srcset' || source === 'picture_source') return '响应式图片';
  if (source === 'css_background') return '背景图片';
  if (source === 'linked_original') return '链接原图';
  return '网页图片';
}

async function sendContentMessage(tabId: number, message: Record<string, unknown>): Promise<any> {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!/receiving end does not exist|could not establish connection/i.test(detail)) throw error;
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tabId, message);
  }
}