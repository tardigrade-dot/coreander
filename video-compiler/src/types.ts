export interface Resolution {
  width: number;
  height: number;
}

export interface AuthConfig {
  email?: string;
  password?: string;
}

export interface Config {
  slug: string;
  epubPath?: string;
  baseUrl?: string;
  chapterIndex?: number;
  chapterIndexEnd?: number;
  chapters?: number[];
  chapterId?: string;
  resolution?: Resolution;
  headless?: boolean;
  recordAllChapters?: boolean;
  auth?: AuthConfig;
  outputDir?: string;
  ttsEngine?: 'external' | 'supertonic';
}

export interface FrameEntry {
  file: string;
  timestamp: number;
}

export interface RecordingManifestEntry {
  file: string;
  duration: number;
}
