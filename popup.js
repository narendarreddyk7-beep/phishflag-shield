const toggle = document.getElementById("toggle");
const checkedCount = document.getElementById("checkedCount");
const flaggedCount = document.getElementById("flaggedCount");

async function render() {
  const { enabled = true, stats = { checked: 0, flagged: 0 } } =
    await chrome.storage.local.get(["enabled", "stats"]);
  toggle.checked = enabled;
  checkedCount.textContent = stats.checked;
  flaggedCount.textContent = stats.flagged;
}

toggle.addEventListener("change", () => {
  chrome.storage.local.set({ enabled: toggle.checked });
});

render();
