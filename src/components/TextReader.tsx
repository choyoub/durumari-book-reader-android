import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReaderSettings } from "../types";
import { loadPagination, savePagination } from "../lib/libraryStore";

interface Props {
  text: string;
  cacheKey: string;
  settings: ReaderSettings;
  initialProgress: number;
  onProgress: (progress: number) => void;
  navRef: React.MutableRefObject<{ next: () => void | Promise<void>; previous: () => void | Promise<void>; go: (p: number) => void | Promise<void> } | null>;
  onPageInfo: (current: number, total: number, indexing: boolean) => void;
}

interface PaginationInput {
  text: string;
  width: number;
  height: number;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  bold: boolean;
}

function glyphWidth(code: number, fontSize: number, letterSpacing: number, bold: boolean) {
  let ratio = 1;
  if (code === 32 || code === 9) ratio = code === 9 ? 1.32 : .33;
  else if (code < 128) {
    if ((code >= 65 && code <= 90) || (code >= 48 && code <= 57)) ratio = .6;
    else if (code >= 97 && code <= 122) ratio = .53;
    else ratio = .42;
  } else if (code >= 0x2000 && code <= 0x206f) ratio = .5;
  return fontSize * ratio * (bold ? 1.035 : 1) + letterSpacing;
}

async function paginateInline(data: PaginationInput, isDisposed: () => boolean) {
  const lineLimit = Math.max(1, data.width);
  const maxLines = Math.max(1, Math.floor(data.height / Math.max(1, data.fontSize * data.lineHeight)));
  const starts: number[] = [0];
  let line = 0;
  let lineWidth = 0;

  for (let index = 0; index < data.text.length; index++) {
    if (isDisposed()) return null;
    if (index > 0 && index % 50_000 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    const code = data.text.charCodeAt(index);
    if (code === 13) continue;
    if (code === 10) {
      line++;
      lineWidth = 0;
      if (line >= maxLines && index + 1 < data.text.length) {
        starts.push(index + 1);
        line = 0;
      }
      continue;
    }
    const width = glyphWidth(code, data.fontSize, data.letterSpacing, data.bold);
    if (lineWidth > 0 && lineWidth + width > lineLimit) {
      line++;
      lineWidth = 0;
      if (line >= maxLines) {
        starts.push(index);
        line = 0;
      }
    }
    lineWidth += width;
  }
  if (starts[starts.length - 1] !== data.text.length) starts.push(data.text.length);
  return Int32Array.from(starts);
}

export function TextReader({ text, cacheKey, settings, initialProgress, onProgress, navRef, onPageInfo }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef(Math.max(0, Math.min(1, initialProgress)));
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [starts, setStarts] = useState<Int32Array | null>(null);
  const [page, setPage] = useState(0);

  const contentWidth = Math.max(160, size.width - settings.paddingLeft - settings.paddingRight);
  const contentHeight = Math.max(160, size.height - settings.paddingTop - settings.paddingBottom);
  const signature = useMemo(() => [
    "p3", cacheKey, text.length, contentWidth, contentHeight, settings.fontFamily,
    settings.fontSize, settings.isBold ? 1 : 0, settings.lineHeight, settings.letterSpacing
  ].join("|"), [cacheKey, contentHeight, contentWidth, settings.fontFamily, settings.fontSize,
    settings.isBold, settings.letterSpacing, settings.lineHeight, text.length]);

  useEffect(() => {
    if (!hostRef.current) return;
    const observer = new ResizeObserver(([entry]) => setSize({
      width: Math.floor(entry.contentRect.width),
      height: Math.floor(entry.contentRect.height)
    }));
    observer.observe(hostRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!text || size.width <= 0 || size.height <= 0) return;
    let disposed = false;
    let worker: Worker | null = null;
    setStarts(null);
    const apply = (result: Int32Array) => {
      if (disposed || result.length < 2 || result[result.length - 1] !== text.length) return;
      const total = result.length - 1;
      setStarts(result);
      setPage(Math.min(total - 1, Math.round(progressRef.current * Math.max(0, total - 1))));
    };
    const input: PaginationInput = {
      text, width: contentWidth, height: contentHeight, fontSize: settings.fontSize,
      lineHeight: settings.lineHeight, letterSpacing: settings.letterSpacing, bold: settings.isBold
    };
    const generateInline = () => {
      void paginateInline(input, () => disposed).then((result) => {
        if (!result || disposed) return;
        apply(result);
        void savePagination(signature, result);
      });
    };
    const generate = () => {
      if ((window as any).ReactNativeWebView) {
        generateInline();
        return;
      }
      worker = new Worker(new URL("../workers/paginationWorker.ts", import.meta.url), { type: "module" });
      worker.onmessage = ({ data }: MessageEvent<Int32Array>) => {
        const result = data instanceof Int32Array ? data : new Int32Array(data);
        apply(result);
        void savePagination(signature, result);
        worker?.terminate();
        worker = null;
      };
      worker.onerror = () => {
        worker?.terminate();
        worker = null;
        generateInline();
      };
      worker.postMessage(input);
    };
    void loadPagination(signature).then((cached) => {
      if (disposed) return;
      if (cached && cached[cached.length - 1] === text.length) {
        apply(cached);
        return;
      }
      generate();
    }).catch(generate);
    return () => { disposed = true; worker?.terminate(); };
  }, [contentHeight, contentWidth, settings.fontSize, settings.isBold, settings.letterSpacing,
      settings.lineHeight, signature, size.height, size.width, text]);

  const totalPages = starts ? starts.length - 1 : 1;
  const pageText = starts ? text.slice(starts[page], starts[page + 1]) : "";

  useEffect(() => {
    if (!starts) return;
    const progress = totalPages <= 1 ? 0 : page / (totalPages - 1);
    progressRef.current = progress;
    onProgress(progress);
    onPageInfo(page + 1, totalPages, false);
  }, [onPageInfo, onProgress, page, starts, totalPages]);

  const next = useCallback(() => setPage((value) => Math.min(totalPages - 1, value + 1)), [totalPages]);
  const previous = useCallback(() => setPage((value) => Math.max(0, value - 1)), []);
  const go = useCallback((progress: number) => {
    const safe = Math.max(0, Math.min(1, progress));
    setPage(Math.min(totalPages - 1, Math.round(safe * Math.max(0, totalPages - 1))));
  }, [totalPages]);

  useEffect(() => {
    navRef.current = { next, previous, go };
    return () => { navRef.current = null; };
  }, [go, navRef, next, previous]);

  return <div ref={hostRef} className="reader-host text-reader">
    {starts && <article
      className="reader-typography text-page"
      style={{
        fontFamily: settings.fontFamily,
        fontSize: settings.fontSize,
        fontWeight: settings.isBold ? 700 : 400,
        lineHeight: settings.lineHeight,
        letterSpacing: `${settings.letterSpacing}px`,
        padding: `${settings.paddingTop}px ${settings.paddingRight}px ${settings.paddingBottom}px ${settings.paddingLeft}px`
      }}
    >{pageText}</article>}
    {!starts && <div className="position-loading">페이지를 준비하는 중...</div>}
  </div>;
}
