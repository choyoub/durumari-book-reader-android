import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReaderSettings } from "../types";
import { loadPagination, savePagination } from "../lib/libraryStore";
import { paginateStarts, type PaginationInput } from "../lib/pagination";

const PAGINATION_WORKER_TIMEOUT_MS = 30_000;

interface Props {
  text: string;
  cacheKey: string;
  settings: ReaderSettings;
  initialProgress: number;
  onProgress: (progress: number) => void;
  navRef: React.MutableRefObject<{ next: () => void | Promise<void>; previous: () => void | Promise<void>; go: (p: number) => void | Promise<void> } | null>;
  onPageInfo: (current: number, total: number, indexing: boolean) => void;
  onLoadingStatus?: (status: { active: boolean; progress: number; message: string; detail?: string }) => void;
}

export function TextReader({ text, cacheKey, settings, initialProgress, onProgress, navRef, onPageInfo, onLoadingStatus }: Props) {
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
    let workerTimeout: number | null = null;
    setStarts(null);
    onPageInfo(1, 1, true);
    onLoadingStatus?.({
      active: true,
      progress: 42,
      message: "페이지 영역을 측정하는 중...",
      detail: `${text.length.toLocaleString()}자`,
    });
    const stopWorker = () => {
      if (workerTimeout !== null) {
        window.clearTimeout(workerTimeout);
        workerTimeout = null;
      }
      worker?.terminate();
      worker = null;
    };
    const apply = (result: Int32Array) => {
      if (disposed || result.length < 2 || result[result.length - 1] !== text.length) return;
      const total = result.length - 1;
      onLoadingStatus?.({
        active: true,
        progress: 92,
        message: "첫 페이지를 펼치는 중...",
        detail: `${total.toLocaleString()}페이지`,
      });
      setStarts(result);
      setPage(Math.min(total - 1, Math.round(progressRef.current * Math.max(0, total - 1))));
    };
    const input: PaginationInput = {
      text, width: contentWidth, height: contentHeight, fontSize: settings.fontSize,
      lineHeight: settings.lineHeight, letterSpacing: settings.letterSpacing, bold: settings.isBold
    };
    const generateInline = () => {
      onLoadingStatus?.({
        active: true,
        progress: 62,
        message: "본문을 페이지로 나누는 중...",
        detail: "기기에서 직접 계산하고 있습니다.",
      });
      void paginateStarts(input, () => disposed).then((result) => {
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
      onLoadingStatus?.({
        active: true,
        progress: 62,
        message: "본문을 페이지로 나누는 중...",
        detail: "백그라운드에서 계산하고 있습니다.",
      });
      workerTimeout = window.setTimeout(() => {
        stopWorker();
        if (!disposed) generateInline();
      }, PAGINATION_WORKER_TIMEOUT_MS);
      worker.onmessage = ({ data }: MessageEvent<Int32Array>) => {
        const result = data instanceof Int32Array ? data : new Int32Array(data);
        apply(result);
        void savePagination(signature, result);
        stopWorker();
      };
      worker.onerror = () => {
        stopWorker();
        if (!disposed) generateInline();
      };
      worker.postMessage(input);
    };
    void loadPagination(signature).then((cached) => {
      if (disposed) return;
      if (cached && cached[cached.length - 1] === text.length) {
        onLoadingStatus?.({
          active: true,
          progress: 78,
          message: "저장된 페이지 정보를 불러오는 중...",
          detail: "이전에 계산한 위치를 적용합니다.",
        });
        apply(cached);
        return;
      }
      generate();
    }).catch(generate);
    return () => { disposed = true; stopWorker(); };
  }, [contentHeight, contentWidth, settings.fontSize, settings.isBold, settings.letterSpacing,
      settings.lineHeight, signature, size.height, size.width, text, onLoadingStatus, onPageInfo]);

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
