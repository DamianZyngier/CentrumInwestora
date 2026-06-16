// IndexedDB Management
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
    async saveTransactions(transactions) {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        
        for (const t of transactions) {
            store.add(t);
        }
        
        return new Promise((resolve) => tx.oncomplete = () => resolve());
    },
    
    async getAllTransactions() {
        const db = await openDB();
        return new Promise((resolve) => {
            const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).getAll();
            request.onsuccess = () => resolve(request.result);
        });
    },
    
    async clearAll() {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
        return new Promise((resolve) => tx.oncomplete = () => resolve());
    }
};
