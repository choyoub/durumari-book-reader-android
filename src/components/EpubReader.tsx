import { useEffect, useRef } from "react";
import ePub from "epubjs";
import type { Book, Rendition } from "epubjs";
import type { ReaderSettings } from "../types";

const EPUB_THEME_COLORS: Record<Exclude<ReaderSettings["theme"], "system">, { background: string; text: string; link: string }> = {
  paper: { background: "#f2ead3", text: "#2a2a2a", link: "#9a5a10" },
  light: { background: "#f8f4ed", text: "#1a1a2e", link: "#2563eb" },
  dark: { background: "#121212", text: "#e0e0e0", link: "#8ab4f8" },
  chalkboard: { background: "#183b32", text: "#f1ead0", link: "#f3c969" },
};
const WHEEL_PAGE_TURN_COOLDOWN_MS = 260;

function getEpubThemeColors(theme: ReaderSettings["theme"]) {
  if (theme === "system") {
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    return dark ? EPUB_THEME_COLORS.dark : EPUB_THEME_COLORS.light;
  }
  return EPUB_THEME_COLORS[theme];
}

interface Props {
  bytes: ArrayBuffer;
  settings: ReaderSettings;
  initialCfi?: string;
  initialProgress?: number;
  onProgress: (progress: number, cfi?: string) => void;
  navRef: React.MutableRefObject<{ next: () => void | Promise<void>; previous: () => void | Promise<void>; go: (p: number) => void | Promise<void> } | null>;
  onPageInfo: (current: number, total: number, indexing: boolean) => void;
  onLoadingStatus?: (status: { active: boolean; progress: number; message: string; detail?: string }) => void;
  onError: (error: unknown) => void;
}

