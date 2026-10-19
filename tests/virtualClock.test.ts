import { describe, expect, test } from "bun:test";
import { VirtualClock } from "./helpers/virtualClock";

describe("VirtualClock", () => {
  test("setTimeout fires on advance, not before", async () => {
    const clock = new VirtualClock();
    let fired = 0;
    clock.setTimeout(() => ++fired, 100);
    await clock.advance(50);
    expect(fired).toBe(0);
    await clock.advance(50);
    expect(fired).toBe(1);
    expect(clock.now()).toBe(100);
  });

  test("multiple timers fire in due-time order", async () => {
    const clock = new VirtualClock();
    const order: string[] = [];
    clock.setTimeout(() => order.push("late"), 200);
    clock.setTimeout(() => order.push("early"), 50);
    clock.setTimeout(() => order.push("middle"), 100);
    await clock.advance(200);
    expect(order).toEqual(["early", "middle", "late"]);
  });

  test("clearTimeout prevents firing", async () => {
    const clock = new VirtualClock();
    let fired = 0;
    const id = clock.setTimeout(() => ++fired, 100);
    clock.clearTimeout(id);
    await clock.advance(1000);
    expect(fired).toBe(0);
  });

  test("setInterval fires repeatedly and clearInterval stops it", async () => {
    const clock = new VirtualClock();
    let ticks = 0;
    const id = clock.setInterval(() => ++ticks, 50);
    await clock.advance(200);
    expect(ticks).toBe(4);
    clock.clearInterval(id);
    await clock.advance(200);
    expect(ticks).toBe(4);
  });

  test("advance returns after flushing", async () => {
    const clock = new VirtualClock();
    const done: number[] = [];
    clock.setTimeout(() => done.push(clock.now()), 10);
    clock.setTimeout(() => done.push(clock.now()), 20);
    await clock.advance(100);
    expect(done).toEqual([10, 20]);
    expect(clock.now()).toBe(100);
  });
});
