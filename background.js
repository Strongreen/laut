// Laut — service worker
// Toca a leitura frase por frase com chrome.tts, avisa a página qual frase
// destacar (e traduzir, se pedido) e continua lendo com o popup fechado.

// voiceByLang guarda a voz escolhida para cada idioma, ex.: { pt: "Voz A", en: "Voice C" }
const DEFAULTS = { rate: 1, voiceByLang: {} };
const CHARS_PER_SECOND = 15; // fala média em velocidade 1×

const ERRORS = {
  "no-api": "O tradutor do Chrome não está disponível aqui (precisa do Chrome 138+ no computador e de uma página segura, https).",
  "unavailable": "Este par de idiomas não está disponível no seu computador.",
  "needs-download": "Falta baixar o idioma de tradução. Use o botão de baixar no popup.",
  "no-source": "Não consegui descobrir o idioma desta página.",
  "failed": "O tradutor do Chrome falhou. Tente de novo.",
};

let session = null;
let keepAliveTimer = null;

async function getSettings() {
  const s = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...s };
}

const quiet = (p) => Promise.resolve(p).catch(() => {});

// ---------- Aviso quando não há popup aberto (atalho / botão direito) ----------
function reportError(tabId, msg) {
  quiet(chrome.storage.session.set({ lastError: { msg, tabId, t: Date.now() } }));
  if (tabId == null) return;
  quiet(chrome.action.setBadgeBackgroundColor({ tabId, color: "#fbad18" }));
  if (chrome.action.setBadgeTextColor) quiet(chrome.action.setBadgeTextColor({ tabId, color: "#1d1708" }));
  quiet(chrome.action.setBadgeText({ tabId, text: "!" }));
  quiet(chrome.action.setTitle({ tabId, title: `Laut: ${msg}` }));
}
function clearError(tabId) {
  quiet(chrome.storage.session.remove("lastError"));
  if (tabId == null) return;
  quiet(chrome.action.setBadgeText({ tabId, text: "" }));
  quiet(chrome.action.setTitle({ tabId, title: "Laut" }));
}

// Mantém o service worker acordado durante a leitura
function startKeepAlive() {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
}
function stopKeepAlive() {
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}

// ---------- Cores do destaque na página ----------
// Padrão: faixa âmbar na frase e palavra escura.
// Alto contraste: muda a cor do TEXTO da página: já lido (azul-acinzentado), o que falta ler
// (âmbar no fundo escuro, marrom-âmbar no claro), uma faixa na frase e a palavra atual em destaque forte.
// Azul contra âmbar se distingue em todos os tipos comuns de daltonismo, e a palavra também é sublinhada.
function highlightCss(highContrast, dark) {
  if (!highContrast) {
    return "::highlight(laut){background-color:#fbad18;color:#1d1708}" +
           "::highlight(laut-word){background-color:#1d1708;color:#ffffff;text-decoration:underline}";
  }
  return dark
    ? "::highlight(laut-read){color:#8ea4bf}" +
      "::highlight(laut-unread){color:#fbad18}" +
      "::highlight(laut){background-color:#3a2d08}" +
      "::highlight(laut-word){background-color:#fbad18;color:#1d1708;text-decoration:underline}"
    : "::highlight(laut-read){color:#4d6a8c}" +
      "::highlight(laut-unread){color:#6b3f00}" +
      "::highlight(laut){background-color:#ffe9b8}" +
      "::highlight(laut-word){background-color:#1d1708;color:#fbad18;text-decoration:underline}";
}

async function applyTheme(s) {
  if (s.noPage) return;
  const { contrast } = await chrome.storage.local.get({ contrast: false });
  // a inserção mais recente vence, então não precisa remover a anterior
  await quiet(chrome.scripting.insertCSS({
    target: { tabId: s.tabId, frameIds: [s.frameId || 0] },
    css: highlightCss(!!contrast, !!s.dark),
  }));
}

// Avisa a página (content script) sobre a frase/palavra atual
function tellPage(s, msg) {
  if (s.noPage) return;
  quiet(chrome.tabs.sendMessage(s.tabId, msg, { frameId: s.frameId || 0 }));
}

