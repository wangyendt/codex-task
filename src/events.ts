import type { TaskEvent } from "./types.js";

export class EventQueue implements AsyncIterable<TaskEvent> {
  private readonly values: TaskEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<TaskEvent>) => void> = [];
  private done = false;

  push(event: TaskEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.values.push(event);
  }

  close(): void {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<TaskEvent> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value) return { value, done: false };
        if (this.done) return { value: undefined, done: true };
        return new Promise<IteratorResult<TaskEvent>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
