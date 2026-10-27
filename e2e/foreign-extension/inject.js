// Injects this extension's page into the e2e fixture's /foreign page shortly after it loads.
if (location.pathname === "/foreign") {
  setTimeout(() => {
    const frame = document.createElement("iframe");
    frame.id = "foreign";
    frame.src = chrome.runtime.getURL("frame.html");
    document.body.append(frame);
  }, 500);
}
