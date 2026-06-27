import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { loadLibraryBooks, saveLibraryBooks, deleteLibraryBooks } from "./lib/libraryStore";
import { TextReader } from "./components/TextReader";
import type { HistoryItem, OpenedBook, ReaderSettings, SortConfig, FolderSource } from "./types";
import { loadGoogleApis, pickGoogleDriveFolder, listBooksInDriveFolder } from "./lib/driveSync";
import { prepareBook, selectLocalFolder, scanLocalFolder } from "./lib/bookLoader";

const EpubReader = lazy(() => import("./components/EpubReader").then((module) => ({ default: module.EpubReader })));

// @ts-ignore
import turnSoundFile from './assets/book-turn.wav';

type SwipeDirection = "left" | "right" | "up" | "down";

const SWIPE_MIN_DISTANCE = 50;
const SWIPE_MAX_DURATION = 800;
const SWIPE_AXIS_DOMINANCE = 1.15;

function useSwipeGesture(
  onSwipe: (direction: SwipeDirection) => boolean | void,
  effects: { onMove?: (deltaX: number, deltaY: number) => void; onRelease?: () => void } = {},
) {
  const startRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const suppressClickRef = useRef(false);
  const suppressTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (suppressTimerRef.current !== null) window.clearTimeout(suppressTimerRef.current);
  }, []);

  const onTouchStart = useCallback((event: React.TouchEvent<HTMLElement>) => {
    if (event.touches.length !== 1) {
      startRef.current = null;
      return;
    }
    const touch = event.touches[0];
    startRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
  }, []);

  const onTouchMove = useCallback((event: React.TouchEvent<HTMLElement>) => {
    const start = startRef.current;
    if (!start || event.touches.length !== 1 || !effects.onMove) return;
    const touch = event.touches[0];
    effects.onMove(touch.clientX - start.x, touch.clientY - start.y);
  }, [effects]);

  const onTouchEnd = useCallback((event: React.TouchEvent<HTMLElement>) => {
    const start = startRef.current;
    startRef.current = null;
    if (!start || event.changedTouches.length !== 1 || Date.now() - start.time > SWIPE_MAX_DURATION) {
      effects.onRelease?.();
      return;
    }

    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);
    let direction: SwipeDirection | null = null;

    if (absX >= SWIPE_MIN_DISTANCE && absX >= absY * SWIPE_AXIS_DOMINANCE) {
      direction = deltaX < 0 ? "left" : "right";
    } else if (absY >= SWIPE_MIN_DISTANCE && absY >= absX * SWIPE_AXIS_DOMINANCE) {
      direction = deltaY < 0 ? "up" : "down";
    }
    if (!direction) {
      effects.onRelease?.();
      return;
    }

    event.preventDefault();
    suppressClickRef.current = true;
    if (suppressTimerRef.current !== null) window.clearTimeout(suppressTimerRef.current);
    suppressTimerRef.current = window.setTimeout(() => { suppressClickRef.current = false; }, 400);
    onSwipe(direction);
    effects.onRelease?.();
  }, [effects, onSwipe]);

  const onClickCapture = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const onTouchCancel = useCallback(() => {
    startRef.current = null;
    effects.onRelease?.();
  }, [effects]);

  return { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel, onClickCapture };
}

function playPageTurnSound() {
  try {
    const audio = pageTurnAudio ?? new Audio(turnSoundFile);
    pageTurnAudio = audio;
    audio.pause();
    audio.currentTime = 0;
    // 재생 속도를 2배로 높여 소리 길이를 압축하고 빠르게 끝마치도록 합니다.
    audio.playbackRate = 2.0;
    audio.play().catch(e => console.error("Audio play failed:", e));
  } catch (e) {
    console.error("Failed to play sound", e);
  }
}

function triggerFeedback(type: "none" | "vibration" | "sound") {
  if (type === "vibration") {
    // 약한 진동 1번 (짧게)
    navigator.vibrate?.(8);
  } else if (type === "sound") {
    playPageTurnSound();
  }
}

const READER_FONTS = [
  { label: "나눔명조", value: "NanumMyeongjo, 'Malgun Gothic', serif" },
  { label: "나눔고딕", value: "NanumGothic, 'Malgun Gothic', sans-serif" },
  { label: "Noto Serif KR", value: "'Noto Serif KR', serif" },
  { label: "Noto Sans KR", value: "'Noto Sans KR', sans-serif" },
  { label: "마루부리", value: "MaruBuri, 'Noto Serif KR', serif" },
  { label: "도현체", value: "DoHyeon, 'Noto Sans KR', sans-serif" },
  { label: "고운돋움", value: "GowunDodum, 'Noto Sans KR', sans-serif" },
  { label: "IBM Plex Serif KR", value: "'IBM Plex Serif KR', 'Noto Serif KR', serif" },
  { label: "프리텐다드", value: "Pretendard, 'Noto Sans KR', sans-serif" },
  { label: "스포카 한 산스 Neo", value: "'Spoqa Han Sans Neo', 'Noto Sans KR', sans-serif" },
  { label: "KoPubWorld 바탕체", value: "'KoPubWorld Batang', 'Noto Serif KR', serif" },
  { label: "리디바탕", value: "RidiBatang, 'Noto Serif KR', serif" }
] as const;

type Tab = "library" | "history" | "bookmarks";
interface BookmarkItem { bookId: string; bookTitle: string; progress: number; cfi?: string; page: number; preview: string; createdAt: number; }
interface ViewerLoadingStatus { active: boolean; progress: number; message: string; detail?: string; }

const SORT_COLLATOR = new Intl.Collator("ko", { numeric: true });
const PROGRESS_SAVE_INTERVAL_MS = 700;
const VIEWER_LOADING_MIN_MS = 1900;
const WHEEL_PAGE_TURN_COOLDOWN_MS = 260;
let pageTurnAudio: HTMLAudioElement | null = null;

function nextSortDirection(currentColumn: string, currentDirection: SortConfig["direction"], column: string): SortConfig["direction"] {
  if (currentColumn !== column || currentDirection === "none") return "asc";
  return currentDirection === "asc" ? "desc" : "asc";
}

function compareSortValues(a: unknown, b: unknown, direction: SortConfig["direction"]) {
  if (typeof a === "string" || typeof b === "string") {
    const result = SORT_COLLATOR.compare(String(a ?? ""), String(b ?? ""));
    return direction === "asc" ? result : -result;
  }
  if (a === b) return 0;
  const result = (a ?? "") > (b ?? "") ? 1 : -1;
  return direction === "asc" ? result : -result;
}

function sortedBy<T>(items: T[], sort: SortConfig, valueOf: (item: T, column: string) => unknown) {
  if (sort.direction === "none" || !sort.column) return items;
  return [...items].sort((a, b) => compareSortValues(valueOf(a, sort.column), valueOf(b, sort.column), sort.direction));
}


const defaultSettings: ReaderSettings = {
  fontFamily: "NanumMyeongjo, 'Malgun Gothic', serif",
  fontSize: 18,
  isBold: false,
  lineHeight: 1.6,
  letterSpacing: 0,
  paddingTop: 40,
  paddingBottom: 40,
  paddingLeft: 20,
  paddingRight: 20,
  paddingLinked: true,
  pageTurnTouch: true,
  pageTurnSwipe: true,
  pageTurnVolume: true,
  pageTurnFeedback: "vibration",
  pageTurnStyle: "curl",
  hideCompleted: false,
  theme: "paper",
  librarySort: { column: "openedAt", direction: "desc" },
  historySort: { column: "openedAt", direction: "desc" },
  bookmarksSort: { column: "createdAt", direction: "desc" }
};

function loadJson<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || "") as T; } catch { return fallback; }
}

function loadSettings(): ReaderSettings {
  const saved = loadJson<any>("durumari.settings", {});
  if (saved.pageTurnAnimation !== undefined && saved.pageTurnStyle === undefined) {
    saved.pageTurnStyle = saved.pageTurnAnimation ? "curl" : "none";
    delete saved.pageTurnAnimation;
  }
  const usedPreviousDefaults = saved.paddingTop === 60 && saved.paddingBottom === 60
    && saved.paddingLeft === 40 && saved.paddingRight === 40;
  return {
    ...defaultSettings,
    ...saved,
    ...(usedPreviousDefaults ? { paddingTop: 40, paddingBottom: 40, paddingLeft: 20, paddingRight: 20 } : {}),
  };
}

