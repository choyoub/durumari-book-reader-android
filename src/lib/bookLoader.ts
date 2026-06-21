import type { BookKind, OpenedBook } from "../types";
import JSZip from "jszip";

const supported = ["epub", "txt", "zip"] as const;

type AndroidDirectoryHandle = {
  kind: "android-saf-directory";
  directoryUri: string;
};

function isAndroidDirectoryHandle(handle: any): handle is AndroidDirectoryHandle {
  return handle?.kind === "android-saf-directory" && typeof handle.directoryUri === "string";
}

function nativeRequest<T>(type: string, responseType: string, payload: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestId = `${type}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const listener = (event: MessageEvent) => {
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (data?.type !== responseType || data?.requestId !== requestId) return;
        window.removeEventListener("message", listener);
        document.removeEventListener("message", listener as EventListener);
        if (data.error) reject(new Error(data.error));
        else resolve(data as T);
      } catch {
        // 다른 WebView 메시지는 무시한다.
      }
    };

    window.addEventListener("message", listener);
    document.addEventListener("message", listener as EventListener);
    (window as any).ReactNativeWebView.postMessage(JSON.stringify({ type, requestId, ...payload }));
  });
}

function extension(name: string): BookKind | null {
  const value = name.split(".").pop()?.toLowerCase();
  return supported.includes(value as BookKind) ? value as BookKind : null;
}

function makeId(name: string, size: number, modified: number) {
  return `${name}:${size}:${modified}`;
}

async function chooseInBrowser(): Promise<{ name: string; bytes: Uint8Array; modified: number } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".epub,.txt,.zip";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      resolve({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), modified: file.lastModified });
    };
    input.click();
  });
}



function decodeText(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("euc-kr").decode(bytes);
  }
}

async function processTextInline(kind: "txt" | "zip", bytes: Uint8Array): Promise<string> {
  if (kind === "txt") return decodeText(bytes);

  const archive = await JSZip.loadAsync(bytes);
  const entries = Object.values(archive.files)
    .filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith(".txt"))
    .sort((a, b) => a.name.localeCompare(b.name, "ko", { numeric: true }));
  if (!entries.length) throw new Error("압축 파일 안에 TXT 문서가 없습니다.");

  const chapters: string[] = [];
  for (const entry of entries) {
    const chapterBytes = await entry.async("uint8array");
    const text = decodeText(chapterBytes);
    chapters.push(entries.length > 1 ? `\n\n${entry.name}\n\n${text}` : text);
  }
  return chapters.join("\n");
}

function processText(name: string, kind: "txt" | "zip", bytes: Uint8Array): Promise<string> {
  // Android 로컬 WebView(file://)에서는 module Worker 로드가 차단될 수 있다.
  if ((window as any).ReactNativeWebView) return processTextInline(kind, bytes);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../workers/textWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      worker.terminate();
      data.error ? reject(new Error(data.error)) : resolve(data.text);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "텍스트 처리 Worker를 시작하지 못했습니다."));
    };
    worker.postMessage({ name, kind, bytes }, [bytes.buffer]);
  });
}

export async function pickBook(): Promise<OpenedBook | null> {
  const selected = await chooseInBrowser();
  if (!selected) return null;
  const kind = extension(selected.name);
  if (!kind) throw new Error("지원하지 않는 파일 형식입니다.");
  const id = makeId(selected.name, selected.bytes.byteLength, selected.modified);
  if (kind === "epub") {
    const bytes = Uint8Array.from(selected.bytes).buffer;
    return { id, name: selected.name.replace(/\.epub$/i, ""), kind, bytes, openedAt: Date.now() };
  }
  const text = await processText(selected.name, kind, selected.bytes);
  return { id, name: selected.name.replace(/\.(txt|zip)$/i, ""), kind, text, openedAt: Date.now() };
}

async function fromSelection(name: string, bytes: Uint8Array, modified: number): Promise<OpenedBook | null> {
  const kind = extension(name);
  if (!kind) return null;
  const id = makeId(name, bytes.byteLength, modified);
  if (kind === "epub") return { id, name: name.replace(/\.epub$/i, ""), kind, bytes: Uint8Array.from(bytes).buffer, openedAt: modified || Date.now() };
  return { id, name: name.replace(/\.(txt|zip)$/i, ""), kind, rawBytes: Uint8Array.from(bytes).buffer, openedAt: modified || Date.now() };
}

export async function prepareBook(book: OpenedBook): Promise<OpenedBook> {
  if ((book.kind === "epub" && book.bytes) || book.text !== undefined) return book;
  let bytes: Uint8Array;
  
  if (book.file) {
    bytes = new Uint8Array(await book.file.arrayBuffer());
  } else if ((book as any).uri && (window as any).ReactNativeWebView) {
     // 큰 파일도 WebView 메시지 제한을 넘지 않도록 네이티브에서 청크 단위로 받는다.
     bytes = await new Promise<Uint8Array>((resolve, reject) => {
        const requestId = `READ_FILE-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const chunks: Uint8Array[] = [];
        const cleanup = () => {
          clearTimeout(timeout);
          window.removeEventListener('message', listener);
          document.removeEventListener('message', listener);
        };
        const listener = (event: any) => {
           try {
              const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
               if (data?.requestId !== requestId) return;
                if (data.error) {
                  cleanup();
                  reject(new Error(data.error));
               } else if (data.type === 'READ_FILE_CHUNK') {
                  const binary = atob(data.base64);
                  const chunk = new Uint8Array(binary.length);
                  for (let i = 0; i < binary.length; i++) chunk[i] = binary.charCodeAt(i);
                  chunks[data.index] = chunk;
               } else if (data.type === 'READ_FILE_RESULT') {
                  cleanup();
                  const receivedCount = chunks.filter(Boolean).length;
                  if (receivedCount !== data.chunkCount) {
                    reject(new Error(`파일 전송이 완료되지 않았습니다. (${receivedCount}/${data.chunkCount})`));
                    return;
                  }
                  const totalLength = chunks.reduce((sum, chunk) => sum + (chunk?.length || 0), 0);
                  if (totalLength === 0) {
                    reject(new Error("선택한 도서 파일을 읽지 못했습니다."));
                    return;
                  }
                  const result = new Uint8Array(totalLength);
                  let offset = 0;
                  for (const chunk of chunks) {
                    if (!chunk) continue;
                    result.set(chunk, offset);
                    offset += chunk.length;
                  }
                  resolve(result);
               }
           } catch (error) {
              cleanup();
              reject(error);
           }
        };
        const timeout = window.setTimeout(() => {
          cleanup();
          reject(new Error("도서 파일을 읽는 시간이 초과되었습니다."));
        }, 120_000);
        window.addEventListener('message', listener);
        document.addEventListener('message', listener);
        (window as any).ReactNativeWebView.postMessage(JSON.stringify({
          type: 'READ_FILE', requestId, uri: (book as any).uri
        }));
     });
  } else if (book.rawBytes) {
    bytes = new Uint8Array(book.rawBytes.slice(0));
  } else throw new Error("도서 원본 데이터를 찾을 수 없습니다.");
  
  if (book.kind === "epub") return { ...book, bytes: Uint8Array.from(bytes).buffer };
  return { ...book, text: await processText(book.name, book.kind, Uint8Array.from(bytes)), rawBytes: undefined };
}

