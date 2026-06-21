import type { OpenedBook } from "../types";

const DATABASE = "durumari-library";
const STORE = "books";
const PAGINATION_STORE = "pagination";

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "id" });
      if (!request.result.objectStoreNames.contains(PAGINATION_STORE)) request.result.createObjectStore(PAGINATION_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadPagination(key: string): Promise<Int32Array | null> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(PAGINATION_STORE, "readonly");
    const request = transaction.objectStore(PAGINATION_STORE).get(key);
    request.onsuccess = () => resolve(request.result ? new Int32Array(request.result as number[]) : null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

export async function savePagination(key: string, starts: Int32Array): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(PAGINATION_STORE, "readwrite");
    transaction.objectStore(PAGINATION_STORE).put(Array.from(starts), key);
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); reject(transaction.error); };
  });
}

export async function loadLibraryBooks(): Promise<OpenedBook[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readonly");
    const request = transaction.objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result as OpenedBook[]);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

export async function saveLibraryBooks(books: OpenedBook[]): Promise<void> {
  if (!books.length) return;
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    for (const book of books) store.put(book);
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); reject(transaction.error); };
  });
}

export async function deleteLibraryBooks(bookIds: string[]): Promise<void> {
  if (!bookIds.length) return;
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    for (const id of bookIds) store.delete(id);
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); reject(transaction.error); };
  });
}
