'use strict';

/**
 * Trwałe przechowywanie transakcji w IndexedDB (dane nie opuszczają przeglądarki).
 * Deduplikacja opiera się na stabilnym kluczu transakcji (Processor.keyFromTransaction),
 * dzięki czemu ponowne wgranie tego samego pliku nie dubluje danych.
 */

const DB_NAME = 'InvestorCenterDB';
const DB_VERSION = 1;
const STORE_NAME = 'transactions';

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      }
    };
    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

const DB = {
  async getAllTransactions() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  },

  async saveTransactions(transactions) {
    if (!transactions || transactions.length === 0) return { added: 0, skipped: 0 };

    const db = await openDB();
    const existing = await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });

    const keys = new Set();
    for (const transaction of existing) {
      const key =
        transaction.key ||
        (typeof Processor !== 'undefined' ? Processor.keyFromTransaction(transaction) : null);
      if (key) keys.add(key);
    }

    return new Promise((resolve, reject) => {
      const dbTx = db.transaction(STORE_NAME, 'readwrite');
      const store = dbTx.objectStore(STORE_NAME);
      let added = 0;
      let skipped = 0;

      // Migracja starych rekordów bez klucza (jednorazowa, nieszkodliwa).
      for (const transaction of existing) {
        if (!transaction.key && typeof Processor !== 'undefined') {
          transaction.key = Processor.keyFromTransaction(transaction);
          store.put(transaction);
        }
      }

      for (const transaction of transactions) {
        const key =
          transaction.key ||
          (typeof Processor !== 'undefined' ? Processor.keyFromTransaction(transaction) : null);
        if (key && keys.has(key)) {
          skipped += 1;
          continue;
        }
        if (key) keys.add(key);
        store.add(transaction);
        added += 1;
      }

      dbTx.oncomplete = () => resolve({ added, skipped });
      dbTx.onerror = () => reject(dbTx.error);
      dbTx.onabort = () => reject(dbTx.error);
    });
  },

  async clearAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const dbTx = db.transaction(STORE_NAME, 'readwrite');
      dbTx.objectStore(STORE_NAME).clear();
      dbTx.oncomplete = () => resolve();
      dbTx.onerror = () => reject(dbTx.error);
    });
  },
};

window.DB = DB;
