// PhishFlag Shield — background service worker
//
// Responsibilities:
//  - Call the real PhishFlag API (https://phishflag.app/api/scan) for a URL.
//  - Cache results so the same link isn't re-scanned repeatedly (protects
//    the free-tier rate limit on the server: 10 scans/minute/IP).
//  - Limit how many scans can be in flight at once, so a page full of
//    links doesn't fire dozens of requests simultaneously.
//  - Track simple session stats for the popup, and hold the on/off switch.

const API_URL = "https://phishflag.app/api/scan";
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CONCURRENT = 3;

const cache = new Map(); // url -> { result, timestamp }
const pending = new Map(); // url -> Promise (de-dupes simultaneous requests for the same url)
let activeRequests = 0;
const queue = [];

function cleanCache() {
  const now = Date.now();
  for (const [url, entry] of cache) {
    if (now - entry.timestamp > CACHE_TTL_MS) cache.delete(url);
  }
}

async function runQueued() {
  if (activeRequests >= MAX_CONCURRENT || queue.length === 0) return;
  const job = queue.shift();
  activeRequests++;
  try {
    await job();
  } finally {
    activeRequests--;
    runQueued();
  }
}

function enqueue(fn) {
  return new Promise((resolve) => {
    queue.push(async () => {
      const result = await fn();
      resolve(result);
    });
    runQueued();
  });
}

async function scanUrl(url) {
  cleanCache();

  const cached = cache.get(url);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.result;
  }

  if (pending.has(url)) {
    return pending.get(url);
  }

  const promise = enqueue(async () => {
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      if (res.status === 429) {
        return { status: "error", message: "Rate limited, try again shortly." };
      }
      if (!res.ok) {
        return { status: "error", message: `Scan failed (${res.status}).` };
      }

      const data = await res.json();
      const result = {
        status: data.riskLevel === "Low" ? "safe" : "unsafe",
        riskLevel: data.riskLevel,
        verdict: data.verdict,
        riskScore: data.riskScore,
      };

      cache.set(url, { result, timestamp: Date.now() });
      bumpStat(result.status);
      return result;
    } catch (err) {
      return { status: "error", message: "Could not reach PhishFlag." };
    } finally {
      pending.delete(url);
    }
  });

  pending.set(url, promise);
  return promise;
}

async function bumpStat(status) {
  const { stats = { checked: 0, flagged: 0 } } = await chrome.storage.local.get("stats");
  stats.checked += 1;
  if (status === "unsafe") stats.flagged += 1;
  await chrome.storage.local.set({ stats });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PHISHFLAG_CHECK_URL") {
    chrome.storage.local.get({ enabled: true }).then(({ enabled }) => {
      if (!enabled) {
        sendResponse({ status: "disabled" });
        return;
      }
      scanUrl(message.url).then(sendResponse);
    });
    return true; // keep the message channel open for the async response
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get({ enabled: true, stats: { checked: 0, flagged: 0 } }).then((current) => {
    chrome.storage.local.set(current);
  });
});
