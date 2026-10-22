"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  vm = require("node:vm");
const store = require("../../src/lib/coach-prospecting-store.cjs");
const {
  discover,
  nextSearchPage,
} = require("../../src/lib/coach-prospecting-worker.cjs");

// Execute the real worker's DOM callbacks against paginated ten-result pages.
// The Next control changes pages; scrolling never changes the result set.
function searchPage({
  pages = 10,
  stalled = false,
  restrictAt = 0,
  disabled = false,
  lazy = false,
} = {}) {
  let index = 1,
    hydrated = !lazy,
    polls = 0;
  const handlers = new Map(),
    calls = { clicks: 0, reads: 0, urls: [] };
  const location = {
    href: "https://www.linkedin.com/search/results/people/?keywords=career%20coach&network=%5B%22S%22%5D",
  };
  const links = () =>
    Array.from({ length: hydrated ? 10 : 3 }, (_, n) => ({
      href: `https://www.linkedin.com/in/search-coach-${(index - 1) * 10 + n}/`,
      getClientRects: () => [{}],
    }));
  const next = {
    disabled: false,
    getClientRects: () => [{}],
    getAttribute: (name) =>
      name === "aria-label"
        ? "Next"
        : name === "aria-disabled" && disabled
          ? "true"
          : null,
    innerText: "Next",
    classList: { contains: () => false },
    scrollIntoView() {},
    click() {
      calls.clicks++;
      if (stalled) return;
      index++;
      hydrated = !lazy;
      const u = new URL(location.href);
      u.searchParams.set("page", String(index));
      location.href = u.href;
      if (index === restrictAt)
        handlers.get("response")?.({
          status: () => 429,
          url: () => location.href,
        });
    },
  };
  const document = {
    body: { innerText: "People search results" },
    querySelector: () => null,
    querySelectorAll: (selector) => {
      if (selector === 'main a[href*="/in/"]') return links();
      if (selector.includes("pagination")) return index < pages ? [next] : [];
      return [];
    },
  };
  const evaluate = (fn, ...args) =>
    vm.runInNewContext("(" + fn.toString() + ")(...args)", {
      args,
      document,
      location,
      window: {
        scrollBy() {
          hydrated = true;
        },
      },
      innerHeight: 800,
      getComputedStyle: () => ({ overflowY: "auto" }),
    });
  return {
    calls,
    mouse:{move:async()=>{},wheel:async()=>{hydrated=true;}},
    $$:async selector=>document.querySelectorAll(selector).map(node=>({evaluate:async fn=>fn(node),click:async()=>node.click(),hover:async()=>{},dispose:async()=>{}})),
    on: (event, fn) => handlers.set(event, fn),
    off: (event) => handlers.delete(event),
    goto: async (url) => {
      calls.urls.push(url);
      location.href = url;
      index = Number(new URL(url).searchParams.get("page")) || 1;
      return { status: () => 200 };
    },
    waitForSelector: async () => {},
    evaluate: async (fn, ...args) => {
      if (fn.toString().includes("text:")) calls.reads++;
      return evaluate(fn, ...args);
    },
    waitForFunction: async (fn, _options, ...args) => {
      for (let n = 0; n < 3; n++) {
        polls++;
        if (evaluate(fn, ...args)) return { dispose: async () => {} };
      }
      throw Error("Next result page did not load.");
    },
  };
}
async function scan(
  page,
  { limit = 100, existing = 0, active = true, cursorUrl, beforeCheck } = {},
) {
  const saved = {
    progress: store.sourceProgress,
    active: store.runIsActive,
    pause: store.pauseAccount,
  };
  const seen = new Set(),
    captured = new Set();
  let last,
    paused = "";
  try {
    store.runIsActive = async () => active;
    store.pauseAccount = async (_p, _a, reason) => {
      paused = reason;
    };
    store.sourceProgress = async (_p, _id, _owner, urls, info, finished) => {
      for (const url of urls) {
        if (seen.has(url)) continue;
        seen.add(url);
        if (
          Number(url.match(/-(\d+)\//)[1]) >= existing &&
          captured.size < limit
        )
          captured.add(url);
      }
      last = {
        ...run,
        status: finished || captured.size >= limit ? "QUEUED" : "RUNNING",
        data: {
          ...last?.data,
          ...run.data,
          ...info,
          queued: captured.size,
          skipped: seen.size - captured.size,
          seen: [...seen],
        },
      };
      return last;
    };
    const run = {
      id: "fixture-search",
      account_id: "fixture-account",
      source: "SEARCH",
      data: {
        limit,
        queued: 0,
        pages: 0,
        seen: [],
        sourceUrl:
          "https://www.linkedin.com/search/results/people/?keywords=career%20coach&network=%5B%22S%22%5D",
        cursorUrl,
      },
    };
    const result = await discover(page, run, {
      pool: {},
      owner: "fixture-owner",
      pause: async () => {},
      beforeCheck,
    });
    return { result, last, paused, captured };
  } finally {
    store.sourceProgress = saved.progress;
    store.runIsActive = saved.active;
    store.pauseAccount = saved.pause;
  }
}
test("100 requested profiles are collected across ten People Search pages, preserving search filters", async () => {
  const checks=[];
  const p = searchPage(),
    r = await scan(p,{beforeCheck:async kind=>checks.push(kind)});
  assert.deepEqual(checks,Array(19).fill('discovery'));
  assert.equal(r.captured.size, 100);
  assert.equal(p.calls.clicks, 9);
  assert.equal(r.last.data.pages, 10);
  assert.equal(r.result.done, true);
  assert.match(r.last.data.cursorUrl, /keywords=career\+coach/);
  assert.match(r.last.data.cursorUrl, /network=/);
});
test("existing profiles on earlier pages do not stop discovery before 100 new candidates", async () => {
  const p = searchPage({ pages: 12 }),
    r = await scan(p, { existing: 20 });
  assert.equal(r.captured.size, 100);
  assert.equal(r.last.data.skipped, 20);
  assert.equal(p.calls.clicks, 11);
});

test("cards that finish rendering after the first read are saved before advancing", async () => {
  const p = searchPage({ lazy: true }),
    r = await scan(p);
  assert.equal(r.captured.size, 100);
  assert.equal(p.calls.clicks, 9);
  assert.equal(r.last.data.pages, 10);
});

test("the page budget stops a search even when every displayed profile already exists", async () => {
  const p = searchPage({ pages: 51 }),
    r = await scan(p, { existing: 1000 });
  assert.equal(r.captured.size, 0);
  assert.equal(p.calls.clicks, 49);
  assert.match(r.last.data.message, /50-page budget/);
});
test("exhausted and stalled searches report the actual shortfall instead of claiming the target", async () => {
  for (const stalled of [false, true]) {
    const p = searchPage({ pages: 3, stalled }),
      r = await scan(p);
    assert.equal(r.captured.size, stalled ? 10 : 30);
    assert.match(r.last.data.message, /of 100 new profiles/);
    assert.match(
      r.last.data.message,
      stalled ? /did not finish loading/ : /no enabled Next/,
    );
  }
});
test("restriction and cancellation stop pagination without a further page request", async () => {
  const blockedPage = searchPage({ restrictAt: 2 }),
    blocked = await scan(blockedPage);
  assert.match(blocked.paused, /rate limit/);
  assert.equal(blockedPage.calls.clicks, 1);
  assert.equal(blocked.captured.size, 10);
  const cancelledPage = searchPage(),
    cancelled = await scan(cancelledPage, { active: false });
  assert.equal(cancelled.result.stopped, true);
  assert.equal(cancelledPage.calls.clicks, 0);
});
test("a saved search cursor resumes on its captured page and a disabled Next control is never clicked", async () => {
  const p = searchPage(),
    r = await scan(p, {
      limit: 10,
      cursorUrl:
        "https://www.linkedin.com/search/results/people/?keywords=career%20coach&page=4",
    });
  assert.match(p.calls.urls[0], /page=4/);
  assert.equal(r.captured.size, 10);
  assert.equal(p.calls.clicks, 0);
  const disabled = searchPage({ disabled: true });
  assert.equal(await nextSearchPage(disabled, []), "END");
  assert.equal(disabled.calls.clicks, 0);
});