export function EpubReader({ bytes, settings, initialCfi, initialProgress = 0, onProgress, navRef, onPageInfo, onLoadingStatus, onError }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const bookRef = useRef<Book | null>(null);

  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    let book: Book;
    let rendition: Rendition;
    try {
      onLoadingStatus?.({
        active: true,
        progress: 38,
        message: "EPUB 패키지를 여는 중...",
        detail: `${Math.max(1, Math.round(bytes.byteLength / 1024)).toLocaleString()}KB`,
      });
      book = ePub(bytes.slice(0));
      onLoadingStatus?.({
        active: true,
        progress: 48,
        message: "뷰어 레이아웃을 구성하는 중...",
      });
      rendition = book.renderTo(host.current, {
      width: "100%", height: "100%", flow: "paginated", spread: "none",
      manager: "default", allowScriptedContent: false
      });
    } catch (error) {
      onError(error);
      return;
    }
    bookRef.current = book;
    renditionRef.current = rendition;
    let userNavigated = false;
    let lastWheelTurnTime = 0;
    const next = () => {
      if (disposed) return Promise.resolve();
      userNavigated = true;
      return rendition.next();
    };
    const previous = () => {
      if (disposed) return Promise.resolve();
      userNavigated = true;
      return rendition.prev();
    };
    rendition.themes.register("reader-fonts", "/fonts/fonts.css");
    rendition.themes.select("reader-fonts");
    const themeColors = getEpubThemeColors(settings.theme);
    rendition.themes.default({
      "html, body": {
        "background": `${themeColors.background} !important`,
        "color": `${themeColors.text} !important`,
      },
      "p, span, div, h1, h2, h3, h4, h5, h6, li, a": {
        "color": `${themeColors.text} !important`,
        "font-family": `${settings.fontFamily} !important`,
        "line-height": `${settings.lineHeight} !important`,
        "letter-spacing": `${settings.letterSpacing}px !important`,
      },
      "a": { "color": `${themeColors.link} !important` },
      "body": {
        "background": `${themeColors.background} !important`,
        "color": `${themeColors.text} !important`,
        "font-family": `${settings.fontFamily} !important`,
        "font-size": `${settings.fontSize}px !important`,
        "font-weight": `${settings.isBold ? 700 : 400} !important`,
        "line-height": `${settings.lineHeight} !important`,
        "letter-spacing": `${settings.letterSpacing}px !important`,
        "padding": `${settings.paddingTop}px ${settings.paddingRight}px ${settings.paddingBottom}px ${settings.paddingLeft}px !important`,
        "box-sizing": "border-box !important"
      },
      "img, svg": { "max-width": "100% !important", "max-height": "80vh !important", "object-fit": "contain !important" }
    });
    onPageInfo(1, 1, true);

    const relocated = (location: { start: { cfi: string; percentage?: number; index?: number; displayed?: { page: number; total: number } }; atEnd?: boolean }) => {
      if (disposed) return;
      const cfi = location.start.cfi;
      const locations = book.locations;
      const total = locations.length();
      const displayed = location.start.displayed ?? { page: 1, total: 1 };
      const current = total ? locations.locationFromCfi(cfi) : displayed.page - 1;
      const spineCount = Math.max(1, book.spine.length);
      const chapterProgress = displayed.total > 0 ? (displayed.page - 1) / displayed.total : 0;
      const calculatedProgress = total
        ? Math.max(0, current) / Math.max(1, total - 1)
        : Math.min(1, ((location.start.index ?? 0) + chapterProgress) / spineCount);
      const progress = location.atEnd ? 1 : calculatedProgress;
      onProgress(progress, cfi);
      onPageInfo(displayed.page, displayed.total, false);
    };
    rendition.on("relocated", relocated);
    rendition.on("keyup", (event: KeyboardEvent) => {
      if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(event.key)) void next();
      if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) void previous();
    });
    rendition.on("wheel", (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();

      const now = Date.now();
      if (now - lastWheelTurnTime < WHEEL_PAGE_TURN_COOLDOWN_MS) return;
      lastWheelTurnTime = now;

      if (event.deltaY > 0) void next();
      else void previous();
    });
    rendition.on("click", (event: MouseEvent) => {
      const width = event.view?.innerWidth || host.current?.clientWidth || 1;
      if (event.clientX < width * 0.28) void previous();
      else if (event.clientX > width * 0.72) void next();
    });

    void book.ready.then(async () => {
      if (disposed) return;
      onLoadingStatus?.({
        active: true,
        progress: 62,
        message: "목차와 본문 구조를 읽는 중...",
        detail: `${Math.max(1, book.spine.length).toLocaleString()}개 섹션`,
      });
      if (initialCfi) {
        onLoadingStatus?.({
          active: true,
          progress: 74,
          message: "저장된 위치로 이동하는 중...",
        });
        try { await rendition.display(initialCfi); }
        catch { await rendition.display(); }
      } else if (initialProgress <= 0) {
        onLoadingStatus?.({
          active: true,
          progress: 74,
          message: "첫 페이지를 펼치는 중...",
        });
        await rendition.display();
      }
      if (disposed) return;
      if (!userNavigated && !initialCfi && initialProgress > 0) {
        onLoadingStatus?.({
          active: true,
          progress: 82,
          message: "전체 위치 정보를 계산하는 중...",
          detail: `${Math.round(initialProgress * 100)}% 지점으로 이동합니다.`,
        });
        await book.locations.generate(1600);
        if (disposed) return;
        const target = book.locations.cfiFromPercentage(Math.max(0, Math.min(1, initialProgress)));
        if (target) await rendition.display(target); else await rendition.display();
      }
      if (disposed) return;
      onLoadingStatus?.({
        active: true,
        progress: 94,
        message: "읽기 화면을 정리하는 중...",
      });
      const location = rendition.currentLocation() as unknown as { start?: { cfi?: string } };
      if (location?.start?.cfi) relocated({ start: { cfi: location.start.cfi } });
    }).catch((error) => {
      if (!disposed) onError(error);
    });
    navRef.current = {
      next: async () => { await next(); },
      previous: async () => { await previous(); },
      go: async (progress) => {
        if (disposed) return;
        userNavigated = true;
        if (!book.locations.length()) await book.locations.generate(1600);
        if (disposed) return;
        const cfi = book.locations.cfiFromPercentage(Math.max(0, Math.min(1, progress)));
        if (cfi) await rendition.display(cfi);
      }
    };

    return () => {
      disposed = true;
      navRef.current = null;
      rendition.destroy();
      book.destroy();
      renditionRef.current = null;
      bookRef.current = null;
    };
  // Recreating rendition on layout setting changes prevents stale epub.js columns.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes, initialCfi, initialProgress, onError, onLoadingStatus, settings.fontFamily, settings.fontSize, settings.isBold, settings.lineHeight, settings.letterSpacing,
      settings.paddingTop, settings.paddingBottom, settings.paddingLeft, settings.paddingRight, settings.theme]);

  return <div ref={host} className="reader-host epub-reader" />;
}
