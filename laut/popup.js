const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const readSelBtn = $("readSel");
const readPageBtn = $("readPage");
const selHint = $("selHint");
const playBtn = $("play");
const stopBtn = $("stop");
const backBtn = $("back");
const fwdBtn = $("fwd");
const speedBtn = $("speed");
const voiceSel = $("voice");
const trSel = $("translateTo");
const trNote = $("trNote");
const trDownload = $("trDownload");
const contrastBtn = $("contrast");
const progressText = $("progressText");
const remainingEl = $("remaining");
const bar = $("bar");

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
const TARGETS = ["pt", "en", "es", "fr", "de", "it", "ja", "ko", "zh", "ru", "ar", "hi"];
const CHARS_PER_SECOND = 15;

let rate = 1;
let active = false;
let paused = false;
let blocked = false;
let currentTabId = null;
let pageLang = "";
let pageTranslated = false; // a página já foi traduzida pelo Chrome
let voiceMap = {}; // voz escolhida por idioma
let pollTimer = null;

const names = new Intl.DisplayNames(["pt-BR"], { type: "language" });
const langName = (c) => { try { return names.of(c) || c; } catch { return c; } };
const fmtRate = (r) => String(Number(r)).replace(".", ",") + "×";
const send = (msg) => chrome.runtime.sendMessage(msg);
const setStatus = (t) => (statusEl.textContent = t);

function fmtRemaining(chars, r) {
  const secs = chars / (CHARS_PER_SECOND * (r || 1));
  if (secs < 60) return "menos de 1 min";
  return `≈ ${Math.round(secs / 60)} min restantes`;
}

function renderState(st) {
  active = !!st.active;
  paused = active && !!st.paused;
  const playing = active && !paused;

  document.body.classList.toggle("speaking", playing);
  stopBtn.disabled = backBtn.disabled = fwdBtn.disabled = !active;
  playBtn.disabled = blocked;

  const label = playing ? "Pausar" : active ? "Continuar" : "Ler";
  playBtn.title = playBtn.ariaLabel = label;

  if (active) {
    progressText.textContent = `Frase ${st.idx + 1} de ${st.total}`;
    remainingEl.textContent = fmtRemaining(st.remainingChars, st.rate);
    bar.style.width = ((st.idx + 1) / st.total) * 100 + "%";
  } else {
    progressText.textContent = "Nada em leitura";
    remainingEl.textContent = "";
    bar.style.width = "0";
  }

  if (paused) setStatus("Leitura pausada.");
  else if (playing) setStatus(st.target ? `Lendo traduzido para ${langName(st.target)}…` : "Lendo em voz alta…");
  else if (statusEl.dataset.sticky !== "1") setStatus("Pronto para ler.");
}

async function refresh() {
  renderState(await send({ type: "status" }));
}

// Seleção atual (em qualquer quadro/iframe ou campo de texto) e idioma da página.
// Devolve null quando a página não permite leitura.
async function pageInfo(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        let n = (window.getSelection ? window.getSelection().toString() : "").trim().length;
        if (!n) {
          const a = document.activeElement;
          if (a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT") &&
              typeof a.selectionStart === "number" && a.selectionStart !== a.selectionEnd) {
            try { n = a.value.substring(a.selectionStart, a.selectionEnd).trim().length; } catch (e) { /* ignora */ }
          }
        }
        return { n, lang: document.documentElement.lang || "" };
      },
    });
    const top = results.find((r) => r.frameId === 0) || results[0];
    let lang = top && top.result ? top.result.lang : "";
    let translated = false;
    // Idioma de verdade, pelo texto (a página pode ter sido traduzida pelo Chrome)
    try {
      const frame = { tabId, frameIds: [0] };
      await chrome.scripting.executeScript({ target: frame, files: ["content.js"] });
      const [d] = await chrome.scripting.executeScript({ target: frame, func: () => window.__laut.pageLanguage() });
      if (d && d.result) { lang = d.result.lang || lang; translated = !!d.result.translated; }
    } catch { /* fica com o atributo lang */ }
    return {
      n: Math.max(0, ...results.map((r) => (r.result ? r.result.n : 0))),
      lang,
      translated,
    };
  } catch {
    return null;
  }
}

