// Shared by every reader and panel. Submission limits count files, not requests.
export class MinerURateLimit {
  private entries: { at: number; count: number }[] = [];
  private blockedUntil = 0;
  private limit: number;
  constructor(limit: number) { this.limit = limit; }
  defer(ms: number) { this.blockedUntil = Math.max(this.blockedUntil, Date.now() + ms); }
  async acquire(count: number, signal: AbortSignal, progress?: (text: string) => void) {
    if (!Number.isInteger(count) || count < 1 || count > this.limit) throw new Error('MinerU 单次提交文件数超出限制');
    while (true) {
      signal.throwIfAborted();
      const now = Date.now();
      this.entries = this.entries.filter(e => e.at + 60000 > now);
      let used = this.entries.reduce((sum, e) => sum + e.count, 0), ready = this.blockedUntil;
      for (const entry of this.entries) {
        if (used + count <= this.limit) break;
        ready = Math.max(ready, entry.at + 60000); used -= entry.count;
      }
      if (ready <= now) { this.entries.push({ at: now, count }); return; }
      progress?.(`MinerU · 等待频率窗口，约 ${Math.ceil((ready - now) / 1000)} 秒后继续`);
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ready - now);
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      });
    }
  }
}
export const mineruSubmissions = new MinerURateLimit(50);
export const mineruResults = new MinerURateLimit(1000);
