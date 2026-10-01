// PhishFlag Shield — content script
//
// Runs on every normal web page. Watches links, and when you hover over
// one for a moment, asks the background worker to check it against the
// real PhishFlag scanner. Safe links get a green underline; risky links
// get a red outline, a tooltip explaining why, and a confirmation banner
// if you actually try to click through.

(async function () {
  const { enabled = true } = await chrome.storage.local.get("enabled");
  if (!enabled) return;

  const HOVER_DELAY_MS = 350;
  const processed = new WeakSet(); // links we've already wired up
  const hoverTimers = new WeakMap(); // link -> pending timeout id

  // ---------- one shared tooltip element, reused for every link ----------
  const tooltip = document.createElement("div");
  tooltip.className = "phishflag-tooltip";
  tooltip.style.display = "none";
  document.documentElement.appendChild(tooltip);

  function positionTooltip(anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    tooltip.style.left = `${window.scrollX + rect.left}px`;
    tooltip.style.top = `${window.scrollY + rect.bottom + 6}px`;
  }

  function showTooltip(anchorEl, text, kind) {
    tooltip.textContent = text;
    tooltip.className = `phishflag-tooltip phishflag-tooltip--${kind}`;
    positionTooltip(anchorEl);
    tooltip.style.display = "block";
  }

  function hideTooltip() {
    tooltip.style.display = "none";
  }

  // ---------- click-confirmation banner for flagged links ----------
  let banner = null;

  function showWarningBanner(url, verdict, riskScore, onContinue) {
    if (banner) banner.remove();

    banner = document.createElement("div");
    banner.className = "phishflag-banner";
    banner.innerHTML = `
      <div class="phishflag-banner__text">
        <strong>PhishFlag warning:</strong> this link was flagged
        <strong>${verdict}</strong> (risk score ${riskScore}/100).
        <span class="phishflag-banner__url">${url}</span>
      </div>
      <div class="phishflag-banner__actions">
        <button type="button" class="phishflag-btn phishflag-btn--ghost" data-action="cancel">Go back</button>
        <button type="button" class="phishflag-btn phishflag-btn--danger" data-action="continue">Continue anyway</button>
      </div>
    `;
    document.documentElement.appendChild(banner);

    banner.querySelector('[data-action="cancel"]').addEventListener("click", () => {
      banner.remove();
      banner = null;
    });
    banner.querySelector('[data-action="continue"]').addEventListener("click", () => {
      banner.remove();
      banner = null;
      onContinue();
    });
  }

  // ---------- applying a scan result to a link ----------
  function applyResult(linkEl, result) {
    linkEl.classList.remove("phishflag-checking");

    if (result.status === "safe") {
      linkEl.classList.add("phishflag-safe");
      linkEl.dataset.pfState = "safe";
    } else if (result.status === "unsafe") {
      linkEl.classList.add("phishflag-unsafe");
      linkEl.dataset.pfState = "unsafe";
      linkEl.dataset.pfVerdict = result.verdict;
      linkEl.dataset.pfScore = result.riskScore;

      // Intercept clicks on flagged links until the user explicitly confirms.
      linkEl.addEventListener(
        "click",
        function interceptor(e) {
          if (linkEl.dataset.pfConfirmed === "true") return; // already confirmed once
          e.preventDefault();
          e.stopImmediatePropagation();
          showWarningBanner(linkEl.href, result.verdict, result.riskScore, () => {
            linkEl.dataset.pfConfirmed = "true";
            linkEl.click();
          });
        },
        true
      );
    } else {
      // error / disabled — leave the link unstyled, don't claim it's safe
      linkEl.dataset.pfState = "error";
    }
  }

  function shouldScan(linkEl) {
    const href = linkEl.href;
    if (!href || !/^https?:\/\//i.test(href)) return false;
    try {
      const linkHost = new URL(href).hostname;
      if (linkHost === location.hostname) return false; // skip same-site links
    } catch {
      return false;
    }
    return true;
  }

  function handleHoverStart(linkEl) {
    if (!shouldScan(linkEl)) return;
    if (linkEl.dataset.pfState === "safe" || linkEl.dataset.pfState === "unsafe") {
      // already resolved earlier — just show the tooltip again
      const kind = linkEl.dataset.pfState;
      const text =
        kind === "safe"
          ? "PhishFlag: looks safe"
          : `PhishFlag: don't click — flagged ${linkEl.dataset.pfVerdict} (${linkEl.dataset.pfScore}/100)`;
      showTooltip(linkEl, text, kind);
      return;
    }
    if (hoverTimers.has(linkEl)) return;

    const timer = setTimeout(async () => {
      hoverTimers.delete(linkEl);
      linkEl.classList.add("phishflag-checking");
      showTooltip(linkEl, "PhishFlag: checking…", "checking");

      const result = await chrome.runtime.sendMessage({
        type: "PHISHFLAG_CHECK_URL",
        url: linkEl.href,
      });

      applyResult(linkEl, result);

      if (result.status === "safe") {
        showTooltip(linkEl, "PhishFlag: looks safe", "safe");
      } else if (result.status === "unsafe") {
        showTooltip(linkEl, `PhishFlag: don't click — flagged ${result.verdict} (${result.riskScore}/100)`, "unsafe");
      } else {
        hideTooltip();
      }
    }, HOVER_DELAY_MS);

    hoverTimers.set(linkEl, timer);
  }

  function handleHoverEnd(linkEl) {
    const timer = hoverTimers.get(linkEl);
    if (timer) {
      clearTimeout(timer);
      hoverTimers.delete(linkEl);
    }
    hideTooltip();
  }

  function wireLink(linkEl) {
    if (processed.has(linkEl)) return;
    processed.add(linkEl);
    linkEl.addEventListener("mouseenter", () => handleHoverStart(linkEl));
    linkEl.addEventListener("mouseleave", () => handleHoverEnd(linkEl));
  }

  function scanPage(root) {
    root.querySelectorAll("a[href]").forEach(wireLink);
  }

  scanPage(document);

  // Pages like Gmail load content dynamically — watch for new links.
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        if (node.matches?.("a[href]")) wireLink(node);
        scanPage(node);
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
