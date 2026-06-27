import type { OpenedBook } from "../types";

const DATABASE = "durumari-library";
const STORE = "books";
const PAGINATION_STORE = "pagination";
const MAX_PAGINATION_CACHE_ENTRIES = 80;

type StoredPagination = {
  starts?: Int32Array | ArrayBuffer | number[];
  updatedAt?: number;
};

function normalizePagination(value: unknown): Int32Array | null {
  if (!value) return null;
  if (value instanceof Int32Array) return value;
  if (value instanceof ArrayBuffer) return new Int32Array(value);
  if (Array.isArray(value)) return Int32Array.from(value);
  const record = value as StoredPagination;
  if (record.starts instanceof Int32Array) return record.starts;
  if (record.starts instanceof ArrayBuffer) return new Int32Array(record.starts);
  if (Array.isArray(record.starts)) return Int32Array.from(record.starts);
  return null;
}

function database(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
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
  return new Promise<Int32Array | null>((resolve, reject) => {
    const transaction = db.transaction(PAGINATION_STORE, "readonly");
    const request = transaction.objectStore(PAGINATION_STORE).get(key);
    request.onsuccess = () => resolve(normalizePagination(request.result));
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

export async function savePagination(key: string, starts: Int32Array): Promise<void> {
  const db = await database();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(PAGINATION_STORE, "readwrite");
    transaction.objectStore(PAGINATION_STORE).put({ starts, updatedAt: Date.now() }, key);
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); reject(transaction.error); };
  }).then(prunePaginationCache);
}

async function prunePaginationCache(): Promise<void> {
  const db = await database();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(PAGINATION_STORE, "readwrite");
    const store = transaction.objectStore(PAGINATION_STORE);
    const keysRequest = store.getAllKeys();
    const valuesRequest = store.getAll();
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); reject(transaction.error); };
    keysRequest.onsuccess = () => {
      const keys = keysRequest.result;
      if (keys.length <= MAX_PAGINATION_CACHE_ENTRIES) return;
      valuesRequest.onsuccess = () => {
        const values = valuesRequest.result as StoredPagination[];
        keys
          .map((key, index) => ({ key, updatedAt: values[index]?.updatedAt ?? 0 }))
          .sort((a, b) => a.updatedAt - b.updatedAt)
          .slice(0, keys.length - MAX_PAGINATION_CACHE_ENTRIES)
          .forEach(({ key }) => store.delete(key));
      };
    };
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