export async function selectLocalFolder(): Promise<{ path: string; name?: string; handle?: any } | null> {
  if ((window as any).ReactNativeWebView) {
    const result = await nativeRequest<{ payload: { path: string; name?: string; handle: AndroidDirectoryHandle } | null }>(
      "SELECT_FOLDER",
      "SELECT_FOLDER_RESULT",
    );
    return result.payload;
  } else {
    if ('showDirectoryPicker' in window) {
      try {
        const handle = await (window as any).showDirectoryPicker({ mode: 'read' });
        return { path: handle.name, handle };
      } catch (e: any) {
        if (e.name === "AbortError") return null;
        console.warn("showDirectoryPicker failed", e);
      }
    }
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file"; input.multiple = true; input.setAttribute("webkitdirectory", "");
      input.style.display = "none";
      document.body.appendChild(input);
      input.onchange = () => {
        let folderName = "";
        const files = Array.from(input.files ?? []);
        if (files.length > 0 && files[0].webkitRelativePath) {
          folderName = files[0].webkitRelativePath.split("/")[0];
        }
        input.remove(); resolve({ path: folderName || "로컬 폴더", handle: files });
      };
      input.addEventListener("cancel", () => { input.remove(); resolve(null); }, { once: true });
      input.click();
    });
  }
}

export async function scanLocalFolder(path: string, handle?: any): Promise<OpenedBook[]> {
  let books: OpenedBook[] = [];

  if (handle) {
    let selectedFiles: any[] | null = null;
    if (isAndroidDirectoryHandle(handle) && (window as any).ReactNativeWebView) {
      const result = await nativeRequest<{ files: any[] }>("SCAN_FOLDER", "SCAN_FOLDER_RESULT", {
        directoryUri: handle.directoryUri,
      });
      selectedFiles = result.files;
    } else if (Array.isArray(handle)) {
      selectedFiles = handle;
    }

    if (selectedFiles) {
      books = selectedFiles.flatMap((file: any) => {
        const name = file.name || "";
        const kind = extension(name);
        if (kind) {
           return [{
             id: makeId(name, file.size || 0, file.lastModified || Date.now()),
             name: name.replace(/\.(epub|txt|zip)$/i, ""),
             kind,
             file: file instanceof File ? file : undefined,
             uri: file.uri, // For React Native
             openedAt: file.lastModified || Date.now()
           }];
        }
        return [];
      });
    } else if (!isAndroidDirectoryHandle(handle)) {
      const found: File[] = [];
      const walk = async (dirHandle: any) => {
        for await (const entry of dirHandle.values()) {
          if (entry.kind === 'file' && extension(entry.name)) {
            try {
              const file = await entry.getFile();
              found.push(file);
            } catch (e) {
              // File might have been deleted between values() and getFile()
            }
          } else if (entry.kind === 'directory') {
            await walk(entry);
          }
        }
      };
      await walk(handle);
      books = found.map(file => {
        const kind = extension(file.name)!;
        return { id: makeId(file.name, file.size, file.lastModified), name: file.name.replace(/\.(epub|txt|zip)$/i, ""), kind, file, openedAt: file.lastModified || Date.now() };
      });
    }
  }

  books.sort((a, b) => a.name.localeCompare(b.name, "ko", { numeric: true }));
  return books;
}