// "Ler seleção" nunca fica travado: se a detecção falhar, clicar mostra o motivo
async function updateSelectionButton() {
  const info = await pageInfo(currentTabId);
  if (info === null) {
    blocked = true;
    readSelBtn.disabled = readPageBtn.disabled = true;
    selHint.textContent = "Indisponível aqui";
    statusEl.dataset.sticky = "1";
    setStatus("Esta página não permite leitura.");
    return;
  }
  pageLang = info.lang;
  pageTranslated = info.translated;
  selHint.textContent = info.n > 0
    ? `${info.n.toLocaleString("pt-BR")} caracteres`
    : "Selecione um texto";
}

// Mostra o motivo se o atalho ou o botão direito falharam há pouco tempo
async function showLastError() {
  try {
    const { lastError } = await chrome.storage.session.get("lastError");
    if (lastError && lastError.tabId === currentTabId && Date.now() - lastError.t < 120000) {
      statusEl.dataset.sticky = "1";
      setStatus(lastError.msg);
    }
    await chrome.storage.session.remove("lastError");
    if (currentTabId != null) chrome.action.setBadgeText({ tabId: currentTabId, text: "" });
  } catch { /* ignora */ }
}

// ---------- Voz (uma escolha para cada idioma) ----------
// Idioma que será falado: o da tradução, ou o da própria página
function spokenLang() {
  const own = sourceLang() || (navigator.language || "pt").split("-")[0].toLowerCase();
  return trSel.value && trSel.value !== own ? trSel.value : own;
}

async function loadVoices() {
  const want = spokenLang();
  const voices = await chrome.tts.getVoices();
  let list = voices.filter((v) => (v.lang || "").toLowerCase().startsWith(want));
  if (!list.length) list = voices;

  voiceSel.innerHTML = "";
  voiceSel.add(new Option(`Voz automática (${langName(want)})`, ""));
  for (const v of list) {
    voiceSel.add(new Option(`${v.voiceName}${v.lang ? " — " + v.lang : ""}`, v.voiceName));
  }
  const saved = voiceMap[want];
  voiceSel.value = list.some((v) => v.voiceName === saved) ? saved : "";
}

// ---------- Tradução ----------
function setNote(text) {
  trNote.textContent = text;
  trNote.hidden = !text;
}

function buildTargets() {
  trSel.add(new Option("Sem tradução", ""));
  for (const c of TARGETS) trSel.add(new Option(`Traduzir para ${langName(c)}`, c));
}

function sourceLang() {
  return (pageLang || "").split("-")[0].toLowerCase();
}

async function checkTranslation() {
  const target = trSel.value;
  trDownload.hidden = true;
  setNote("");
  if (!target) return;

  if (!("Translator" in self)) {
    setNote("A tradução precisa do Chrome 138 ou mais novo, no computador.");
    return;
  }
  const source = sourceLang();
  if (!source) {
    setNote("Não achei o idioma desta página; vou tentar descobrir pelo texto ao ler.");
    return;
  }
  if (source === target) {
    setNote(`Esta página já está em ${langName(target)}${pageTranslated ? " (traduzida pelo Chrome)" : ""}. Vou ler sem traduzir.`);
    return;
  }
  try {
    const a = await Translator.availability({ sourceLanguage: source, targetLanguage: target });
    if (a === "available") {
      setNote("Tradução feita no seu computador: o texto não sai dele.");
    } else if (a === "unavailable") {
      setNote("Este par de idiomas não está disponível no seu computador.");
    } else {
      setNote(`Falta baixar o idioma (${langName(source)} → ${langName(target)}). É só uma vez.`);
      trDownload.disabled = false;
      trDownload.hidden = false;
    }
  } catch {
    setNote("Não consegui verificar a tradução agora.");
  }
}

