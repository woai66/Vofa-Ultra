import { describe, expect, it } from "vitest";
import { RingBuffer } from "./ringBuffer";

describe("RingBuffer", () => {
  it("按插入顺序返回未满缓冲", () => {
    const buffer = new RingBuffer<number>(3);
    buffer.pushMany([1, 2]);

    expect(buffer.length).toBe(2);
    expect(buffer.toArray()).toEqual([1, 2]);
  });

  it("容量满后覆盖最旧数据", () => {
    const buffer = new RingBuffer<number>(3);
    buffer.pushMany([1, 2, 3, 4, 5]);

    expect(buffer.length).toBe(3);
    expect(buffer.toArray()).toEqual([3, 4, 5]);
  });

  it("清空后可以重新使用", () => {
    const buffer = new RingBuffer<string>(2);
    buffer.push("old");
    buffer.clear();
    buffer.push("new");

    expect(buffer.length).toBe(1);
    expect(buffer.toArray()).toEqual(["new"]);
  });

  it("拒绝无效容量", () => {
    expect(() => new RingBuffer(0)).toThrow("positive integer");
    expect(() => new RingBuffer(1.5)).toThrow("positive integer");
  });
});
