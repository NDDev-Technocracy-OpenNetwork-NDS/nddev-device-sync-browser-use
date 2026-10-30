"use strict";
// A popup opened as a page of its own, as in tests, names the tab it acts for.
const forTab = Number(new URLSearchParams(location.search).get("tab")) || undefined;
const LANGUAGE = "popupLanguage";
const element = (id) => document.getElementById(id);
let language = "en";
let messages = {};
let last;
let lastRecording = {};
let lastSteps = {};
function t(key, ...values) {
    const text = messages[key]?.message ?? key;
    return text.replace(/\$(\d)/g, (_, index) => String(values[Number(index) - 1] ?? ""));
}
async function loadLanguage() {
    const stored = await chrome.storage.local
        .get(LANGUAGE)
        .then((values) => values[LANGUAGE])
        .catch(() => undefined);
    const wanted = stored === "en" || stored === "ru"
        ? stored
        : chrome.i18n.getUILanguage().toLowerCase().startsWith("ru")
            ? "ru"
            : "en";
    language = wanted;
    messages = (await fetch(chrome.runtime.getURL(`_locales/${language}/messages.json`)).then((response) => response.json()));
    document.documentElement.lang = language;
    for (const node of document.querySelectorAll("[data-i18n]")) {
        node.textContent = t(node.dataset.i18n ?? "");
    }
    for (const button of document.querySelectorAll("button[data-language]")) {
        button.setAttribute("aria-pressed", String(button.dataset.language === language));
    }
}
for (const button of document.querySelectorAll("button[data-language]")) {
    button.addEventListener("click", async () => {
        await chrome.storage.local.set({ [LANGUAGE]: button.dataset.language }).catch(() => undefined);
        await loadLanguage();
        render();
    });
}
const DESCRIPTIONS = {
    full: "observationFull",
    standard: "observationStandard",
    off: "observationOff",
};
function show(status) {
    last = status;
    render();
}
function render() {
    if (last)
        renderStatus(last);
    renderRecording(lastRecording);
    renderSteps(lastSteps);
}
function renderStatus(status) {
    const mismatch = status.hostContract !== undefined;
    const link = mismatch ? "mismatch" : !status.connected ? "down" : status.enabled ? "ok" : "off";
    document.body.dataset.link = link;
    document.body.dataset.compatible = String(!mismatch);
    const linkText = element("link");
    if (linkText) {
        linkText.textContent = t({ ok: "linkOk", off: "linkOff", down: "linkDown", mismatch: "linkMismatch" }[link]);
    }
    const notice = element("mismatch");
    if (notice) {
        notice.hidden = !mismatch;
        notice.textContent = mismatch ? t("mismatch", status.hostContract ?? "") : "";
    }
    // Without the host nothing works: a store install tells the owner where to get it.
    const setup = element("setup");
    if (setup)
        setup.hidden = link !== "down";
    const toggle = element("toggle");
    if (toggle) {
        toggle.setAttribute("aria-checked", String(status.enabled));
        toggle.disabled = false;
    }
    const control = element("control-note");
    if (control) {
        control.textContent = status.enabled
            ? `${t("controlOn")}${status.tabs ? ` ${t("agentTabs", status.tabs)}` : ""}`
            : t("controlOff");
    }
    const current = status.observation ?? "full";
    for (const button of profiles) {
        button.setAttribute("aria-pressed", String(button.dataset.profile === current));
        button.disabled = false;
    }
    const described = element("observation");
    if (described)
        described.textContent = t(DESCRIPTIONS[current]);
    document.body.dataset.observation = current;
    renderTab(status);
    renderPrivate(status);
    const versions = element("versions");
    if (versions) {
        const own = status.version ?? chrome.runtime.getManifest().version;
        versions.textContent = status.host
            ? t("versions", own, `${status.host.version} ${status.host.commit.slice(0, 7)}`)
            : t("versionsNoHost", own);
    }
}
function renderTab(status) {
    const state = element("tab-state");
    const note = element("tab-note");
    if (!state || !note)
        return;
    state.replaceChildren();
    if (status.group) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = t("tabAgent", status.group);
        state.append(badge);
        note.textContent = t("tabAgentNote");
    }
    else {
        state.textContent = status.hasTab === false ? t("tabNone") : t("tabOwner");
        note.textContent = status.hasTab === false ? "" : t("tabOwnerNote");
    }
    if (status.site) {
        const site = document.createElement("span");
        site.className = "site";
        site.textContent = status.site;
        state.append(site);
    }
    // Recording and the agent's steps belong to agent tabs; elsewhere they would only explain why
    // they do not work.
    const agentTab = Boolean(status.group);
    document.body.dataset.agentTab = String(agentTab);
    for (const id of ["record", "recording", "activity"]) {
        const part = element(id);
        if (part)
            part.hidden = !agentTab;
    }
}
// Private sites: the owner adds the site of the tab and removes any listed one.
function renderPrivate(status) {
    const list = element("private");
    const add = element("private-add");
    if (!list || !add)
        return;
    const sites = status.privateSites ?? [];
    list.replaceChildren(...sites.map((site) => {
        const item = document.createElement("li");
        item.textContent = site;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "×";
        remove.title = t("privateRemove", site);
        remove.setAttribute("aria-label", t("privateRemove", site));
        remove.addEventListener("click", () => void changePrivate("remove", site));
        item.append(remove);
        return item;
    }));
    if (sites.length === 0) {
        const empty = document.createElement("li");
        empty.className = "empty";
        empty.textContent = t("privateEmpty");
        empty.style.border = "0";
        empty.style.background = "transparent";
        empty.style.paddingLeft = "0";
        list.append(empty);
    }
    list.dataset.count = String(sites.length);
    const site = status.site;
    add.disabled = !site || sites.includes(site);
    add.dataset.site = site ?? "";
    add.textContent = site
        ? sites.includes(site)
            ? t("privateIs", site)
            : t("privateAdd", site)
        : t("privateAddAny");
}
async function changePrivate(action, site) {
    show((await chrome.runtime.sendMessage({ type: "private", action, site, tab: forTab })));
}
element("private-add")?.addEventListener("click", (event) => {
    const site = event.currentTarget.dataset.site;
    if (site)
        void changePrivate("add", site);
});
const toggle = element("toggle");
toggle?.addEventListener("click", async () => {
    toggle.disabled = true;
    const enabled = toggle.getAttribute("aria-checked") !== "true";
    show((await chrome.runtime.sendMessage({ type: "set", enabled, tab: forTab })));
});
const profiles = [...document.querySelectorAll("button[data-profile]")];
for (const button of profiles) {
    button.addEventListener("click", async () => {
        for (const each of profiles)
            each.disabled = true;
        show((await chrome.runtime.sendMessage({
            type: "observe",
            profile: button.dataset.profile,
            tab: forTab,
        })));
    });
}
// The recorder of the agent group of this tab: what the owner does there becomes a timeline the
// agent reads with `recorder events`, for example to write a skill from it.
const REFUSED = {
    no_agent_tab: "refusedNoAgentTab",
    session_not_found: "refusedSession",
    busy: "refusedBusy",
    permission_required: "refusedPermission",
    extension_unavailable: "refusedHost",
    timeout: "refusedTimeout",
};
function renderRecording(answer) {
    const record = element("record");
    const label = element("record-label");
    const note = element("recording");
    if (!record || !label || !note)
        return;
    const active = answer.recording === true;
    label.textContent = t(active ? "stopRecord" : "record");
    record.classList.toggle("recording", active);
    record.classList.toggle("primary", !active);
    record.dataset.recording = String(active);
    record.disabled = answer.error === "no_agent_tab";
    document.body.dataset.recording = answer.error ? "error" : String(active);
    note.textContent = answer.error
        ? REFUSED[answer.error]
            ? t(REFUSED[answer.error] ?? "")
            : (answer.message ?? answer.error)
        : active
            ? t("recordingNow", answer.events ?? 0)
            : answer.id
                ? t("recordedDone", answer.events ?? 0)
                : t("recordHint");
}
async function ask(action) {
    lastRecording = (await chrome.runtime.sendMessage({
        type: "record",
        action,
        tab: forTab,
    }));
    renderRecording(lastRecording);
}
element("record")?.addEventListener("click", (event) => {
    const record = event.currentTarget;
    record.disabled = true;
    void ask(record.dataset.recording === "true" ? "stop" : "start");
});
// The newest steps of the agent group of the owner's tab, as its activity journal holds them.
const KINDS = {
    action: "kindAction",
    navigation: "kindNavigation",
    page: "kindPage",
    network: "kindNetwork",
    execution: "kindExecution",
    download: "kindDownload",
    console: "kindConsole",
    dialog: "kindDialog",
    "page-error": "kindPageError",
    recording: "kindRecording",
    "person-action": "kindPersonAction",
    toast: "kindToast",
};
function ago(at) {
    const time = typeof at === "string" ? Date.parse(at) : Number.NaN;
    if (Number.isNaN(time))
        return "";
    const seconds = Math.round((time - Date.now()) / 1000);
    const format = new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "narrow" });
    if (Math.abs(seconds) < 60)
        return format.format(seconds, "second");
    if (Math.abs(seconds) < 3600)
        return format.format(Math.round(seconds / 60), "minute");
    if (Math.abs(seconds) < 86_400)
        return format.format(Math.round(seconds / 3600), "hour");
    return format.format(Math.round(seconds / 86_400), "day");
}
function step(line) {
    const item = document.createElement("li");
    let record = {};
    try {
        record = JSON.parse(line);
    }
    catch {
        record = { type: "other", text: line };
    }
    const type = typeof record.type === "string" ? record.type : "other";
    item.dataset.type = type;
    item.dataset.private = String(record.private === true);
    item.dataset.error = String(record.ok === false || typeof record.error === "string" || typeof record.failure === "string");
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = ago(record.at);
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = t(KINDS[type] ?? "kindOther");
    const what = document.createElement("span");
    what.className = "what";
    const summary = [
        record.api,
        record.action,
        record.method,
        record.locator,
        record.url,
        record.text,
        record.name,
        record.message,
    ]
        .filter((part) => typeof part === "string" && part !== "")
        .join(" ");
    what.textContent = record.private === true ? `${t("private")} ${summary}`.trim() : summary;
    what.title = what.textContent;
    item.append(when, kind, what);
    return item;
}
function renderSteps(answer) {
    const list = element("recent");
    const note = element("recent-note");
    if (!list || !note)
        return;
    const lines = answer.lines ?? [];
    list.replaceChildren(...lines.slice().reverse().map(step));
    note.textContent = answer.error
        ? t(answer.error === "no_agent_tab" ? "activityNoTab" : "activityHost")
        : lines.length === 0
            ? t("activityNone")
            : t("activityHint");
    document.body.dataset.recent = String(lines.length);
}
async function refreshSteps() {
    lastSteps = (await chrome.runtime.sendMessage({ type: "recent", tab: forTab }));
    renderSteps(lastSteps);
}
void loadLanguage()
    .catch(() => undefined)
    .then(async () => {
    show((await chrome.runtime.sendMessage({ type: "get", tab: forTab })));
    await Promise.all([ask("status"), refreshSteps()]);
});
// While the popup stays open, the agent's newest steps and the recorder keep current.
setInterval(() => {
    void refreshSteps();
    if (lastRecording.recording)
        void ask("status");
}, 2000);
