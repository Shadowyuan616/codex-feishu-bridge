import { chmodSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Hold a write reservation in a dedicated local SQLite database for our lifetime.
 * Never unlink this file: all contenders must lock the same inode. Deployment
 * requires local XFS/ext4/APFS storage, not GPFS/NFS. The application data database
 * is separate and remains writable while this reservation is held.
 */
export function acquireInstanceLock(stateDir: string): () => void {
  if (!isAbsolute(stateDir)) throw new Error('Instance-lock state directory must be absolute');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, 'instance-lock.sqlite');
  const db = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
    db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE;');
  } catch (error) {
    db.close();
    const failure = error as { errcode?: number; code?: string; message?: string };
    if (failure.errcode === 5 || failure.code === 'SQLITE_BUSY' || /database is locked/i.test(failure.message ?? '')) {
      throw new Error('已有桥接进程持有此 stateDir 的实例锁，请勿启动重复消费者');
    }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { db.exec('ROLLBACK;'); }
    finally { db.close(); }
  };
}