// Executa uma função dentro do quadro (frame) onde a leitura está acontecendo
function inPage(s, func, args = []) {
  if (s.noPage) return Promise.resolve(null);
  return chrome.scripting
    .executeScript({ target: { tabId: s.tabId, frameIds: [s.frameId || 0] }, func, args })
    .catch(() => null);
}
const highlight = (s, i) => inPage(s, (n) => window.__laut && window.__laut.highlight(n), [i]);
const clearHighlight = (s) => inPage(s, () => window.__laut && window.__laut.clear());

function finish() {
  if (!session) return;
  const s = session;
  session = null;
  s.token++;
  chrome.tts.stop();
  stopKeepAlive();
  clearHighlight(s);
}

// A voz que a pessoa escolheu para o idioma que está sendo lido (sempre respeitada)
function pickVoice(s, lang) {
  const key = (lang || navigator.language || "").toLowerCase().split("-")[0];
  const name = (s.voiceByLang || {})[key];
  if (!name) return null;
  const known = s.voices || [];
  return !known.length || known.some((v) => v.voiceName === name) ? name : null;
}

async function playFrom(i) {
  const s = session;
  if (!s) return;
  if (i >= s.chunks.length) return finish();

  s.idx = i;
  s.paused = false;
  const token = ++s.token;

  chrome.tts.stop();
  highlight(s, i);

  let text = s.chunks[i];
  let lang = s.lang;

  if (s.translating) {
    const res = await inPage(s, (n) => window.__laut.translated(n), [i]);
    if (s !== session || token !== s.token) return;
    const t = res && res[0] && res[0].result;
    if (typeof t === "string" && t.trim()) {
      text = t;
      lang = s.target;
    }
  }

  const opts = {
    rate: Number(s.rate) || 1,
    onEvent: (e) => {
      if (s !== session || token !== s.token) return;
      const wordsOk = !s.translating; // traduzido: as palavras não coincidem com a página
      if (e.type === "start") {
        s.startedAt = Date.now();
        if (wordsOk) tellPage(s, { type: "laut-start", i, cps: s.cps, estimate: !s.realWords });
      } else if (e.type === "word") {
        if (wordsOk) {
          s.realWords = true;
          tellPage(s, { type: "laut-word", i, charIndex: e.charIndex, length: e.length });
        }
      } else if (e.type === "end") {
        // aprende o ritmo real da voz para estimar melhor as próximas frases
        const secs = s.startedAt ? (Date.now() - s.startedAt) / 1000 : 0;
        if (secs > 0.8 && text.length >= 30) {
          s.cps = Math.min(60, Math.max(5, 0.4 * s.cps + 0.6 * (text.length / secs)));
        }
        playFrom(i + 1);
      } else if (e.type === "error") {
        finish();
      }
    },
  };
  const voice = pickVoice(s, lang);
  if (voice) opts.voiceName = voice;
  else if (lang) opts.lang = lang;

  chrome.tts.speak(text, opts);
}

function pause() {
  if (!session || session.paused) return;
  session.paused = true;
  session.token++;       // ignora eventos da frase interrompida
  chrome.tts.stop();     // pausa "de verdade" não funciona em todas as vozes
  tellPage(session, { type: "laut-stop-word" });
}

function resume() {
  if (session && session.paused) playFrom(session.idx);
}

// Pula ~10 segundos (estimado pelo tamanho das frases)
function skip(dir) {
  if (!session) return;
  const { chunks, idx, rate } = session;
  const target = CHARS_PER_SECOND * 10 * (Number(rate) || 1);
  let i = idx;
  let acc = 0;

  if (dir > 0) {
    while (i < chunks.length && acc < target) { acc += chunks[i].length; i++; }
    if (i >= chunks.length) return finish();
  } else {
    while (i > 0 && acc < target) { i--; acc += chunks[i].length; }
  }
  playFrom(i);
}

function status() {
  if (!session) return { active: false };
  return {
    active: true,
    paused: session.paused,
    idx: session.idx,
    total: session.chunks.length,
    remainingChars: session.suffix[session.idx] || 0,
    rate: session.rate,
    target: session.translating ? session.target : null,
  };
}

