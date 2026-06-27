import { useEffect, useRef } from "react";
import ePub from "epubjs";
import type { Book, Rendition } from "epubjs";
import type { ReaderSettings } from "../types";

interface Props {
  bytes: ArrayBuffer;
  settings: ReaderSettings;
  initialCfi?: string;
  initialProgress?: number;
  onProgress: (progress: number, cfi?: string) => void;
  navRef: React.MutableRefObject<{ next: () => void | Promise<void>; previous: () => void | Promise<void>; go: (p: number) => void | Promise<void> } | null>;
  onPageInfo: (current: number, total: number, indexing: boolean) => void;
  onError: (error: unknown) => void;
}

export function EpubReader({ bytes, settings, initialCfi, initialProgress = 0, onProgress, navRef, onPageInfo, onError }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const bookRef = useRef<Book | null>(null);

  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    let book: Book;
    let rendition: Rendition;
    try {
      book = ePub(bytes.slice(0));
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
    rendition.themes.default({
      "html, body": { "background": "transparent !important" },
      "p, span, div, h1, h2, h3, h4, h5, h6, li, a": {
        "font-family": `${settings.fontFamily} !important`,
        "line-height": `${settings.lineHeight} !important`,
        "letter-spacing": `${settings.letterSpacing}px !important`,
      },
      "body": {
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
    rendition.on("click", (event: MouseEvent) => {
      const width = event.view?.innerWidth || host.current?.clientWidth || 1;
      if (event.clientX < width * 0.28) void previous();
      else if (event.clientX > width * 0.72) void next();
    });

    void book.ready.then(async () => {
      if (disposed) return;
      if (initialCfi) {
        try { await rendition.display(initialCfi); }
        catch { await rendition.display(); }
      } else if (initialProgress <= 0) {
        await rendition.display();
      }
      if (disposed) return;
      if (!userNavigated && !initialCfi && initialProgress > 0) {
        await book.locations.generate(1600);
        if (disposed) return;
        const target = book.locations.cfiFromPercentage(Math.max(0, Math.min(1, initialProgress)));
        if (target) await rendition.display(target); else await rendition.display();
      }
      if (disposed) return;
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
  }, [bytes, initialCfi, initialProgress, onError, settings.fontFamily, settings.fontSize, settings.isBold, settings.lineHeight, settings.letterSpacing,
      settings.paddingTop, settings.paddingBottom, settings.paddingLeft, settings.paddingRight]);

  return <div ref={host} className="reader-host epub-reader" />;
}
