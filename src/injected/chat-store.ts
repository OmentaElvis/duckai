/**
 * Read-only access to duck.ai's own conversation store (IndexedDB
 * `savedAIChatData`). Kept in one small module so that if duck.ai's persistence
 * layout changes, this is the only file to fix.
 *
 * We only ever read the set of conversation ids — never content — and only to
 * reconcile our sidecar tool history after the user deletes a chat. Returns
 * `null` (rather than throwing) whenever the store can't be read, so callers
 * can safely skip pruning.
 */

const DB_NAME = "savedAIChatData";
const STORE = "saved-chats";
const META_KEY = "__metadata__";

export function savedConversationIds(): Promise<Set<string> | null> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME);
    } catch {
      resolve(null);
      return;
    }
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      try {
        if (!db.objectStoreNames.contains(STORE)) {
          db.close();
          resolve(null);
          return;
        }
        const tx = db.transaction(STORE, "readonly");
        const keysReq = tx.objectStore(STORE).getAllKeys();
        keysReq.onsuccess = () => {
          const ids = new Set<string>();
          for (const key of keysReq.result) {
            const id = String(key);
            if (id && id !== META_KEY) ids.add(id);
          }
          db.close();
          resolve(ids);
        };
        keysReq.onerror = () => {
          db.close();
          resolve(null);
        };
      } catch {
        try {
          db.close();
        } catch {
          /* ignore */
        }
        resolve(null);
      }
    };
  });
}