// ---------- Divisão em frases (usada quando não há página para consultar) ----------
function plainChunks(text) {
  const MAX = 160;
  const s = text.replace(/\s+/g, " ").trim();
  const out = [];
  let cur = "";
  const flush = () => { if (cur.trim()) out.push(cur.trim()); cur = ""; };

  const re = /[^.!?…]+[.!?…]*\s*/g;
  let m;
  while ((m = re.exec(s))) {
    let piece = m[0];
    while (piece.length > MAX) {
      let cut = piece.lastIndexOf(",", MAX);
      if (cut < 40) cut = piece.lastIndexOf(" ", MAX);
      if (cut < 40) cut = MAX;
      flush();
      const head = piece.slice(0, cut + 1).trim();
      if (head) out.push(head);
      piece = piece.slice(cut + 1);
    }
    if (cur && (cur.length >= 40 || cur.length + piece.length > MAX)) flush();
    cur += piece;
  }
  flush();
  return out;
}

async function beginSession(fields) {
  const { rate, voiceByLang } = await getSettings();
  const voices = await Promise.resolve(chrome.tts.getVoices()).catch(() => []);
  const chunks = fields.chunks;
  const suffix = new Array(chunks.length + 1).fill(0);
  for (let i = chunks.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + chunks[i].length;

  session = {
    frameId: 0, noPage: false, lang: "", translating: false, target: null,
    ...fields, suffix, voices, idx: 0, paused: false, token: 0, rate, voiceByLang,
    cps: CHARS_PER_SECOND * (Number(rate) || 1), // velocidade da voz, aprendida a cada frase
    realWords: false,                            // a voz emite eventos de palavra?
  };
  applyTheme(session);
  startKeepAlive();
  playFrom(session.startIdx || 0);
}

// ---------- Onde está a seleção? (página principal, iframe ou campo de texto) ----------
async function findSelectionFrame(tabId) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const s = (window.getSelection ? window.getSelection().toString() : "").trim();
        if (s) return s.length;
        const a = document.activeElement;
        if (a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT") &&
            typeof a.selectionStart === "number" && a.selectionStart !== a.selectionEnd) {
          try { return a.value.substring(a.selectionStart, a.selectionEnd).trim().length; } catch (e) { /* ignora */ }
        }
        return 0;
      },
    });
    let best = null;
    for (const r of res) {
      const n = r.result || 0;
      if (n > 0 && (!best || n > best.length)) best = { frameId: r.frameId, length: n };
    }
    return best;
  } catch {
    return null;
  }
}

