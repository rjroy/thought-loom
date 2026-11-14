import { expect, test } from "bun:test";
import { DailyReviewDriver } from "../src/agent/daily-review-driver";
import type { DailyReviewAdmission } from "../src/domain/daily-review";
import { createLogger, type LogRecord } from "../src/logging";

test.each(["empty","deferred","error"] as const)("%s retries at a bounded cadence and rolls forward without backdating", async kind => {
  let now = "2031-01-01T12:00:00.000Z", calls = 0, notify = 0;
  const logs: LogRecord[] = [];
  let tick: () => void = () => {};
  const driver = new DailyReviewDriver({now:() => now,startTimer:callback => { tick = callback; return () => {}; },
    notifyWork:() => { notify++; },logger:createLogger("verbose",record => logs.push(record)),admit:at => {
      calls++;
      if (kind === "error") throw new Error("private-owned-exception");
      return {kind,date:at.slice(0,10)};
    }});
  try {
    driver.start(); await driver.wake(); expect(calls).toBe(1);
    for (let i=0;i<20;i++) await driver.wake();
    expect(calls).toBe(1);
    now = "2031-01-01T12:00:59.000Z"; await driver.wake(); expect(calls).toBe(1);
    now = "2031-01-01T12:01:00.000Z"; await driver.wake(); expect(calls).toBe(2);
    now = "2031-01-04T00:00:00.000Z"; await driver.wake(); expect(calls).toBe(3);
    now = "2031-01-03T00:00:00.000Z"; await driver.wake(); expect(calls).toBe(3);
    expect(notify).toBe(0);
    expect(JSON.stringify(logs)).not.toContain("private-owned-exception");
  } finally { await driver.stop(); }
  tick(); await driver.wake(); expect(calls).toBe(3);
});

test("sealed dates suppress repeated work while a later day wakes the existing supervisor", async () => {
  let now = "2031-01-01T12:00:00.000Z", calls = 0, notifications = 0;
  const driver = new DailyReviewDriver({now:() => now,startTimer:() => () => {},notifyWork:() => { notifications++; },admit:at => {
    calls++; return {kind:"admitted",date:at.slice(0,10),runIds:[`owned-${calls}`]};
  }});
  try {
    driver.start(); await driver.wake();
    for (let i=0;i<20;i++) await driver.wake();
    expect(calls).toBe(1); expect(notifications).toBe(1);
    now = "2031-01-03T12:00:00.000Z"; await driver.wake();
    expect(calls).toBe(2); expect(notifications).toBe(2);
    now = "2031-01-02T12:00:00.000Z"; await driver.wake(); expect(calls).toBe(2);
  } finally { await driver.stop(); }
});

test("overlapping wakes coalesce and stop joins the entered admission without a late notification", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<DailyReviewAdmission>();
  let calls = 0, notifications = 0, tick: () => void = () => {};
  const driver = new DailyReviewDriver({now:() => "2031-01-01T12:00:00.000Z",startTimer:callback => { tick = callback; return () => {}; },
    notifyWork:() => { notifications++; },admit:() => { calls++; entered.resolve(); return release.promise; }});
  driver.start(); await entered.promise;
  const first = driver.wake(), second = driver.wake();
  expect(first).toBe(second); expect(calls).toBe(1);
  let stopped = false;
  const stopping = driver.stop().then(() => { stopped = true; });
  try {
    await Promise.resolve(); expect(stopped).toBe(false);
    tick();
    release.resolve({kind:"admitted",date:"2031-01-01",runIds:["owned"]});
    await stopping; await first;
    tick(); await driver.wake();
    expect(calls).toBe(1); expect(notifications).toBe(0);
  } finally { release.resolve({kind:"admitted",date:"2031-01-01",runIds:["owned"]}); await stopping; }
});