export default function App() {
  const [settings, setSettings] = useState<ReaderSettings>(loadSettings);
  const [books, setBooks] = useState<OpenedBook[]>([]);
  const [sources, setSources] = useState<FolderSource[]>(() => loadJson("durumari.sources", []));
  const [activeSourceId, setActiveSourceId] = useState<string>(() => {
    const saved = loadJson<FolderSource[]>("durumari.sources", []);
    return saved.length ? saved[0].id : "";
  });
  useEffect(() => {
    if (sources.length > 0 && !sources.some(s => s.id === activeSourceId)) {
      setActiveSourceId(sources[0].id);
    } else if (sources.length === 0 && activeSourceId !== "") {
      setActiveSourceId("");
    }
  }, [sources, activeSourceId]);
  const [history, setHistory] = useState<HistoryItem[]>(() => loadJson("durumari.history", []));
  const historyRef = useRef(history);
  useEffect(() => { historyRef.current = history; }, [history]);
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>(() => loadJson("durumari.bookmarks", []));
  const [tab, setTab] = useState<Tab>("library");
  const [search, setSearch] = useState("");
  const [book, setBook] = useState<OpenedBook | null>(null);
  const [isLibraryLoaded, setIsLibraryLoaded] = useState(false);
  const bookRef = useRef(book);
  const skipNextSourceSyncRef = useRef(false);
  useEffect(() => { bookRef.current = book; }, [book]);
  const [progress, setProgress] = useState(0);
  const [cfi, setCfi] = useState<string>();
  const progressSaveTimerRef = useRef<number | null>(null);
  const pendingProgressRef = useRef<{ id: string; name: string; kind: OpenedBook["kind"]; progress: number; cfi?: string } | null>(null);
  const [pageInfo, setPageInfo] = useState({ current: 1, total: 1, indexing: false });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addSourceOpen, setAddSourceOpen] = useState(false);
  const [pendingBooks, setPendingBooks] = useState<OpenedBook[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [selectedHandle, setSelectedHandle] = useState<any>(null);
  const [sourceName, setSourceName] = useState("");
  const [escMenu, setEscMenu] = useState(false);
  const [pageNavigator, setPageNavigator] = useState(false);
  const [navProgress, setNavProgress] = useState(0);
  const [loading, setLoading] = useState(false);
  const [viewerLoading, setViewerLoading] = useState<ViewerLoadingStatus>({
    active: false,
    progress: 0,
    message: "뷰어를 준비하는 중...",
  });
  const [error, setError] = useState("");
  const [introActive, setIntroActive] = useState(true);
  const [introProgress, setIntroProgress] = useState(0);
  const [introText, setIntroText] = useState("앱 초기화 중...");
  const viewerLoadingStartedRef = useRef(0);
  const viewerLoadingHideTimerRef = useRef<number | null>(null);
  const navRef = useRef<{ next: () => void | Promise<void>; previous: () => void | Promise<void>; go: (p: number) => void | Promise<void> } | null>(null);
  const readerAreaRef = useRef<HTMLDivElement>(null);
  const pageTurnAnimatingRef = useRef(false);
  const pageTurnAnimationRef = useRef<Animation | null>(null);
  const lastTurnTimeRef = useRef(0);
  const lastWheelTurnTimeRef = useRef(0);
  const turnPage = useCallback((direction: "next" | "previous", origin?: "right" | "left" | "top" | "bottom") => {
    const area = readerAreaRef.current;
    if (!area) return false;
    
    if (pageTurnAnimatingRef.current) {
      return false; // 애니메이션 진행 중에는 추가 입력 무시
    }
    
    const now = Date.now();
    if (now - lastTurnTimeRef.current < (settings.pageTurnStyle === "none" ? 300 : 50)) {
      return false; // 연속 딜레이 무시 (없음 300ms, 기타 50ms)
    }
    lastTurnTimeRef.current = now;
    
    if (settings.pageTurnStyle === "none" || typeof area.animate !== "function") {
      void (direction === "next" ? navRef.current?.next() : navRef.current?.previous());
      return true;
    }
    
    pageTurnAnimatingRef.current = true;
    const isNext = direction === "next";
    
    const isCurrentPageSlidingOut = origin === "left" || origin === "top" || (!isNext && origin === undefined);

    const makeCurlClip = (curl: number, isRightToLeft: boolean): string => {
      const N = 16;
      const pts: string[] = [];
      if (isRightToLeft) {
        pts.push("0% 0%");
        for (let i = 0; i <= N; i++) {
          const t = i / N;
          const c = curl * Math.sin(t * Math.PI);
          pts.push(`${(100 - c).toFixed(1)}% ${(t * 100).toFixed(1)}%`);
        }
        pts.push("0% 100%");
      } else {
        for (let i = 0; i <= N; i++) {
          const t = i / N;
          const c = curl * Math.sin(t * Math.PI);
          pts.push(`${c.toFixed(1)}% ${(t * 100).toFixed(1)}%`);
        }
        pts.push("100% 100%");
        pts.push("100% 0%");
      }
      return `polygon(${pts.join(", ")})`;
    };
    
    const virtualPage = document.createElement("div");
    virtualPage.className = "virtual-page-layer";
    const frontFace = area.cloneNode(true) as HTMLDivElement;
    frontFace.style.opacity = "1";
    frontFace.style.backgroundColor = "var(--bg)";
    frontFace.className = "clone-face front";
    virtualPage.appendChild(frontFace);

    // [사전 준비] DOM 업데이트 전에 현재 화면(이전 화면)을 복제하여 무조건 최상단(zIndex:30)에 덮음
    // 이렇게 하면 30ms 딜레이 동안 React가 area를 어떻게 조작하든 사용자 눈에는 전혀 보이지 않음!
    virtualPage.style.zIndex = "30";
    area.parentElement?.appendChild(virtualPage);

    if (settings.pageTurnStyle === "curl" && !isCurrentPageSlidingOut) {
      area.style.opacity = "0"; 
    } else if (settings.pageTurnStyle === "slide" && !isCurrentPageSlidingOut) {
      area.style.position = "relative";
      const transformStart = origin === "bottom" ? "translateY(100%)" : "translateX(100%)";
      area.style.transform = transformStart;
    }

    const cleanup = () => {
      virtualPage.remove();
      area.style.position = "";
      area.style.zIndex = "";
      area.style.transform = "";
      area.style.boxShadow = "";
      area.style.opacity = "";
      pageTurnAnimationRef.current = null;
      pageTurnAnimatingRef.current = false;
    };

    const startAnimation = () => {
      if (settings.pageTurnStyle === "curl") {
        const isNextPage = !isCurrentPageSlidingOut;
        
        let flyingPage = virtualPage;
        let oldPageBg: HTMLDivElement | null = null;
        let myFrontFace = frontFace;

        if (isNextPage) {
          virtualPage.style.zIndex = "10"; // 이전 화면은 밑으로 뺌
          oldPageBg = virtualPage;
          
          flyingPage = document.createElement("div");
          flyingPage.className = "virtual-page-layer";
          myFrontFace = area.cloneNode(true) as HTMLDivElement; // DOM 업데이트 완료 후 새 페이지 복제!
          myFrontFace.style.opacity = "1";
          myFrontFace.style.backgroundColor = "var(--bg)";
          myFrontFace.className = "clone-face front";
          flyingPage.appendChild(myFrontFace);
        }

        flyingPage.style.transformOrigin = "right center";
        flyingPage.style.zIndex = "30";
        flyingPage.style.perspective = "2000px";
        
        const backFace = document.createElement("div");
        backFace.className = "clone-face back";
        flyingPage.appendChild(backFace);
        
        const curlShadow = document.createElement("div");
        curlShadow.style.cssText = `position:absolute;top:0;left:0;width:60px;height:100%;pointer-events:none;z-index:3;background:linear-gradient(to right,rgba(0,0,0,0.15),transparent)`;
        myFrontFace.appendChild(curlShadow);
        
        area.parentElement?.appendChild(flyingPage);
        
        const targetAngle = isNextPage ? 0 : 100;
        const startAngle = isNextPage ? 90 : 0;
        
        // 투명도(Opacity) 찰나 페이드 효과를 주어 갑툭튀 방지
        const anim = flyingPage.animate(isNextPage ? [
          { transform: `rotateY(${startAngle}deg)`, opacity: 0 },
          { transform: `rotateY(85deg)`, opacity: 1, offset: 0.1 },
          { transform: `rotateY(${targetAngle}deg)`, opacity: 1 }
        ] : [
          { transform: `rotateY(${startAngle}deg)`, opacity: 1 },
          { transform: `rotateY(90deg)`, opacity: 1, offset: 0.8 },
          { transform: `rotateY(${targetAngle}deg)`, opacity: 0 }
        ], { duration: 400, easing: "cubic-bezier(0.25, 1, 0.5, 1)", fill: "forwards" });

        const flat = makeCurlClip(0, false);
        const curlLight = makeCurlClip(8, false);
        const curlMax = makeCurlClip(18, false); // 90도 부근일 때 더 강한 휘어짐
        
        myFrontFace.animate(isNextPage ? [
          { offset: 0, clipPath: curlMax },
          { offset: 0.5, clipPath: curlLight },
          { offset: 1, clipPath: flat }
        ] : [
          { offset: 0, clipPath: flat },
          { offset: 0.5, clipPath: curlLight },
          { offset: 1, clipPath: curlMax }
        ], { duration: 400, fill: "forwards" });
        
        curlShadow.animate(isNextPage ? [
          { offset: 0, opacity: "0.8" },
          { offset: 0.5, opacity: "0.3" },
          { offset: 1, opacity: "0" }
        ] : [
          { offset: 0, opacity: "0" },
          { offset: 0.5, opacity: "0.3" },
          { offset: 1, opacity: "0.8" }
        ], { duration: 400, fill: "forwards" });

        pageTurnAnimationRef.current = anim;
        void anim.finished.then(() => {
          oldPageBg?.remove();
          if (isNextPage) flyingPage.remove();
          area.style.opacity = "";
          cleanup();
        }).catch(() => {
          oldPageBg?.remove();
          if (isNextPage) flyingPage.remove();
          area.style.opacity = "";
          cleanup();
        });
      } else {
        if (isCurrentPageSlidingOut) {
          virtualPage.style.zIndex = "30"; // 이전 화면 날아감
          area.style.position = "relative";
          area.style.zIndex = "10"; // 새 화면은 밑에서 대기
          
          let transformEnd = "translateX(100%)"; // Previous Page: Slide OUT to Right
          if (origin === "top") transformEnd = "translateY(100%)"; // Slide OUT to Bottom

          const anim = virtualPage.animate([
            { transform: "translate(0, 0)", boxShadow: "-10px 0 30px rgba(0,0,0,0.1)" },
            { transform: transformEnd, boxShadow: "-10px 0 30px rgba(0,0,0,0.1)" }
          ], { duration: 400, easing: "cubic-bezier(0.25, 1, 0.5, 1)", fill: "forwards" });
          
          pageTurnAnimationRef.current = anim;
          void anim.finished.then(cleanup).catch(cleanup);
        } else {
          virtualPage.style.zIndex = "10"; // 이전 화면은 밑으로 뺌
          area.style.zIndex = "20"; // 새 화면이 위로 올라와서 애니메이션 탑승
          const transformStart = origin === "bottom" ? "translateY(100%)" : "translateX(100%)";

          const anim = area.animate([
            { transform: transformStart, boxShadow: "0 0 30px rgba(0,0,0,0.3)" },
            { transform: "translate(0, 0)", boxShadow: "0 0 30px rgba(0,0,0,0.3)" }
          ], { duration: 400, easing: "cubic-bezier(0.25, 1, 0.5, 1)", fill: "forwards" });
          
          pageTurnAnimationRef.current = anim;
          void anim.finished.then(cleanup).catch(cleanup);
        }
      }
    };

    const navResult = isNext ? navRef.current?.next() : navRef.current?.previous();
    
    const triggerAnimation = () => {
      // React DOM 렌더링 지연(flush) 대기 후 애니메이션 시작
      setTimeout(startAnimation, 30);
    };

    if (navResult instanceof Promise) {
      void navResult.then(triggerAnimation).catch(triggerAnimation);
    } else {
      triggerAnimation();
    }

    return true;
  }, [settings.pageTurnStyle]);

  useEffect(() => () => pageTurnAnimationRef.current?.cancel(), []);
  useEffect(() => () => {
    if (viewerLoadingHideTimerRef.current !== null) window.clearTimeout(viewerLoadingHideTimerRef.current);
  }, []);

  const showViewerLoading = useCallback((status: Omit<ViewerLoadingStatus, "active">) => {
    if (viewerLoadingHideTimerRef.current !== null) {
      window.clearTimeout(viewerLoadingHideTimerRef.current);
      viewerLoadingHideTimerRef.current = null;
    }
    viewerLoadingStartedRef.current = Date.now();
    setViewerLoading({ active: true, ...status });
  }, []);

  const updateViewerLoading = useCallback((status: ViewerLoadingStatus) => {
    if (status.active) {
      if (viewerLoadingHideTimerRef.current !== null) {
        window.clearTimeout(viewerLoadingHideTimerRef.current);
        viewerLoadingHideTimerRef.current = null;
      }
      if (!viewerLoadingStartedRef.current) viewerLoadingStartedRef.current = Date.now();
      setViewerLoading(status);
      return;
    }
    setViewerLoading(status);
  }, []);

  const completeViewerLoading = useCallback(() => {
    setViewerLoading((state) => {
      if (!state.active) return state;
      const elapsed = Date.now() - viewerLoadingStartedRef.current;
      const delay = Math.max(0, VIEWER_LOADING_MIN_MS - elapsed);
      if (viewerLoadingHideTimerRef.current !== null) window.clearTimeout(viewerLoadingHideTimerRef.current);
      viewerLoadingHideTimerRef.current = window.setTimeout(() => {
        viewerLoadingHideTimerRef.current = null;
        viewerLoadingStartedRef.current = 0;
        setViewerLoading((current) => ({ ...current, active: false, progress: 100, message: "준비 완료!" }));
      }, delay);
      return { ...state, progress: 100, message: "준비 완료!" };
    });
  }, []);

  const readerSwipeHandlers = useSwipeGesture(useCallback((direction: SwipeDirection) => {
    if (!book || !settings.pageTurnSwipe || escMenu || settingsOpen || pageNavigator) return false;
    const originMap = { "left": "right", "right": "left", "up": "bottom", "down": "top" } as const;
    const isNext = direction === "left" || direction === "up";
    const moved = turnPage(isNext ? "next" : "previous", originMap[direction]);
    if (moved) triggerFeedback(settings.pageTurnFeedback);
    return moved;
  }, [book, escMenu, pageNavigator, settings.pageTurnSwipe, settings.pageTurnFeedback, settingsOpen, turnPage]));

  useEffect(() => {
    const start = Date.now();
    const duration = 2200;
    const timer = setInterval(() => {
      const elapsed = Date.now() - start;
      const currentProgress = Math.min(100, Math.floor((elapsed / duration) * 100));
      setIntroProgress(currentProgress);
      if (currentProgress < 25) {
        setIntroText("앱 초기화 중...");
      } else if (currentProgress < 60) {
        setIntroText("도서 목록을 로드하는 중...");
      } else if (currentProgress < 90) {
        setIntroText(`전체 페이지를 계산하는 중... ${Math.floor(currentProgress / 1.5)}%`);
      } else {
        setIntroText("준비 완료!");
      }
      if (currentProgress >= 100) {
        clearInterval(timer);
      }
    }, 16);

    const fadeTimer = setTimeout(() => {
      setIntroActive(false);
    }, 2700);

    return () => {
      clearInterval(timer);
      clearTimeout(fadeTimer);
    };
  }, []);

  useEffect(() => { localStorage.setItem("durumari.settings", JSON.stringify(settings)); }, [settings]);
  useEffect(() => { localStorage.setItem("durumari.sources", JSON.stringify(sources)); }, [sources]);
  useEffect(() => {
    if (!(window as any).ReactNativeWebView) return;
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    const sendTheme = () => {
      const backgroundColor = settings.theme === "dark" || (settings.theme === "system" && colorScheme.matches)
        ? "#090909"
        : settings.theme === "chalkboard"
          ? "#0d241f"
        : settings.theme === "light"
          ? "#e2dbcc"
          : "#cfbe90";
      (window as any).ReactNativeWebView.postMessage(JSON.stringify({
        type: "THEME_CHANGED",
        theme: settings.theme,
        backgroundColor,
      }));
    };
    sendTheme();
    if (settings.theme !== "system") return;
    colorScheme.addEventListener("change", sendTheme);
    return () => colorScheme.removeEventListener("change", sendTheme);
  }, [settings.theme]);


  const browseSource = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const selected = await selectLocalFolder();
      if (selected) {
        setSelectedPath(selected.path);
        setSelectedHandle(selected.handle);
        const folderName = selected.name || selected.path.split(/[/\\]/).filter(Boolean).pop() || "내 도서";
        setSourceName(folderName);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "폴더를 선택하지 못했습니다.");
    } finally { setLoading(false); }
  }, []);

  const registerSource = useCallback(async () => {
    if (!selectedPath) return;
    setLoading(true);
    try {
      const scannedBooks = await scanLocalFolder(selectedPath, selectedHandle);
      
      const newSourceId = `source-${Date.now()}`;
      const newSource: FolderSource = { id: newSourceId, name: sourceName || "내 도서", kind: "local", path: selectedPath, handle: selectedHandle };
      
      const taggedBooks = scannedBooks.map(b => ({ ...b, sourceId: newSourceId }));
      const taggedBookIds = new Set(taggedBooks.map((item) => item.id));
      setBooks((items) => [...taggedBooks, ...items.filter((item) => !taggedBookIds.has(item.id))]);
      skipNextSourceSyncRef.current = true;
      setSources((prev) => [...prev, newSource]);
      setActiveSourceId(newSourceId);
      
      void saveLibraryBooks(taggedBooks).catch(() => setError("도서 목록을 저장하지 못했습니다."));
      
      setPendingBooks([]); setSelectedPath(""); setSelectedHandle(null); setSourceName(""); setAddSourceOpen(false);
    } catch (e: any) {
      setError("도서 목록을 불러오는 중 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  }, [selectedPath, selectedHandle, sourceName]);

  useEffect(() => {
    if (sources.length === 0 || !isLibraryLoaded) return;
    if (skipNextSourceSyncRef.current) {
      skipNextSourceSyncRef.current = false;
      return;
    }
    
    let isSyncing = false;
    let isFirstRun = true;
    const runSync = async () => {
      const currentIsFirstRun = isFirstRun;
      isFirstRun = false;
      if (isSyncing || bookRef.current !== null) return;
      isSyncing = true;
      try {
        const localSources = sources.filter(s => s.kind === "local" && s.path);
        for (const source of localSources) {
          if (!source.handle) continue; // 웹 환경에서는 새로고침 시 핸들이 날아가므로 무시
          
          const scanned = await scanLocalFolder(source.path!, source.handle);
          const tagged = scanned.map(b => ({ ...b, sourceId: source.id }));
          
          setBooks((currentBooks) => {
            const existingForSource = currentBooks.filter(b => b.sourceId === source.id);
            const existingIds = new Set(existingForSource.map((book) => book.id));
            const taggedIds = new Set(tagged.map((book) => book.id));
            const newBooks = tagged.filter(nb => !existingIds.has(nb.id));
            const deletedBooks = existingForSource.filter(eb => !taggedIds.has(eb.id));
            
            if (newBooks.length === 0 && deletedBooks.length === 0) return currentBooks;
            
            const deletedIds = deletedBooks.map(d => d.id);
            const deletedIdSet = new Set(deletedIds);
            const next = [...currentBooks.filter(b => !deletedIdSet.has(b.id)), ...newBooks];
            
            void saveLibraryBooks(newBooks);
            void deleteLibraryBooks(deletedIds);
            
            if (deletedBooks.length > 0) {
              setHistory(prev => {
                const updated = prev.filter(h => !deletedIdSet.has(h.id));
                if (updated.length !== prev.length) localStorage.setItem("durumari.history", JSON.stringify(updated));
                return updated;
              });
              setBookmarks(prev => {
                const updated = prev.filter(b => !deletedIdSet.has(b.bookId));
                if (updated.length !== prev.length) localStorage.setItem("durumari.bookmarks", JSON.stringify(updated));
                return updated;
              });
            }
            
            return next;
          });
        }
      } catch (e) {
        console.warn("Live sync failed", e);
      } finally {
        isSyncing = false;
      }
    };
    
    void runSync();
  }, [sources, isLibraryLoaded]);

  const handleGoogleDriveSelect = async () => {
    try {
      setLoading(true);
      await loadGoogleApis();
      const { id, name, accessToken } = await pickGoogleDriveFolder();
      
      const files = await listBooksInDriveFolder(id, accessToken);
      const newSourceId = `gdrive-${Date.now()}`;
      
      const newSource: FolderSource = {
        id: newSourceId,
        name: name || "구글 드라이브 폴더",
        kind: "gdrive",
        gdriveFolderId: id
      };
      
      const gdriveBooks = files.map((f: any) => ({
        id: `gfile-${f.id}`,
        name: f.name.replace(/\.(epub|txt|zip)$/i, ''),
        kind: f.name.toLowerCase().endsWith(".txt") ? "txt" : "epub",
        openedAt: Date.now(),
        sourceId: newSourceId
      })) as OpenedBook[];
      
      setSources(prev => {
        const next = [...prev, newSource];
        return next;
      });
      setActiveSourceId(newSourceId);
      
      setBooks(prev => {
        const next = [...gdriveBooks, ...prev];
        void saveLibraryBooks(next).catch(() => setError("도서 목록을 저장하지 못했습니다."));
        return next;
      });
      
      setAddSourceOpen(false);
      
    } catch (e: any) {
      if (e.message === "API_KEY_MISSING") {
        alert("구글 연동을 위한 API 키가 설정되지 않았습니다.\nsrc/lib/driveSync.ts 파일에 키를 입력해주세요.");
      } else if (e.message !== "CANCELLED") {
        alert("구글 드라이브 연동 중 오류가 발생했습니다.");
        console.error(e);
      }
    } finally {
      setLoading(false);
    }
  };

  const removeSource = useCallback(async (sourceId: string) => {
    let confirmed = false;
    try {
      confirmed = window.confirm("이 폴더를 목록에서 제거하시겠습니까?\n(실제 파일은 삭제되지 않습니다.)");
    } catch {
      confirmed = window.confirm("이 폴더를 목록에서 제거하시겠습니까?\n(실제 파일은 삭제되지 않습니다.)");
    }
    if (!confirmed) return;
    const booksToDelete = books.filter(b => (b as OpenedBook & { sourceId?: string }).sourceId === sourceId);
    const idsToDelete = booksToDelete.map(b => b.id);
    const idSetToDelete = new Set(idsToDelete);
    setBooks(prev => prev.filter(b => (b as OpenedBook & { sourceId?: string }).sourceId !== sourceId));
    setHistory(prev => {
      const next = prev.filter(item => !idSetToDelete.has(item.id));
      if (next.length !== prev.length) localStorage.setItem("durumari.history", JSON.stringify(next));
      return next;
    });
    setBookmarks(prev => {
      const next = prev.filter(item => !idSetToDelete.has(item.bookId));
      if (next.length !== prev.length) localStorage.setItem("durumari.bookmarks", JSON.stringify(next));
      return next;
    });
    setSources(prev => {
      const next = prev.filter(s => s.id !== sourceId);
      setActiveSourceId(next.length ? next[0].id : "");
      return next;
    });
    void deleteLibraryBooks(idsToDelete).catch(() => setError("도서 목록 삭제 중 오류가 발생했습니다."));
  }, [books]);

  const resetSettings = useCallback(async () => {
    let confirmed = false;
    try {
      confirmed = window.confirm("모든 설정, 읽기 기록, 책갈피를 초기화하시겠습니까?");
    } catch {
      confirmed = window.confirm("모든 설정, 읽기 기록, 책갈피를 초기화하시겠습니까?");
    }
    if (!confirmed) return;
    setSettings(defaultSettings);
    setHistory([]);
    setBookmarks([]);
    localStorage.removeItem("durumari.history");
    localStorage.removeItem("durumari.bookmarks");
  }, []);

  const clearAllSources = useCallback(async () => {
    let confirmed = false;
    try {
      confirmed = window.confirm("등록된 모든 폴더를 목록에서 해제하시겠습니까?\n(실제 파일은 삭제되지 않으며, 독서 기록은 유지됩니다.)");
    } catch {
      confirmed = window.confirm("등록된 모든 폴더를 목록에서 해제하시겠습니까?\n(실제 파일은 삭제되지 않으며, 독서 기록은 유지됩니다.)");
    }
    if (!confirmed) return;
    const booksToDelete = books.filter(b => (b as OpenedBook & { sourceId?: string }).sourceId).map(b => b.id);
    setBooks(prev => prev.filter(b => !(b as OpenedBook & { sourceId?: string }).sourceId));
    setSources([]);
    setActiveSourceId("");
    void deleteLibraryBooks(booksToDelete).catch(() => setError("도서 목록 삭제 중 오류가 발생했습니다."));
    if (book !== null) {
      setSettingsOpen(false);
      setBook(null);
      setEscMenu(false);
      setTab("library");
    }
  }, [books, book]);

  const openBook = useCallback(async (selected: OpenedBook, targetProgress?: number, targetCfi?: string) => {
    setError(""); setLoading(true);
    showViewerLoading({
      progress: 8,
      message: "도서 파일을 준비하는 중...",
      detail: selected.name,
    });
    try {
      const ready = await prepareBook(selected);
      updateViewerLoading({
        active: true,
        progress: 28,
        message: ready.kind === "epub" ? "EPUB 문서를 분석하는 중..." : "텍스트 문서를 분석하는 중...",
        detail: ready.name,
      });
      if (ready !== selected) setBooks((items) => items.map((item) => item.id === ready.id ? ready : item));
      const saved = loadJson<{ progress?: number; cfi?: string }>(`durumari.position.${ready.id}`, {});
      setProgress(targetProgress ?? saved.progress ?? 0); setCfi(targetCfi ?? (targetProgress === undefined ? saved.cfi : undefined)); setBook(ready); setEscMenu(false);
      localStorage.setItem("durumari.lastViewedBookId", ready.id);
    } catch (cause) {
      const message = cause instanceof Error
        ? (cause.message || cause.name || "책을 열지 못했습니다.")
        : String(cause || "책을 열지 못했습니다.");
      setError(message);
      if ((window as any).ReactNativeWebView) {
        (window as any).ReactNativeWebView.postMessage(JSON.stringify({ type: "WEB_ERROR", message: `도서 열기 실패: ${message}` }));
      }
      updateViewerLoading({ active: false, progress: 0, message: "도서 열기를 중단했습니다." });
      return;
    } finally { setLoading(false); }
    setHistory((items) => {
      const saved = loadJson<{ progress?: number }>(`durumari.position.${selected.id}`, {});
      const next = [{ id: selected.id, name: selected.name, kind: selected.kind, progress: saved.progress ?? 0, openedAt: Date.now() }, ...items.filter((item) => item.id !== selected.id)].slice(0, 100);
      localStorage.setItem("durumari.history", JSON.stringify(next)); return next;
    });
  }, [showViewerLoading, updateViewerLoading]);

  useEffect(() => {
    loadLibraryBooks().then((loaded) => {
      setBooks(loaded);
      setIsLibraryLoaded(true);
      const lastViewed = localStorage.getItem("durumari.lastViewedBookId");
      if (lastViewed) {
        const target = loaded.find(b => b.id === lastViewed);
        if (target) {
          openBook(target);
        } else {
          localStorage.removeItem("durumari.lastViewedBookId");
        }
      }
    }).catch(() => setError("저장된 도서 목록을 불러오지 못했습니다."));
  }, [openBook]);

  const openFromList = useCallback((bookId: string, targetProgress?: number, targetCfi?: string) => {
    const target = books.find((item) => item.id === bookId);
    if (!target) {
      setError("이 책의 원본 폴더가 현재 등록되어 있지 않습니다. 도서 폴더를 다시 추가해 주세요.");
      return;
    }
    void openBook(target, targetProgress, targetCfi);
  }, [books, openBook]);

  const flushProgress = useCallback(() => {
    if (progressSaveTimerRef.current !== null) {
      window.clearTimeout(progressSaveTimerRef.current);
      progressSaveTimerRef.current = null;
    }
    const pending = pendingProgressRef.current;
    if (!pending) return;
    pendingProgressRef.current = null;
    localStorage.setItem(`durumari.position.${pending.id}`, JSON.stringify({ progress: pending.progress, cfi: pending.cfi }));
    const openedAt = Date.now();
    const items = historyRef.current;
    const existing = items.find((item) => item.id === pending.id);
    const updated = existing
      ? items.map((item) => item.id === pending.id ? { ...item, progress: pending.progress, openedAt } : item)
      : [{ id: pending.id, name: pending.name, kind: pending.kind, progress: pending.progress, openedAt }, ...items].slice(0, 100);
    historyRef.current = updated;
    localStorage.setItem("durumari.history", JSON.stringify(updated));
    setHistory(updated);
  }, []);

  const updateProgress = useCallback((next: number, nextCfi?: string) => {
    setProgress(next); if (nextCfi) setCfi(nextCfi);
    if (!book) return;
    pendingProgressRef.current = { id: book.id, name: book.name, kind: book.kind, progress: next, cfi: nextCfi ?? cfi };
    if (progressSaveTimerRef.current === null) {
      progressSaveTimerRef.current = window.setTimeout(flushProgress, PROGRESS_SAVE_INTERVAL_MS);
    }
  }, [book, cfi, flushProgress]);

  useEffect(() => {
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flushProgress();
    };
    window.addEventListener("beforeunload", flushProgress);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      window.removeEventListener("beforeunload", flushProgress);
      document.removeEventListener("visibilitychange", flushWhenHidden);
      flushProgress();
    };
  }, [flushProgress]);

  useEffect(() => {
    if (!book) flushProgress();
  }, [book, flushProgress]);

  const setInfo = useCallback((current: number, total: number, indexing: boolean) => {
    setPageInfo({ current, total, indexing });
    if (!indexing) {
      completeViewerLoading();
    }
  }, [completeViewerLoading]);
  const handleReaderError = useCallback((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause || "뷰어를 초기화하지 못했습니다.");
    setError(`뷰어 오류: ${message}`);
    updateViewerLoading({ active: false, progress: 0, message: "뷰어 초기화를 중단했습니다." });
    setBook(null);
    localStorage.removeItem("durumari.lastViewedBookId");
    if ((window as any).ReactNativeWebView) {
      (window as any).ReactNativeWebView.postMessage(JSON.stringify({ type: "WEB_ERROR", message: `뷰어 오류: ${message}` }));
    }
  }, [updateViewerLoading]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!book || settingsOpen || pageNavigator) return;
      if (event.key === "Escape") { event.preventDefault(); setEscMenu((value) => !value); return; }
      if (escMenu) return;
      if (["ArrowLeft"].includes(event.key)) { event.preventDefault(); turnPage("previous", "left"); }
      if (["ArrowRight"].includes(event.key)) { event.preventDefault(); turnPage("next", "right"); }
      if (["ArrowDown", "PageDown", " "].includes(event.key)) { event.preventDefault(); turnPage("next", "bottom"); }
      if (["ArrowUp", "PageUp"].includes(event.key)) { event.preventDefault(); turnPage("previous", "top"); }
    };
    window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler);
  }, [book, escMenu, pageNavigator, settingsOpen, turnPage]);

  useEffect(() => {
    const handler = (event: WheelEvent) => {
      if (!book || escMenu || settingsOpen || pageNavigator || event.deltaY === 0) return;
      event.preventDefault();

      const now = Date.now();
      if (now - lastWheelTurnTimeRef.current < WHEEL_PAGE_TURN_COOLDOWN_MS) return;
      lastWheelTurnTimeRef.current = now;

      if (event.deltaY > 0) turnPage("next", "bottom");
      else turnPage("previous", "top");
    };
    window.addEventListener("wheel", handler, { passive: false });
    return () => window.removeEventListener("wheel", handler);
  }, [book, escMenu, pageNavigator, settingsOpen, turnPage]);

  useEffect(() => {
    const handler = (event: Event) => {
      if (!book || !settings.pageTurnVolume || escMenu || settingsOpen || pageNavigator) return;
      const direction = (event as CustomEvent<{ direction?: "next" | "previous" }>).detail?.direction;
      if (direction === "next") turnPage("next", "bottom");
      if (direction === "previous") turnPage("previous", "top");
    };
    window.addEventListener("volumePageTurn", handler);
    return () => window.removeEventListener("volumePageTurn", handler);
  }, [book, escMenu, pageNavigator, settings.pageTurnVolume, settingsOpen, turnPage]);

  useEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      if (!book || settingsOpen || pageNavigator) return;
      event.preventDefault();
      setEscMenu(true);
    };
    window.addEventListener("contextmenu", handleContextMenu); return () => window.removeEventListener("contextmenu", handleContextMenu);
  }, [book, settingsOpen, pageNavigator]);

  useEffect(() => {
    const onHardwareBack = (e: Event) => {
      if (settingsOpen) {
        setSettingsOpen(false);
        e.preventDefault();
      } else if (pageNavigator) {
        setPageNavigator(false);
        e.preventDefault();
      } else if (escMenu) {
        setEscMenu(false);
        e.preventDefault();
      } else if (addSourceOpen) {
        setAddSourceOpen(false);
        e.preventDefault();
      } else if (book) {
        setBook(null);
        localStorage.removeItem("durumari.lastViewedBookId");
        e.preventDefault();
      }
    };
    window.addEventListener('hardwareBackPress', onHardwareBack);
    return () => window.removeEventListener('hardwareBackPress', onHardwareBack);
  }, [book, settingsOpen, pageNavigator, escMenu, addSourceOpen]);

  const reader = useMemo(() => {
    if (!book) return null;
    if (book.kind === "epub" && book.bytes) return <Suspense fallback={<div className="loading-view">EPUB 문서를 여는 중...</div>}><EpubReader key={book.id} bytes={book.bytes} settings={settings} initialCfi={cfi} initialProgress={progress} onProgress={updateProgress} navRef={navRef} onPageInfo={setInfo} onLoadingStatus={updateViewerLoading} onError={handleReaderError} /></Suspense>;
    return <TextReader key={book.id} cacheKey={book.id} text={book.text ?? ""} settings={settings} initialProgress={progress} onProgress={updateProgress} navRef={navRef} onPageInfo={setInfo} onLoadingStatus={updateViewerLoading} />;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, settings, setInfo, updateViewerLoading, handleReaderError]);

  const currentBookmark = book ? bookmarks.find((item) => {
    if (item.bookId !== book.id) return false;
    if (book.kind === "epub") {
      return item.cfi ? item.cfi === cfi : item.page === pageInfo.current && Math.abs(item.progress - progress) < .002;
    }
    return item.page === pageInfo.current;
  }) : undefined;
  const isBookmarked = !!currentBookmark;
  const toggleBookmark = () => {
    if (!book) return;
    const next = isBookmarked
      ? bookmarks.filter((item) => item.createdAt !== currentBookmark?.createdAt)
      : [...bookmarks.filter((item) => item.bookId !== book.id), { bookId: book.id, bookTitle: book.name, progress, cfi, page: pageInfo.current, preview: book.text?.slice(0, 45) || "EPUB 책갈피", createdAt: Date.now() }];
    setBookmarks(next); localStorage.setItem("durumari.bookmarks", JSON.stringify(next)); setEscMenu(false);
  };

  // 현재 선택된 소스에 해당하는 책만 필터링
  const activeSource = sources.find(s => s.id === activeSourceId);
  const booksForActiveSource = books.filter(b => (b as OpenedBook & { sourceId?: string }).sourceId === activeSourceId);
  const filteredBooks = booksForActiveSource.filter((item) => item.name.toLowerCase().includes(search.toLowerCase()));
  const themeClass = settings.theme === "system" ? "theme-system" : `theme-${settings.theme}`;

  return <main className={`app ${themeClass}`}>
    {introActive && (
      <div className="app-intro-screen">
        <div className="intro-container">
          <div className="intro-visual">
            <div className="intro-scroll-shadow" />
            <div className="intro-roller intro-roller-top"><i /><b /><i /></div>
            <div className="intro-paper">
              <div className="intro-paper-fiber" />
              <div className="intro-calligraphy" lang="ko">나랏말싸미 듕귁에 달아 문자와로 서르 사맛디 아니할쎄 이런 젼차로 어린 백셩이 니르고져 홀 배 이셔도 마참내 제 뜨들 시러 펴디 못할 노미 하니라 내 이랄 위하야 어엿비 너겨 새로 스믈여듧 자랄 맹가노니 사람마다 해어 수비 니겨 날로 쓰메 편안케 하고져 할 따라미니라</div>
              <div className="intro-seal">훈<br />민</div>
            </div>
            <div className="intro-roller intro-roller-bottom"><i /><b /><i /></div>
            <div className="intro-scroll-cord" />
          </div>

          <div className="intro-brand">
            <h1 className="intro-title">두 루 마 리</h1>
            <p className="intro-subtitle">나만의 디지털 두루마리</p>
          </div>

          <div className="intro-loading">
            <div className="intro-progress-bar">
              <div className="intro-progress-fill" style={{ width: `${introProgress}%` }} />
            </div>
            <div className="intro-status-text">{introText}</div>
          </div>
        </div>
      </div>
    )}
    {viewerLoading.active && <ViewerLoadingScreen bookTitle={book?.name ?? viewerLoading.detail ?? "두루마리"} status={viewerLoading} />}
    {!book ? <LibraryView tab={tab} setTab={setTab} search={search} setSearch={setSearch} books={filteredBooks} sources={sources} activeSourceId={activeSourceId} onSelectSource={setActiveSourceId} onRemoveSource={removeSource} history={history} bookmarks={bookmarks} onOpen={openBook} onOpenHistory={openFromList} onAdd={() => setAddSourceOpen(true)} onSettings={() => setSettingsOpen(true)} activeSource={activeSource} settings={settings} setSettings={setSettings} /> :
      <section className="reader-screen" {...readerSwipeHandlers} onContextMenu={(e) => { e.preventDefault(); triggerFeedback(settings.pageTurnFeedback); setEscMenu(v => !v); }}>
        <div ref={readerAreaRef} className="reader-area">
          {reader}
          <div className="reader-page-number">{pageInfo.current} / {pageInfo.indexing ? "계산 중" : pageInfo.total}</div>
          {isBookmarked && <div className="reader-bookmark-indicator" />}
        </div>
        <button className="reader-turn reader-turn-top" aria-label="이전 페이지" onClick={(event) => { event.currentTarget.blur(); if (!escMenu && settings.pageTurnTouch && turnPage("previous", "top")) triggerFeedback(settings.pageTurnFeedback); }} />
        <button className="reader-turn reader-turn-bottom" aria-label="다음 페이지" onClick={(event) => { event.currentTarget.blur(); if (!escMenu && settings.pageTurnTouch && turnPage("next", "bottom")) triggerFeedback(settings.pageTurnFeedback); }} />
        <button className="reader-turn reader-turn-left" aria-label="이전 페이지" onClick={(event) => { event.currentTarget.blur(); if (!escMenu && settings.pageTurnTouch && turnPage("previous", "left")) triggerFeedback(settings.pageTurnFeedback); }} />
        <button className="reader-turn reader-turn-right" aria-label="다음 페이지" onClick={(event) => { event.currentTarget.blur(); if (!escMenu && settings.pageTurnTouch && turnPage("next", "right")) triggerFeedback(settings.pageTurnFeedback); }} />
        {escMenu && <><div className="overlay-blur" /><div className="modal-layer"><div className="esc-card">
          <button className="esc-close-button" aria-label="메뉴 닫기" onClick={() => setEscMenu(false)}>✕</button>
          <h2>{book.name}</h2><p>읽는 중 · p.{pageInfo.current.toLocaleString()} / {pageInfo.indexing ? "계산 중" : pageInfo.total.toLocaleString()}</p>
          <div className="progress-track"><i style={{ width: `${progress * 100}%` }} /></div>
          <div className="esc-actions">
            <button className={isBookmarked ? "active-bookmark" : ""} onClick={toggleBookmark}>🔖 책갈피</button>
            <button onClick={() => { setNavProgress(progress); setPageNavigator(true); setEscMenu(false); }}>📄 페이지 이동</button>
            <button onClick={() => { setSettingsOpen(true); setEscMenu(false); }}>⚙️ 설정</button>
            <button onClick={() => { setBook(null); setEscMenu(false); localStorage.removeItem("durumari.lastViewedBookId"); }}>← 목록 나가기</button>
          </div>
        </div></div></>}
      </section>}

    {loading && !addSourceOpen && !viewerLoading.active && <div className="global-loading" role="status"><span className="loading-spinner" />도서를 불러오는 중...</div>}
    {addSourceOpen && <AddSourceModal pending={pendingBooks} path={selectedPath} name={sourceName} loading={loading} onName={setSourceName} onBrowse={browseSource} onClose={() => { setAddSourceOpen(false); setSelectedPath(""); setSelectedHandle(null); setPendingBooks([]); setSourceName(""); }} onRegister={registerSource} onGoogleDrive={handleGoogleDriveSelect} />}
    {error && <div className="error-toast" role="alert">{error}<button onClick={() => setError("")}>✕</button></div>}
    {settingsOpen && <SettingsModal initialSettings={settings} onConfirm={(s) => { setSettings(s); setSettingsOpen(false); }} onClose={() => setSettingsOpen(false)} onResetSettings={resetSettings} onClearFolders={clearAllSources} />}
    {pageNavigator && <PageNavigator current={pageInfo.current} total={pageInfo.total} progress={navProgress} bookmarks={book ? bookmarks.filter((item) => item.bookId === book.id) : []} onChange={setNavProgress} onClose={() => setPageNavigator(false)} onGo={() => { navRef.current?.go(navProgress); setPageNavigator(false); setEscMenu(false); }} />}
  </main>;
}

