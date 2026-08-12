import type { PlanItem, ResourcePlan } from '@xunlei-zhiqu/contracts';

export interface PresentedResourceGroup {
  key: string;
  title: string;
  items: PlanItem[];
}

const GROUP_ORDER = [
  'windows',
  'macos',
  'linux',
  'other-platform',
  'source',
  'quality',
  'format',
  'install-form',
  'attachment',
  'more'
];

export function buildAlternativeGroups(plan: ResourcePlan): PresentedResourceGroup[] {
  const groups = new Map<string, PresentedResourceGroup>();

  for (const item of plan.alternatives) {
    const group = classifyItem(plan, item);
    const existing = groups.get(group.key);
    if (existing) existing.items.push(item);
    else groups.set(group.key, { ...group, items: [item] });
  }

  return Array.from(groups.values()).sort(
    (left, right) => GROUP_ORDER.indexOf(left.key) - GROUP_ORDER.indexOf(right.key)
  );
}

export function recommendationForItem(plan: ResourcePlan, item: PlanItem): string | null {
  const ranked = [...plan.recommendations].sort((left, right) => {
    const order = ['current_device', 'compatibility', 'quality', 'small_size', 'manual'];
    return order.indexOf(left.scenario) - order.indexOf(right.scenario);
  });
  const recommendation = ranked.find((entry) => entry.item_ids.includes(item.item_id));
  return recommendation?.summary || null;
}

function classifyItem(plan: ResourcePlan, item: PlanItem): Omit<PresentedResourceGroup, 'items'> {
  const text = searchableText(item);

  if (isAttachment(item, text)) return { key: 'attachment', title: '相关附件' };
  if (/(source|source code|tarball|源码|源代码|源文件)/i.test(text)) return { key: 'source', title: '源码' };

  if (/(windows|win32|win64)/i.test(text)) return { key: 'windows', title: '其他 Windows 版本' };
  if (/(macos|mac os|os x)/i.test(text)) return { key: 'macos', title: 'macOS' };
  if (/\blinux\b/i.test(text)) return { key: 'linux', title: 'Linux' };
  if (/(android|ios|ipad|iphone)/i.test(text)) return { key: 'other-platform', title: '其他平台' };

  if (plan.resource_type === 'video' && /(2160p|1440p|1080p|720p|480p|4k|8k|resolution|分辨率|清晰度)/i.test(text)) {
    return { key: 'quality', title: '其他清晰度' };
  }

  if (plan.resource_type === 'software' && /(portable|installer|embedded|embeddable|安装|便携|免安装|嵌入)/i.test(text)) {
    return { key: 'install-form', title: '其他安装方式' };
  }

  if (looksLikeFormatChoice(plan, text)) return { key: 'format', title: '其他格式' };

  return { key: 'more', title: '更多资源' };
}

function searchableText(item: PlanItem): string {
  const attributes = Object.entries(item.technical_attributes || {})
    .map(([key, value]) => `${key}:${String(value ?? '')}`)
    .join(' ');
  return `${item.label} ${item.plain_explanation} ${item.reason} ${attributes}`.toLowerCase();
}

function isAttachment(item: PlanItem, text: string): boolean {
  if (item.role === 'attachment') return true;
  return /(sigstore|signature|gpg|\.asc\b|sbom|spdx|checksum|sha-?\d*|md5|签名|校验|物料清单|字幕|subtitle|language pack|语言包|readme|说明文件)/i.test(text);
}

function looksLikeFormatChoice(plan: ResourcePlan, text: string): boolean {
  if (plan.resource_type === 'video') return /(mp4|mkv|webm|mov|avi|m3u8|h\.?264|h\.?265|hevc|av1|vp9)/i.test(text);
  if (plan.resource_type === 'audio') return /(flac|mp3|aac|ape|wav|opus|m4a|ogg|dsf|dff)/i.test(text);
  if (plan.resource_type === 'image') return /(png|jpe?g|webp|gif|svg|tiff?|heic|raw|jxl)/i.test(text);
  if (plan.resource_type === 'document') return /(pdf|epub|mobi|azw3?|docx?|xlsx?|pptx?|odt|ods|odp|md|txt)/i.test(text);
  if (plan.resource_type === 'subtitle') return /(srt|vtt|ass|ssa|sub|ttml|dfxp|sbv)/i.test(text);
  if (plan.resource_type === 'model') return /(gguf|safetensors|onnx|ckpt|\.pt\b|\.pth\b|quant|量化|fp16|int8|q[2-8])/i.test(text);
  if (plan.resource_type === 'design') return /(psd|\.ai\b|cdr|dwg|dxf|eps|stl)/i.test(text);
  if (plan.resource_type === 'archive') return /(zip|7z|rar|tar|gz|xz|bz2|tgz)/i.test(text);
  if (plan.resource_type === 'disk_image') return /(iso|img|wim|esd|vmdk|qcow2|vdi|gho)/i.test(text);
  return false;
}
