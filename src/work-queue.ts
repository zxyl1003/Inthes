// A shared queue bounds uploads across panels. Direct PDF reading takes priority
// over library work that has not started yet.
export class WorkQueue {
  private active = 0;
  private waiting: { priority: number; start: () => void }[] = [];
  private limit: number;
  constructor(limit: number) { this.limit=limit; }
  setLimit(limit: number) { this.limit=limit; this.next(); }
  reduce() { this.limit=Math.max(1,Math.floor(this.limit/2)); return this.limit; }
  run<T>(signal: AbortSignal, work: () => Promise<T>, priority = 0): Promise<T> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const entry = { priority, start: () => {
        signal.removeEventListener('abort', cancel); this.active++;
        Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(resolve, reject).finally(() => { this.active--; this.next(); });
      } };
      const cancel = () => { const index = this.waiting.indexOf(entry); if (index >= 0) this.waiting.splice(index, 1); signal.removeEventListener('abort', cancel); reject(signal.reason); };
      this.waiting.push(entry); this.waiting.sort((a, b) => b.priority - a.priority);
      signal.addEventListener('abort', cancel, { once: true }); this.next();
    });
  }
  private next() { while (this.active < this.limit && this.waiting.length) this.waiting.shift()!.start(); }
}
export const readingQueue = new WorkQueue(3);
export const analysisQueue = new WorkQueue(4);