function ViewerLoadingScreen({ bookTitle, status }: { bookTitle: string; status: ViewerLoadingStatus }) {
  const safeProgress = Math.max(0, Math.min(100, status.progress));
  return <div className="viewer-loading-screen" role="status" aria-live="polite">
    <div className="intro-container viewer-loading-container">
      <div className="intro-visual viewer-intro-visual" aria-hidden="true">
        <div className="intro-scroll-shadow" />
        <div className="intro-roller intro-roller-top"><i /><b /><i /></div>
        <div className="intro-paper">
          <div className="intro-paper-fiber" />
          <div className="intro-calligraphy" lang="ko">문장을 고르고 페이지를 맞추어 읽던 자리를 다시 펼칩니다. 잠시만 기다려 주세요. 두루마리가 열리면 마지막으로 읽던 위치에서 이어집니다.</div>
          <div className="intro-seal">읽<br />기</div>
        </div>
        <div className="intro-roller intro-roller-bottom"><i /><b /><i /></div>
        <div className="intro-scroll-cord" />
      </div>

      <div className="intro-brand viewer-loading-brand">
        <h1 className="intro-title">뷰 어 준 비</h1>
        <p className="intro-subtitle">{bookTitle}</p>
      </div>

      <div className="intro-loading viewer-loading-status">
        <div className="intro-progress-bar" aria-label={`로딩 ${Math.round(safeProgress)}%`}>
          <div className="intro-progress-fill" style={{ width: `${safeProgress}%` }} />
        </div>
        <div className="intro-status-text">{status.message}</div>
        {status.detail && <div className="viewer-loading-detail">{status.detail}</div>}
      </div>
    </div>
  </div>;
}

