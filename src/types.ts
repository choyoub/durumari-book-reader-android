export type BookKind = "epub" | "txt" | "zip";

export interface FolderSource {
  id: string;
  name: string;
  kind: "local" | "gdrive";
  path?: string;
  gdriveFolderId?: string;
  handle?: any;
}

export interface OpenedBook {
  id: string;
  name: string;
  kind: BookKind;
  bytes?: ArrayBuffer;
  rawBytes?: ArrayBuffer;
  file?: File;
  path?: string;
  text?: string;
  openedAt: number;
  sourceId?: string;
}

export interface SortConfig {
  column: string;
  direction: "asc" | "desc" | "none";
}

export interface ReaderSettings {
  fontFamily: string;
  fontSize: number;
  isBold: boolean;
  lineHeight: number;
  letterSpacing: number;
  paddingTop: number;
  paddingBottom: number;
  paddingLeft: number;
  paddingRight: number;
  paddingLinked: boolean;
  pageTurnTouch: boolean;
  pageTurnSwipe: boolean;
  pageTurnVolume: boolean;
  pageTurnAnimation: boolean;
  hideCompleted: boolean;
  theme: "paper" | "light" | "dark" | "system";
  librarySort: SortConfig;
  historySort: SortConfig;
  bookmarksSort: SortConfig;
}

export interface HistoryItem {
  id: string;
  name: string;
  kind: BookKind;
  progress: number;
  openedAt: number;
}
