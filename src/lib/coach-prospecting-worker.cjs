"use strict";
const store = require("./coach-prospecting-store.cjs");
const {firstControl,pressControl,controlPoint}=require("./linkedin-browser-page.cjs");
const { researchProspect } = require("./prospect-research.cjs");
async function settleDiscovery(page){
 await page.waitForFunction(()=>document.querySelector('main')&&!document.querySelector('main[aria-busy="true"],main [aria-busy="true"],main [role="progressbar"],main .artdeco-loader'),{timeout:12000,polling:'mutation'});
}
async function readDiscoveryState(page) {
  return page.evaluate(() => ({
    url: location.href,
    text: document.body?.innerText.slice(0, 6000) || "",
    urls: [...document.querySelectorAll('main a[href*="/in/"]')]
      .filter((a) => a.getClientRects().length)
      .map((a) => a.href),
  }));
}
async function scrollList(page) {
  const lists=await page.$$('main,main section,main ul,main div');
  let hovered=false;
  try {
    for(const list of lists) {
      const scrollable=await list.evaluate(n=>n.getClientRects().length&&n.scrollHeight>n.clientHeight+100&&['auto','scroll'].includes(getComputedStyle(n).overflowY)&&n.querySelectorAll('a[href*="/in/"]').length>2);
      if(scrollable){const point=await controlPoint(list);await page.mouse.move(point.x,point.y);hovered=true;break;}
    }
    if(!hovered)await page.mouse.move(600,500);
    await page.mouse.wheel({deltaY:650});
  } finally {await Promise.all(lists.map(n=>n.dispose()));}
}
async function nextSearchPage(page, urls, beforeCheck) {
  const next=await firstControl(page,'main button,main a,.artdeco-pagination button,.artdeco-pagination a',n=>/^next(?:\s+page)?$/i.test(n.label.replace(/\s+/g,' ').trim()));
  if(!next)return 'END';
  try {await beforeCheck?.('discovery');await pressControl(page,next);}
  finally {await next.dispose();}
  try {
    const changed = await page.waitForFunction(
      (previous) => {
        const links = [...document.querySelectorAll('main a[href*="/in/"]')]
          .filter((a) => a.getClientRects().length)
          .map((a) => a.href);
        return (
          !document.querySelector('main[aria-busy="true"]') &&
          links.length > 0 &&
          previous.filter(
            (old) =>
              !links.some(
                (url) =>
                  url.split(/[?#]/)[0].replace(/\/+$/, "").toLowerCase() ===
                  old,
              ),
          ).length >= Math.min(3, previous.length)
        );
      },
      { timeout: 20000, polling: 'mutation' },
      [
        ...new Set(
          urls.map((url) =>
            url.split(/[?#]/)[0].replace(/\/+$/, "").toLowerCase(),
          ),
        ),
      ].slice(0, 10),
    );
    await changed?.dispose?.();
    return "NEXT";
  } catch {
    return "STALLED";
  }
}
function restriction(status, url, text = "") {
  if (status === 429)
    return "LinkedIn reported a rate limit. Resolve it before manually resuming this run.";
  if (
    [401, 403, 999].includes(status) ||
    /\/(?:checkpoint|challenge|login|authwall)(?:\/|\?|$)/i.test(url) ||
    /verify (?:you are human|your identity)|security verification|unusual activity|temporarily restricted|you.ve reached.*(?:limit|search)/i.test(
      text,
    )
  )
    return "LinkedIn requires attention. Resolve the account check before manually resuming this run.";
  return "";
}
async function discover(
  page,
  run,
  { pool, owner, log = () => {}, afterScroll = settleDiscovery, beforeCheck },
) {
  let blocked = "";
  const watch = (response) => {
    try {
      if (/^(?:.*\.)?linkedin\.com$/.test(new URL(response.url()).hostname))
        blocked ||= restriction(response.status(), response.url());
    } catch {}
  };
  page.on("response", watch);
  try {
    await beforeCheck?.('discovery');
    const response = await page.goto(
      store.sourceUrl(
        run.source,
        run.source === "SEARCH" && run.data.cursorUrl
          ? run.data.cursorUrl
          : run.data.sourceUrl,
      ),
      { waitUntil: "domcontentloaded", timeout: 45000 },
    );
    await page.waitForSelector("main", { timeout: 12000 }).catch(() => {});
    const search = run.source === "SEARCH";
    let stopReason = 'The rendered list has no more profiles.';
    let stagnant = 0,
      previous = run.data.seen?.length || 0;
    // People Search uses explicit Next pages; network lists use scrolling.
    // Follow rendered controls only, without inventing URLs or private API pagination.
    for (;;) {
      let state = await readDiscoveryState(page);
      if (!/^(?:.*\.)?linkedin\.com$/.test(new URL(state.url).hostname))
        throw Error(
          "The discovery page left LinkedIn; no profiles were collected from that page.",
        );
      blocked ||= restriction(response?.status(), state.url, state.text);
      if (blocked) {
        await store.pauseAccount(pool, run.account_id, blocked);
        return { paused: blocked };
      }
      const updated = await store.sourceProgress(
        pool,
        run.id,
        owner,
        state.urls,
        {
          pages: (run.data.pages || 0) + 1,
          ...(search ? { cursorUrl: state.url } : {}),
          message:
            "Discovering visible profiles. Exact job titles are not used to discard candidates.",
        },
      );
      if (!updated) return { stopped: true };
      run = updated;
      log(
        `Prospecting: ${run.data.queued}/${run.data.limit} profiles queued; ${run.data.skipped} existing or excluded profiles skipped.`,
      );
      if (run.status !== "RUNNING") return { done: true };
      if (search) {
        await beforeCheck?.('discovery');
        await scrollList(page);
        await afterScroll(page);
        if (!(await store.runIsActive(pool, run.id))) return { stopped: true };
        // Capture cards that rendered while scrolling before leaving this page.
        const settled = await readDiscoveryState(page);
        if (!/^(?:.*\.)?linkedin\.com$/.test(new URL(settled.url).hostname))
          throw Error("The discovery page left LinkedIn.");
        blocked ||= restriction(200, settled.url, settled.text);
        if (blocked) {
          await store.pauseAccount(pool, run.account_id, blocked);
          return { paused: blocked };
        }
        if (settled.urls.join("\n") !== state.urls.join("\n")) {
          const updated = await store.sourceProgress(
            pool,
            run.id,
            owner,
            settled.urls,
            { pages: run.data.pages, cursorUrl: settled.url },
          );
          if (!updated) return { stopped: true };
          run = updated;
          state = settled;
          if (run.status !== "RUNNING") return { done: true };
        }
        const advanced = await nextSearchPage(page, state.urls, beforeCheck);
        if (blocked) {
          await store.pauseAccount(pool, run.account_id, blocked);
          return { paused: blocked };
        }
        if (advanced !== "NEXT") {
          stopReason =
            advanced === "END"
              ? "LinkedIn has no enabled Next search page."
              : "The next search page did not finish loading; collected profiles are retained.";
          break;
        }
        continue;
      }
      stagnant = run.data.seen.length === previous ? stagnant + 1 : 0;
      previous = run.data.seen.length;
      if (stagnant >= 3) {
        stopReason = "The visible list stopped loading additional profiles.";
        break;
      }
      await beforeCheck?.('discovery');
      await scrollList(page);
      await afterScroll(page);
    }
    await store.sourceProgress(
      pool,
      run.id,
      owner,
      [],
      {
        discoveryFinished: true,
        message: `${stopReason} ${run.data.queued} of ${run.data.limit} new profiles queued; ${run.data.skipped} existing or excluded profiles skipped.`,
      },
      true,
    );
    return { done: true };
  } catch (error) {
    if(error.failure?.code==='WORKER_PAUSED'){await store.releaseSource(pool,run.id,owner);return {stopped:true};}
    if (blocked) {
      await store.pauseAccount(pool, run.account_id, blocked);
      return { paused: blocked };
    }
    await store.sourceProgress(
      pool,
      run.id,
      owner,
      [],
      {
        discoveryFinished: true,
        message:
          "Discovery stopped: " +
          String(error.message).slice(0, 250) +
          ". Collected profiles remain saved.",
      },
      true,
    );
    return { error: true };
  } finally {
    page.off("response", watch);
  }
}
async function finish(pool, owner, job, result) {
  if (!(await store.runIsActive(pool, job.prospecting.runId)))
    return { status: "CANCELLED" };
  if (result.status === "ERROR")
    return { status: "ERROR", failure: result.failure, logs: result.logs };
  // Reuse captured profile evidence. Website research runs without holding or revisiting LinkedIn.
  let research = result.prospectQualification?.research;
  if (!research)
    research = await researchProspect(
      { ...result, linkedinUrl: result.url },
      { ai: false, maxPages: 8, maxTimeMs: 30000 },
    );
  const saved = await store.finishProfile(
    pool,
    { ...job, owner },
    result,
    research,
  );
  return {
    ...result,
    ...saved,
    firstName: result.firstName || "",
    url: result.url,
    headline: result.headline,
    about: result.about,
    profileIdentityConfirmed: result.profileIdentityConfirmed,
    linkedinContact: result.linkedinContact,
    emails: result.emails || [],
    website: research.website,
    prospectQualification: { research },
    logs: result.logs || [],
  };
}
module.exports = { discover, finish, restriction, nextSearchPage };