function LibraryView({ tab, setTab, search, setSearch, books, sources, activeSourceId, onSelectSource, onRemoveSource, history, bookmarks, onOpen, onOpenHistory, onAdd, onSettings, activeSource, settings, setSettings }: {
  tab: Tab; setTab: (tab: Tab) => void; search: string; setSearch: (v: string) => void;
  books: OpenedBook[]; sources: FolderSource[]; activeSourceId: string;
  onSelectSource: (id: string) => void; onRemoveSource: (id: string) => void;
  history: HistoryItem[]; bookmarks: BookmarkItem[];
  onOpen: (b: OpenedBook) => void | Promise<void>; onOpenHistory: (bookId: string, progress?: number, cfi?: string) => void;
  onAdd: () => void; onSettings: () => void; activeSource?: FolderSource;
  settings: ReaderSettings; setSettings: React.Dispatch<React.SetStateAction<ReaderSettings>>;
}) {
  const tabSwipeHandlers = useSwipeGesture(useCallback((direction: SwipeDirection) => {
    if (direction !== "left" && direction !== "right") return;
    const tabs: Tab[] = ["library", "history", "bookmarks"];
    const currentIndex = tabs.indexOf(tab);
    const nextIndex = direction === "left" ? currentIndex + 1 : currentIndex - 1;
    if (nextIndex >= 0 && nextIndex < tabs.length) setTab(tabs[nextIndex]);
  }, [setTab, tab]));

  const formatDate = (timestamp: number | string | Date): string => {
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) return "";
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}.${mm}.${dd}`;
  };

  const librarySort = settings.librarySort || { column: "openedAt", direction: "desc" };
  const historySort = settings.historySort || { column: "openedAt", direction: "desc" };
  const bookmarksSort = settings.bookmarksSort || { column: "createdAt", direction: "desc" };

  const handleHeaderClick = (tabName: Tab, column: string) => {
    if (tabName === "library") {
      setSettings((prev) => {
        const current = prev.librarySort || { column: "openedAt", direction: "desc" };
        const nextDir = nextSortDirection(current.column, current.direction, column);
        return { ...prev, librarySort: { column, direction: nextDir } };
      });
    } else if (tabName === "history") {
      setSettings((prev) => {
        const current = prev.historySort || { column: "openedAt", direction: "desc" };
        const nextDir = nextSortDirection(current.column, current.direction, column);
        return { ...prev, historySort: { column, direction: nextDir } };
      });
    } else if (tabName === "bookmarks") {
      setSettings((prev) => {
        const current = prev.bookmarksSort || { column: "createdAt", direction: "desc" };
        const nextDir = nextSortDirection(current.column, current.direction, column);
        return { ...prev, bookmarksSort: { column, direction: nextDir } };
      });
    }
  };

  const getSortIndicator = (config: SortConfig, column: string) => {
    if (config.column !== column) return "";
    if (config.direction === "asc") return " ▲";
    if (config.direction === "desc") return " ▼";
    return "";
  };

  const historyById = useMemo(() => new Map(history.map((item) => [item.id, item])), [history]);
  const bookById = useMemo(() => new Map(books.map((item) => [item.id, item])), [books]);
  const sourceNameById = useMemo(() => new Map(sources.map((item) => [item.id, item.name])), [sources]);
  const sourceNameByBookId = useMemo(() => new Map(books.map((item) => [
    item.id,
    sourceNameById.get((item as OpenedBook & { sourceId?: string }).sourceId ?? ""),
  ])), [books, sourceNameById]);

  const readingStatus = (bookId: string) => {
    const record = historyById.get(bookId);
    if (!record || record.progress <= 0) return { label: "미독", className: "status-unread" };
    if (record.progress >= .999) return { label: "완독", className: "status-completed" };
    return { label: "읽는 중", className: "status-reading" };
  };

  const sortedBooks = useMemo(() => {
    return sortedBy(books, librarySort, (item, column) => {
      if (column !== "status") return item[column as keyof OpenedBook] || "";
      const record = historyById.get(item.id);
      if (!record || record.progress <= 0) return 0;
      return record.progress >= .999 ? 2 : 1;
    });
  }, [books, librarySort, historyById]);

  const getSourceName = useCallback((bookId: string) => {
    const book = bookById.get(bookId);
    if (!book) return "내 도서";
    const sourceName = sourceNameByBookId.get(bookId);
    return sourceName || "내 도서";
  }, [bookById, sourceNameByBookId]);

  const validHistory = useMemo(() => history.filter(h => bookById.has(h.id)), [history, bookById]);
  const sortedHistory = useMemo(() => {
    return sortedBy(validHistory, historySort, (item, column) => {
      if (column === "folder") return getSourceName(item.id);
      return item[column as keyof HistoryItem] || "";
    });
  }, [validHistory, historySort, getSourceName]);

  const validBookmarks = useMemo(() => bookmarks.filter(bm => bookById.has(bm.bookId)), [bookmarks, bookById]);
  const sortedBookmarks = useMemo(() => {
    return sortedBy(validBookmarks, bookmarksSort, (item, column) => {
      if (column === "folder") return getSourceName(item.bookId);
      return item[column as keyof BookmarkItem] || "";
    });
  }, [validBookmarks, bookmarksSort, getSourceName]);

  return <section className="library-view" {...tabSwipeHandlers}>
    <header className="library-header"><h1>두루마리</h1><div className="library-header-actions"><label className="search-box"><span>🔍</span><input aria-label="검색" value={search} onChange={(e) => setSearch(e.target.value)} /></label><button className="wpf-button" onClick={onSettings}>⚙️ 설정</button></div></header>
    <nav className="tabs"><button className={tab === "library" ? "selected" : ""} onClick={() => setTab("library")}>목록</button><button className={tab === "history" ? "selected" : ""} onClick={() => setTab("history")}>히스토리</button><button className={tab === "bookmarks" ? "selected" : ""} onClick={() => setTab("bookmarks")}>책갈피</button></nav>
    <div className="library-content">
      {tab === "library" && (sources.length === 0 ? (
        <div className="empty-library"><p>아직 등록된 도서 폴더가 없습니다.</p><button className="accent-button" onClick={onAdd}>➕ 도서 폴더 추가</button></div>
      ) : (
        <>
          <div className="source-tabs">
            {sources.map(src => (
              <button
                key={src.id}
                className={`wpf-button source-tab-btn ${src.id === activeSourceId ? "selected-source" : ""}`}
                onClick={() => onSelectSource(src.id)}
                title={src.path}
              >
                💻 {src.name}
                <button
                  className="source-tab-remove"
                  title="폴더 제거"
                  onClick={(e) => { e.stopPropagation(); onRemoveSource(src.id); }}
                >✕</button>
              </button>
            ))}
            <button className="wpf-button" onClick={onAdd}>➕ 추가</button>
          </div>
          <div className="table-scroll-wrapper">
            <table className="library-table">
              <thead>
                <tr>
                  <th className="sortable" onClick={() => handleHeaderClick("library", "name")}>제목{getSortIndicator(librarySort, "name")}</th>
                  <th className="sortable" onClick={() => handleHeaderClick("library", "openedAt")} title="Android에서 생성일을 제공하지 않으면 최종 수정일을 표시합니다.">파일 일자{getSortIndicator(librarySort, "openedAt")}</th>
                  <th className="sortable" onClick={() => handleHeaderClick("library", "status")}>상태{getSortIndicator(librarySort, "status")}</th>
                </tr>
              </thead>
              <tbody>
                {sortedBooks.length === 0 ? (
                  <tr><td colSpan={3} style={{ textAlign: "center", padding: "30px", color: "var(--secondary)" }}>이 폴더에 등록된 도서가 없습니다.</td></tr>
                ) : sortedBooks.map((item) => {
                  const status = readingStatus(item.id);
                  return <tr className={`openable-row ${status.className}`} key={item.id} onClick={() => void onOpen(item)}><td className="book-name">{item.name}</td><td>{formatDate(item.openedAt)}</td><td className={status.className}>{status.label}</td></tr>;
                })}
              </tbody>
            </table>
          </div>
        </>
      ))}
      {tab === "history" && (
        <div className="table-scroll-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                <th className="sortable" onClick={() => handleHeaderClick("history", "folder")}>폴더{getSortIndicator(historySort, "folder")}</th>
                <th className="sortable" onClick={() => handleHeaderClick("history", "name")}>제목{getSortIndicator(historySort, "name")}</th>
                <th className="sortable" onClick={() => handleHeaderClick("history", "openedAt")}>읽은 일자{getSortIndicator(historySort, "openedAt")}</th>
                <th className="sortable" onClick={() => handleHeaderClick("history", "progress")}>진행률{getSortIndicator(historySort, "progress")}</th>
              </tr>
            </thead>
            <tbody>
              {sortedHistory.map((item) => <tr className="openable-row" key={item.id} onClick={() => onOpenHistory(item.id)}><td>💻 {getSourceName(item.id)}</td><td>{item.name}</td><td>{formatDate(item.openedAt)}</td><td className="accent-text">{Math.round(item.progress * 100)}%</td></tr>)}
            </tbody>
          </table>
        </div>
      )}
      {tab === "bookmarks" && (
        <div className="table-scroll-wrapper">
          <table className="bookmarks-table">
            <thead>
              <tr>
                <th className="sortable" onClick={() => handleHeaderClick("bookmarks", "folder")}>폴더{getSortIndicator(bookmarksSort, "folder")}</th>
                <th className="sortable" onClick={() => handleHeaderClick("bookmarks", "bookTitle")}>제목{getSortIndicator(bookmarksSort, "bookTitle")}</th>
                <th className="sortable" onClick={() => handleHeaderClick("bookmarks", "createdAt")}>추가 일자{getSortIndicator(bookmarksSort, "createdAt")}</th>
                <th className="sortable" onClick={() => handleHeaderClick("bookmarks", "page")}>위치{getSortIndicator(bookmarksSort, "page")}</th>
              </tr>
            </thead>
            <tbody>
              {sortedBookmarks.map((item) => <tr className="openable-row" key={`${item.bookId}-${item.createdAt}`} onClick={() => onOpenHistory(item.bookId, item.progress, item.cfi)}><td>💻 {getSourceName(item.bookId)}</td><td>{item.bookTitle}</td><td>{formatDate(item.createdAt)}</td><td className="accent-text">p.{item.page}</td></tr>)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  </section>;
}

function AddSourceModal({ pending, path, name, loading, onName, onBrowse, onClose, onRegister, onGoogleDrive }: { pending: OpenedBook[]; path: string; name: string; loading: boolean; onName: (v: string) => void; onBrowse: () => void; onClose: () => void; onRegister: () => void; onGoogleDrive: () => void; }) {
  const [tab, setTab] = useState<"local" | "gdrive">("local");
  return <><div className="overlay-solid" /><div className="modal-layer"><div className="dialog add-source-dialog">
    <div className="dialog-title"><b>➕ 도서 폴더 추가</b><button onClick={onClose}>✕</button></div>
    
    <div className="source-type-tabs" style={{ display: "flex", gap: "10px", marginBottom: "15px" }}>
      <button className={`wpf-button ${tab === "local" ? "selected" : ""}`} onClick={() => setTab("local")} style={{ flex: 1, backgroundColor: tab === "local" ? "var(--accent)" : "", color: tab === "local" ? "var(--accent-on)" : "" }}>💻 로컬 폴더</button>
      <button className={`wpf-button ${tab === "gdrive" ? "selected" : ""}`} onClick={() => setTab("gdrive")} style={{ flex: 1, backgroundColor: tab === "gdrive" ? "var(--accent)" : "", color: tab === "gdrive" ? "var(--accent-on)" : "" }}>☁️ 구글 드라이브</button>
    </div>

    {tab === "local" ? (
      <>
        <div className="form-line"><span>경로</span><input value={path || ""} readOnly /><button className="wpf-button browse-button" onClick={onBrowse}>📂</button></div>
        <div className="form-line"><span>이름</span><input value={name} onChange={(e) => onName(e.target.value)} /></div>
        <button className="accent-button full" disabled={!path || loading} onClick={onRegister}>{loading ? "불러오는 중..." : "등록하기"}</button>
      </>
    ) : (
      <div style={{ textAlign: "center", padding: "20px 0" }}>
        <p style={{ marginBottom: "15px", color: "var(--text)" }}>구글 계정을 연동하여 드라이브의 폴더를 불러옵니다.</p>
        <button className="wpf-button" onClick={() => alert("현재 준비 중인 기능입니다. (구글 API 연동 대기중)")}>☁️ 구글 드라이브 연동 및 폴더 선택 (준비중)</button>
      </div>
    )}
  </div></div></>;
}

function SettingsModal({ initialSettings, onConfirm, onClose, onResetSettings, onClearFolders }: { initialSettings: ReaderSettings; onConfirm: (s: ReaderSettings) => void; onClose: () => void; onResetSettings: () => void; onClearFolders: () => void; }) {
  const [settings, setSettings] = useState(initialSettings);
  useEffect(() => { setSettings(initialSettings); }, [initialSettings]);
  const onChange = setSettings;

  const range = (label: string, key: "fontSize" | "lineHeight" | "letterSpacing" | "paddingTop" | "paddingBottom" | "paddingLeft" | "paddingRight", min: number, max: number, step: number, unit = "") => <div className="setting-line"><span>{label}</span><input type="range" min={min} max={max} step={step} value={settings[key]} onChange={(e) => {
    const value = Number(e.target.value);
    onChange((s) => s.paddingLinked && (key === "paddingLeft" || key === "paddingRight")
      ? { ...s, paddingLeft: value, paddingRight: value }
      : { ...s, [key]: value });
  }} /><b>{settings[key]}{unit}</b></div>;
  return <><div className="overlay-blur" onClick={onClose} /><div className="modal-layer"><div className="dialog settings-dialog">
    <div className="dialog-title"><b>⚙️ 설정</b><button onClick={onClose}>✕</button></div>
    
    <div className="settings-preview-section">
      <h3>👀 미리보기</h3>
      <div className={`settings-preview ${settings.theme === "system" ? "theme-system" : `theme-${settings.theme}`}`} style={{ fontFamily: settings.fontFamily, fontSize: settings.fontSize, fontWeight: settings.isBold ? 700 : 400, lineHeight: settings.lineHeight, letterSpacing: `${settings.letterSpacing}px`, color: "var(--text)" }}>
        소년은 개울가에서 소녀를 보자 곧 윤 초시네 증손녀딸이라는 걸 알 수 있었다. 소녀는 개울에다 손을 씻고 있었다. 그런데 어제까지는 개울 기슭에서 씻더니, 오늘은 징검다리 한가운데 앉아서
      </div>
    </div>

    <div className="settings-scroll">
      <h3>📖 읽기 설정</h3>
      <div className="setting-line"><span>서체</span><select value={settings.fontFamily} onChange={(e) => onChange((s) => ({ ...s, fontFamily: e.target.value }))}>{READER_FONTS.map((font) => <option key={font.value} value={font.value} style={{ fontFamily: font.value }}>{font.label}</option>)}</select></div>
      {range("글자 크기", "fontSize", 10, 36, 1, "pt")}
      <div className="setting-line"><span>글자 굵기</span><div className="toggle-pair"><button className={!settings.isBold ? "selected" : ""} onClick={() => onChange((s) => ({ ...s, isBold: false }))}>일반</button><button className={settings.isBold ? "selected" : ""} onClick={() => onChange((s) => ({ ...s, isBold: true }))}>굵게</button></div></div>
      {range("줄 간격", "lineHeight", 1, 2.5, .1)}
      {range("자 간", "letterSpacing", -2, 5, 1)}
      
      <hr />
      
      <div className="section-title"><h3>📏 여백 설정</h3><label><input type="checkbox" checked={settings.paddingLinked} onChange={(e) => onChange((s) => ({ ...s, paddingLinked: e.target.checked, paddingRight: e.target.checked ? s.paddingLeft : s.paddingRight }))} /> 좌우 여백 동일하게 조절</label></div>
      {range("위 여백", "paddingTop", 0, 120, 5, "px")}
      {range("아래 여백", "paddingBottom", 0, 120, 5, "px")}
      {range("왼쪽 여백", "paddingLeft", 0, 150, 5, "px")}
      {range("오른쪽 여백", "paddingRight", 0, 150, 5, "px")}

      <hr />

      <h3>📖 뷰어 페이지 이동 방식</h3>
      <div className="page-turn-options">
        <label><input type="checkbox" checked={settings.pageTurnTouch} onChange={(e) => onChange((s) => ({ ...s, pageTurnTouch: e.target.checked }))} /> 터치</label>
        <label><input type="checkbox" checked={settings.pageTurnSwipe} onChange={(e) => onChange((s) => ({ ...s, pageTurnSwipe: e.target.checked }))} /> 스와이프</label>
        <label><input type="checkbox" checked={settings.pageTurnVolume} onChange={(e) => onChange((s) => ({ ...s, pageTurnVolume: e.target.checked }))} /> 볼륨키</label>
      </div>

      <div className="section-title" style={{ marginTop: "16px" }}><h3>📖 효과음 및 피드백</h3></div>
      <div className="radio-group" style={{ display: "flex", gap: "20px", marginBottom: "16px" }}>
        <label><input type="radio" name="pageTurnFeedback" value="none" checked={settings.pageTurnFeedback === "none"} onChange={() => onChange((s) => ({ ...s, pageTurnFeedback: "none" }))} /> 없음</label>
        <label><input type="radio" name="pageTurnFeedback" value="vibration" checked={settings.pageTurnFeedback === "vibration"} onChange={() => onChange((s) => ({ ...s, pageTurnFeedback: "vibration" }))} /> 진동</label>
        <label><input type="radio" name="pageTurnFeedback" value="sound" checked={settings.pageTurnFeedback === "sound"} onChange={() => onChange((s) => ({ ...s, pageTurnFeedback: "sound" }))} /> 소리</label>
      </div>

      <div className="section-title" style={{ marginTop: "16px" }}><h3>📖 뷰어 페이지 애니메이션 방식</h3></div>
      <div className="radio-group" style={{ display: "flex", gap: "20px", marginBottom: "16px" }}>
        <label><input type="radio" name="pageTurnStyle" value="none" checked={settings.pageTurnStyle === "none"} onChange={() => onChange((s) => ({ ...s, pageTurnStyle: "none" }))} /> 없음</label>
        <label><input type="radio" name="pageTurnStyle" value="curl" checked={settings.pageTurnStyle === "curl"} onChange={() => onChange((s) => ({ ...s, pageTurnStyle: "curl" }))} /> 책장 넘김</label>
        <label><input type="radio" name="pageTurnStyle" value="slide" checked={settings.pageTurnStyle === "slide"} onChange={() => onChange((s) => ({ ...s, pageTurnStyle: "slide" }))} /> 슬라이드</label>
      </div>
      
      <hr />
      
      <h3>🎨 테마 및 필터</h3>
      <div className="setting-line"><span>테마</span><div className="theme-buttons">{([['light','☀️ 화이트'],['dark','🌙 다크'],['paper','📜 한지'],['chalkboard','🟩 칠판']] as const).map(([value,label]) => <button key={value} className={settings.theme === value ? "selected" : ""} onClick={() => onChange((s) => ({ ...s, theme: value }))}>{label}</button>)}</div></div>
      <div className="setting-line"><span>필터</span><label><input type="checkbox" checked={settings.hideCompleted} onChange={(e) => onChange((s) => ({ ...s, hideCompleted: e.target.checked }))} /> 완독한 책 목록에서 숨김</label></div>
      
      <hr />
      
      <h3>🛠️ 데이터 및 설정 관리</h3>
      <div className="settings-data-actions" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
        <button className="wpf-button" onClick={onResetSettings}>⚙️ 설정 초기화</button>
        <button className="wpf-button" style={{ color: "#d32f2f" }} onClick={onClearFolders}>🗑️ 폴더 전체 해제</button>
      </div>
    </div>
    
    <button className="accent-button full" onClick={() => onConfirm(settings)}>확인</button>
  </div></div></>;
}

function PageNavigator({ current, total, progress, bookmarks, onChange, onClose, onGo }: { current: number; total: number; progress: number; bookmarks: BookmarkItem[]; onChange: (v: number) => void; onClose: () => void; onGo: () => void; }) {
  return <><div className="overlay-solid subtle" /><div className="modal-layer"><div className="dialog page-dialog"><div className="dialog-title"><b>📄 페이지 이동</b><button onClick={onClose}>✕</button></div><div className="page-input"><input type="number" value={Math.max(1, Math.round(progress * Math.max(1,total - 1)) + 1)} onChange={(e) => onChange((Number(e.target.value) - 1) / Math.max(1,total - 1))} /> <span>/ {total}</span></div><div className="bookmark-range"><input type="range" min="0" max="1" step="0.001" value={progress} onChange={(e) => onChange(Number(e.target.value))} />{bookmarks.map((item) => <i key={item.createdAt} style={{ left: `${item.progress * 100}%` }} />)}</div><div className="quick-links"><button onClick={() => onChange(0)}>처음</button><button disabled>이전 책갈피</button><button disabled>다음 책갈피</button></div><button className="accent-button full" onClick={onGo}>이동하기</button><small>현재 p.{current}</small></div></div></>;
}
