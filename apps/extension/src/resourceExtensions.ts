export type ResourceFamilyHint =
  | 'software'
  | 'document'
  | 'video'
  | 'audio'
  | 'image'
  | 'subtitle'
  | 'model'
  | 'design'
  | 'archive'
  | 'disk_image'
  | 'unknown';

export type ResourceExtensionHint = {
  extension: string;
  family: ResourceFamilyHint;
  candidateType: 'file' | 'media' | 'image';
  ambiguous: boolean;
  possibleFamilies: ResourceFamilyHint[];
};

type RegistryEntry = {
  family: ResourceFamilyHint;
  extensions: readonly string[];
  candidateType?: ResourceExtensionHint['candidateType'];
};

const REGISTRY: readonly RegistryEntry[] = [
  {
    family: 'document',
    extensions: [
      'txt', 'epub', 'mobi', 'chm', 'prc', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx',
      'pdf', 'xmind', 'odt', 'azw3', 'azw', 'djvu', 'cbr', 'cbz', 'rtf', 'csv', 'wps',
      'et', 'dps', 'vsd', 'vsdx', 'mpp', 'ods', 'odp', 'md'
    ]
  },
  {
    family: 'subtitle',
    extensions: ['srt', 'vtt', 'sbv', 'ass', 'dfxp', 'ttml', 'ssa', 'sub', 'idx', 'mpl2', 'smi']
  },
  {
    family: 'video',
    candidateType: 'media',
    extensions: [
      '3g2', '3gp', 'asf', 'asx', 'avi', 'av1', 'dat', 'divx', 'dv', 'f4v', 'flv',
      'm2t', 'm2ts', 'm3u8', 'mpd', 'm4v', 'mkv', 'mov', 'mp4', 'mpe', 'mpeg', 'mpg',
      'qt', 'rm', 'rmvb', 'swf', 'tp', 'ts', 'vob', 'webm', 'wmv', 'xv', 'xvx'
    ]
  },
  {
    family: 'audio',
    candidateType: 'media',
    extensions: [
      'aac', 'aiff', 'amr', 'ape', 'flac', 'm4a', 'mid', 'mka', 'mp3', 'mpga',
      'ogg', 'opus', 'ra', 'vqf', 'wav', 'wma', 'dsf', 'dff', 'wv', 'tak', 'tta'
    ]
  },
  {
    family: 'image',
    candidateType: 'image',
    extensions: [
      'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'cr2', 'dcm', 'exif', 'fpx',
      'hdri', 'heic', 'heif', 'jxl', 'jxr', 'pcd', 'pcx', 'raw', 'tga', 'tif', 'tiff'
    ]
  },
  {
    family: 'design',
    extensions: ['ai', 'cdr', 'dwg', 'dxf', 'eps', 'psd', 'wmf']
  },
  {
    family: 'model',
    extensions: ['pth', 'pt', 'ckpt', 'onnx', 'gguf', 'safetensors']
  },
  {
    family: 'archive',
    extensions: [
      '7z', 'ar', 'arj', 'bz2', 'cab', 'cbr', 'cbz', 'gz', 'lz', 'lzh', 'rar', 'sit',
      'tar', 'tgz', 'xz', 'z', 'zip', 'hqx', 'torrent'
    ]
  },
  {
    family: 'disk_image',
    extensions: ['esd', 'iso', 'img', 'wim', 'gho', 'vmdk', 'qcow2', 'vdi']
  },
  {
    family: 'software',
    extensions: [
      'apk', 'apks', 'appx', 'crx', 'deb', 'dmg', 'elf', 'exe', 'ipa', 'jar', 'msi',
      'msix', 'pkg', 'rpm', 'appimage', 'xapk', 'run', 'dll', 'msu'
    ]
  }
];

// These extensions are useful discovery signals but cannot carry a single final meaning.
// Keep the primary hint conservative and expose the alternatives to Node A.
const AMBIGUOUS: Readonly<Record<string, ResourceFamilyHint[]>> = {
  bin: ['model', 'software', 'unknown'],
  dds: ['image', 'design', 'model'],
  stl: ['design', 'model'],
  dat: ['video', 'unknown'],
  cbr: ['document', 'archive'],
  cbz: ['document', 'archive']
};

const EXTRA_AMBIGUOUS_PRIMARY: Readonly<Record<string, ResourceFamilyHint>> = {
  bin: 'model',
  dds: 'image',
  stl: 'design'
};

const extensionIndex = new Map<string, ResourceExtensionHint>();

for (const entry of REGISTRY) {
  for (const rawExtension of entry.extensions) {
    const extension = normalizeExtension(rawExtension);
    const existing = extensionIndex.get(extension);
    const possibleFamilies = existing
      ? Array.from(new Set([...existing.possibleFamilies, entry.family]))
      : [entry.family];
    extensionIndex.set(extension, {
      extension,
      family: existing?.family ?? entry.family,
      candidateType: existing?.candidateType ?? entry.candidateType ?? 'file',
      ambiguous: possibleFamilies.length > 1,
      possibleFamilies
    });
  }
}

for (const [extension, families] of Object.entries(AMBIGUOUS)) {
  const existing = extensionIndex.get(extension);
  const family = EXTRA_AMBIGUOUS_PRIMARY[extension] ?? existing?.family ?? families[0] ?? 'unknown';
  extensionIndex.set(extension, {
    extension,
    family,
    candidateType: existing?.candidateType ?? (family === 'video' || family === 'audio' ? 'media' : family === 'image' ? 'image' : 'file'),
    ambiguous: true,
    possibleFamilies: Array.from(new Set([...(existing?.possibleFamilies ?? []), ...families]))
  });
}

export function resourceExtensionHint(valueOrFilename: string): ResourceExtensionHint | null {
  const extension = extensionFromValue(valueOrFilename);
  if (!extension) return null;
  const hint = extensionIndex.get(extension);
  return hint ? { ...hint, possibleFamilies: [...hint.possibleFamilies] } : null;
}

export function isKnownResourceExtension(valueOrFilename: string): boolean {
  return resourceExtensionHint(valueOrFilename) !== null;
}

export function extensionFromValue(valueOrFilename: string): string | null {
  let filename = valueOrFilename.trim();
  if (!filename || filename.toLowerCase().startsWith('magnet:')) return null;

  try {
    const url = new URL(filename, typeof window !== 'undefined' ? window.location.href : 'https://local.invalid/');
    filename = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
  } catch {
    filename = filename.split(/[?#]/, 1)[0] || filename;
  }

  const match = filename.toLowerCase().match(/\.([a-z0-9]{1,16})$/i);
  return match?.[1] ? normalizeExtension(match[1]) : null;
}

export function candidateTypeFromResourceExtension(valueOrFilename: string): ResourceExtensionHint['candidateType'] | null {
  return resourceExtensionHint(valueOrFilename)?.candidateType ?? null;
}

export function resourceFamilyMetadata(valueOrFilename: string): Record<string, string | boolean | null> {
  const hint = resourceExtensionHint(valueOrFilename);
  if (!hint) {
    return {
      resource_family_hint: null,
      resource_family_ambiguous: false,
      resource_family_candidates: null
    };
  }
  return {
    resource_family_hint: hint.family,
    resource_family_ambiguous: hint.ambiguous,
    resource_family_candidates: hint.possibleFamilies.join(',')
  };
}

function normalizeExtension(value: string): string {
  return value.replace(/^\./, '').trim().toLowerCase();
}