trDownload.addEventListener("click", async () => {
  const target = trSel.value;
  const source = sourceLang();
  trDownload.disabled = true;
  setNote("Baixando o idioma… mantenha o popup aberto.");
  try {
    const t = await Translator.create({
      sourceLanguage: source,
      targetLanguage: target,
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          setNote(`Baixando o idioma… ${Math.round(e.loaded * 100)}%`);
        });
      },
    });
    if (t && typeof t.destroy === "function") t.destroy();
    trDownload.hidden = true;
    await checkTranslation();
  } catch {
    setNote("Não consegui baixar o idioma. Tente de novo.");
    trDownload.disabled = false;
  }
});

trSel.addEventListener("change", async () => {
  chrome.storage.local.set({ translateTo: trSel.value });
  await loadVoices();
  checkTranslation();
});

// ---------- Leitura ----------
async function read(mode) {
  statusEl.dataset.sticky = "";
  setStatus("Preparando leitura…");
  const res = await send({ type: "read-tab", tabId: currentTabId, mode, translateTo: trSel.value });
  if (!res.ok) {
    statusEl.dataset.sticky = "1";
    setStatus(res.error || "Não foi possível ler.");
  }
  refresh();
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab ? tab.id : null;

  const saved = await chrome.storage.local.get({ rate: 1, voiceByLang: {}, translateTo: "", contrast: null });

  // Alto contraste: segue a escolha da pessoa; sem escolha, segue a preferência do sistema
  const wantsHC = saved.contrast === null
    ? window.matchMedia("(prefers-contrast: more)").matches
    : !!saved.contrast;
  setContrast(wantsHC, saved.contrast === null && wantsHC);
  rate = Number(saved.rate) || 1;
  voiceMap = saved.voiceByLang || {};
  speedBtn.textContent = fmtRate(rate);

  buildTargets();
  trSel.value = TARGETS.includes(saved.translateTo) ? saved.translateTo : "";

  await updateSelectionButton();
  await showLastError();
  await Promise.all([loadVoices(), checkTranslation()]);
  await refresh();
  pollTimer = setInterval(refresh, 500);
}

// Alto contraste muda as cores do TEXTO na página (lido / falta ler / palavra atual),
// nunca as cores da própria extensão.
function setContrast(on, persist = true) {
  contrastBtn.setAttribute("aria-pressed", String(on));
  if (persist) chrome.storage.local.set({ contrast: on });
}
contrastBtn.addEventListener("click", () => setContrast(contrastBtn.getAttribute("aria-pressed") !== "true"));

readSelBtn.addEventListener("click", () => read("selection"));
readPageBtn.addEventListener("click", () => read("page"));

playBtn.addEventListener("click", async () => {
  if (!active) return read("auto");
  renderState(await send({ type: paused ? "resume" : "pause" }));
});

stopBtn.addEventListener("click", async () => {
  statusEl.dataset.sticky = "";
  await send({ type: "stop" });
  setStatus("Leitura parada.");
  refresh();
});

backBtn.addEventListener("click", async () => renderState(await send({ type: "skip", dir: -1 })));
fwdBtn.addEventListener("click", async () => renderState(await send({ type: "skip", dir: 1 })));

speedBtn.addEventListener("click", () => {
  const i = RATES.findIndex((r) => Math.abs(r - rate) < 0.01);
  rate = RATES[(i + 1) % RATES.length];
  speedBtn.textContent = fmtRate(rate);
  chrome.storage.local.set({ rate });
});

voiceSel.addEventListener("change", () => {
  const key = spokenLang();
  if (voiceSel.value) voiceMap[key] = voiceSel.value;
  else delete voiceMap[key];
  chrome.storage.local.set({ voiceByLang: { ...voiceMap } });
});

window.addEventListener("unload", () => clearInterval(pollTimer));
init();