async function explainFailure(tabId, e) {
  let url = "";
  try { url = (await chrome.tabs.get(tabId)).url || ""; } catch { /* ignora */ }
  if (url.startsWith("file://")) {
    return "Para ler arquivos locais, ative “Permitir acesso a URLs de arquivo” para o Laut em chrome://extensions.";
  }
  if (/^chrome(-extension)?:\/\//.test(url) || /chromewebstore\.google\.com|chrome\.google\.com\/webstore/.test(url)) {
    return "O Chrome não deixa extensões lerem esta página.";
  }
  if (/\.pdf($|[?#])/i.test(url)) {
    return "No leitor de PDF do Chrome, só funciona o botão direito com o texto selecionado.";
  }
  return "Não consegui acessar o texto desta página." + (e && e.message ? ` (${e.message})` : "");
}

async function readFromTab(tabId, mode = "auto", translateTo = "", fallbackText = "", startFraction = 0) {
  finish();

  let frameId = 0;
  if (mode !== "page") {
    const found = await findSelectionFrame(tabId);
    if (found) frameId = found.frameId;
  }
  const target = { tabId, frameIds: [frameId] };
  const { contrast } = await chrome.storage.local.get({ contrast: false });

  let data = null;
  try {
    await chrome.scripting.executeScript({ target, files: ["content.js"] });
    const [r] = await chrome.scripting.executeScript({
      target,
      func: (m, o) => window.__laut.prepare(m, o),
      args: [mode, { translateTo, text: fallbackText, progress: !!contrast }],
    });
    data = r && r.result;
  } catch (e) {
    // Sem acesso à página (PDF, arquivo local…): se o Chrome entregou o texto, lê assim mesmo
    const chunks = fallbackText ? plainChunks(fallbackText) : [];
    if (mode !== "page" && chunks.length) {
      await beginSession({ tabId, noPage: true, chunks });
      return { ok: true, source: "selection", total: chunks.length, translating: false, plain: true };
    }
    return { ok: false, error: await explainFailure(tabId, e) };
  }

  if (!data || !data.chunks || !data.chunks.length) {
    return {
      ok: false,
      error: mode === "selection"
        ? "Selecione um texto na página primeiro."
        : "Não encontrei texto para ler nesta página.",
    };
  }
  if (data.translationError) {
    return { ok: false, error: ERRORS[data.translationError] || ERRORS.failed };
  }

  const translating = !!(data.translation && data.translation.target);
  await beginSession({
    tabId, frameId, chunks: data.chunks, lang: data.lang, dark: !!data.dark,
    translating, target: translating ? data.translation.target : null,
    mode, translateTo, source: data.source,
    startIdx: Math.min(data.chunks.length - 1, Math.floor(startFraction * data.chunks.length)),
  });
  return {
    ok: true,
    source: data.source,
    total: data.chunks.length,
    translating,
    sameLanguage: !!(data.translation && data.translation.same),
  };
}

// ---------- Mensagens do popup ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "read-tab": {
        const res = await readFromTab(msg.tabId, msg.mode, msg.translateTo || "");
        if (res.ok) clearError(msg.tabId);
        sendResponse(res);
        break;
      }
      case "pause":  pause();  sendResponse(status()); break;
      case "resume": resume(); sendResponse(status()); break;
      case "stop":   finish(); sendResponse(status()); break;
      case "skip":   skip(msg.dir); sendResponse(status()); break;
      case "status": sendResponse(status()); break;
      case "page-changed": {
        // O tradutor do Chrome mexeu na página: relê no novo idioma, do mesmo ponto
        const s = session;
        if (s && sender.tab && sender.tab.id === s.tabId && s.source === "page") {
          const frac = s.chunks.length ? s.idx / s.chunks.length : 0;
          const { tabId, mode, translateTo } = s;
          finish();
          setTimeout(() => readFromTab(tabId, mode, translateTo, "", frac), 800);
        }
        sendResponse({});
        break;
      }
      default:       sendResponse({});
    }
  })();
  return true;
});

// Velocidade e voz mudam na hora: a frase atual recomeça com o novo ajuste
chrome.storage.onChanged.addListener((changes) => {
  if (!session) return;
  let changed = false;
  if (changes.rate) {
    const next = Number(changes.rate.newValue) || 1;
    session.cps *= next / (Number(session.rate) || 1);
    session.rate = next;
    changed = true;
  }
  if (changes.contrast) {
    applyTheme(session);
    tellPage(session, { type: "laut-mode", progress: !!changes.contrast.newValue });
  }
  if (changes.voiceByLang) { session.voiceByLang = changes.voiceByLang.newValue || {}; changed = true; }
  if (changed && !session.paused) playFrom(session.idx);
});

// Encerra se a aba fechar ou navegar para outra página
chrome.tabs.onRemoved.addListener((tabId) => {
  if (session && session.tabId === tabId) finish();
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (session && session.tabId === tabId && info.status === "loading") finish();
});

// ---------- Botão direito e atalhos ----------
async function savedTranslateTo() {
  const { translateTo = "" } = await chrome.storage.local.get({ translateTo: "" });
  return translateTo;
}

async function trigger(tab, mode, text = "") {
  const to = await savedTranslateTo();
  const res = await readFromTab(tab.id, mode, to, text);
  if (res.ok) clearError(tab.id);
  else reportError(tab.id, res.error);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "ler-selecao", title: "Ler seleção em voz alta", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "ler-pagina", title: "Ler página inteira em voz alta", contexts: ["page"] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  // info.selectionText é entregue pelo Chrome e funciona até em iframes e PDFs
  if (info.menuItemId === "ler-selecao") trigger(tab, "selection", info.selectionText || "");
  if (info.menuItemId === "ler-pagina") trigger(tab, "page");
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "parar-leitura") return finish();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (command === "ler-selecao") trigger(tab, "auto");
  if (command === "ler-pagina") trigger(tab, "page");
});
