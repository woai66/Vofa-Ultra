export class RingBuffer<T> {
  private readonly buffer: Array<T | undefined>;
  private head = 0;
  private itemCount = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error("RingBuffer capacity must be a positive integer");
    }
    this.buffer = new Array<T | undefined>(capacity);
  }

  get length(): number {
    return this.itemCount;
  }

  push(value: T): void {
    const writeIndex = (this.head + this.itemCount) % this.capacity;
    this.buffer[writeIndex] = value;

    if (this.itemCount < this.capacity) {
      this.itemCount += 1;
    } else {
      this.head = (this.head + 1) % this.capacity;
    }
  }

  pushMany(values: Iterable<T>): void {
    for (const value of values) {
      this.push(value);
    }
  }

  clear(): void {
    this.buffer.fill(undefined);
    this.head = 0;
    this.itemCount = 0;
  }

  toArray(): T[] {
    const result: T[] = [];
    for (let index = 0; index < this.itemCount; index += 1) {
      const value = this.buffer[(this.head + index) % this.capacity];
      result.push(value as T);
    }
    return result;
  }
}
