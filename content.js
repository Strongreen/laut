// Laut — content script (injetado sob demanda pelo background)
// Extrai o texto da página, divide em frases e destaca a frase que está sendo lida.
(() => {
  const V = "2.4.0";
  if (window.__laut && window.__laut.v === V) return; // já injetado: não perde o estado da leitura
  const HL = "laut";        // frase atual
  const HLW = "laut-word";  // palavra atual
  const HLR = "laut-read";    // texto já lido (alto contraste)
  const HLU = "laut-unread";  // texto que falta ler (alto contraste)
  const PROGRESS_WINDOW = 30000; // quantos caracteres colorir para cada lado (páginas muito longas)
  const MAX = 160;          // tamanho máximo de uma frase/trecho
  const MAX_CHARS = 400000; // limite de texto por leitura
  let state = null;

  const BASE_SKIP = "script,style,noscript,template,textarea,select,svg,canvas,iframe,button,[hidden]";
  const SEL_SKIP = "script,style,noscript,template,svg,canvas";

  const visCache = new WeakMap();
  const blockCache = new WeakMap();

  function visible(el) {
    if (visCache.has(el)) return visCache.get(el);
    const v =
      typeof el.checkVisibility === "function"
        ? el.checkVisibility({ checkVisibilityCSS: true })
        : !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    visCache.set(el, v);
    return v;
  }

  // Bloco (parágrafo, título, item de lista…) que contém o elemento
  function blockOf(el) {
    if (blockCache.has(el)) return blockCache.get(el);
    let e = el;
    let found = document.body;
    while (e && e !== document.documentElement) {
      const d = getComputedStyle(e).display;
      if (!d.startsWith("inline") && d !== "contents") { found = e; break; }
      e = e.parentElement;
    }
    blockCache.set(el, found);
    return found;
  }

  // A página é escura? (olha o fundo do texto que será lido)
  function pageIsDark(el) {
    const lum = (css) => {
      const m = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
      if (!m || (m[4] !== undefined && parseFloat(m[4]) < 0.5)) return null;
      const [r, g, b] = [m[1], m[2], m[3]].map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (let e = el || document.body; e; e = e.parentElement) {
      const l = lum(getComputedStyle(e).backgroundColor);
      if (l !== null) return l < 0.35;
    }
    return false;
  }

  function pickRoot() {
    let best = null;
    let bestLen = 0;
    document.querySelectorAll("article, main, [role='main']").forEach((el) => {
      const len = (el.textContent || "").length;
      if (len > bestLen) { best = el; bestLen = len; }
    });
    return best && bestLen > 400 ? best : document.body;
  }

  function selectionRange() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    return r.toString().trim() ? r.cloneRange() : null;
  }

  function collect(root, selRange, skipSel) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (selRange && !selRange.intersectsNode(n)) return NodeFilter.FILTER_REJECT;
        if (skipSel && p.closest(skipSel)) return NodeFilter.FILTER_REJECT;
        if (!visible(p)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      let from = 0;
      let to = n.nodeValue.length;
      if (selRange) {
        if (n === selRange.startContainer) from = selRange.startOffset;
        if (n === selRange.endContainer) to = selRange.endOffset;
      }
      if (to > from) nodes.push({ node: n, from, to });
    }
    return nodes;
  }

  // Divide o texto em frases (posições [início, fim)), juntando frases muito curtas.
  function chunkPositions(s) {
    const out = [];
    const push = (a, b) => {
      while (a < b && s[a] === " ") a++;
      while (b > a && s[b - 1] === " ") b--;
      if (b > a) out.push([a, b]);
    };

    const re = /[^.!?…]+[.!?…]*\s*/g;
    let m;
    let a = null;
    let b = null;

    while ((m = re.exec(s))) {
      const x = m.index;
      const y = x + m[0].length;

      if (y - x > MAX) {
        if (a !== null) { push(a, b); a = b = null; }
        let p = x;
        while (y - p > MAX) {
          let cut = s.lastIndexOf(",", p + MAX);
          if (cut < p + 40) cut = s.lastIndexOf(" ", p + MAX);
          if (cut < p + 40) cut = p + MAX;
          push(p, cut + 1);
          p = cut + 1;
        }
        a = p;
        b = y;
      } else if (a !== null && b - a < 40 && y - a <= MAX) {
        b = y; // junta frase curtinha com a próxima
      } else {
        if (a !== null) push(a, b);
        a = x;
        b = y;
      }
    }
    if (a !== null) push(a, b);
    return out;
  }

  // ---------- Tradução (Translator API do Chrome, roda no computador) ----------
  let tr = null;

  function resetTranslation() {
    if (tr && tr.translator && typeof tr.translator.destroy === "function") {
      try { tr.translator.destroy(); } catch { /* ignora */ }
    }
    tr = null;
  }

  // ---------- Idioma do texto (não confia só no atributo lang da página) ----------
  // Páginas traduzidas pelo tradutor do Chrome podem manter o lang original, ou nem ter lang.
  const STOP = {
    pt: "que não uma para com os as do da dos das mais foi são ao como mas ele ela seu sua também muito está quando pelo pela nos isso esse essa até entre sem em um por se o".split(" "),
    en: "the and of to in is that it for was on with as are by this from at be or have not an they which you were their has can will one all each only then".split(" "),
    es: "que el los las del por una para con su al es lo como más pero sus ya este porque esta entre cuando muy sin sobre también y".split(" "),
    fr: "le la les des du une que est pour qui dans par plus pas au sur ne se ce il sont avec son ses mais comme ou été et".split(" "),
    de: "der die und den von zu das mit sich des auf für ist im dem nicht ein eine als auch es an werden aus er hat dass sie nach wird bei einer um am sind noch wie einem".split(" "),
    it: "che il un per non con le si da dei del della sono come più ma anche gli lo al nel alla questo ha ci è e".split(" "),
    nl: "de het een van en is dat op te zijn met voor niet aan er om ook als dan maar bij door uit naar dit nog wordt".split(" "),
  };
  const STOPSETS = Object.fromEntries(Object.entries(STOP).map(([k, v]) => [k, new Set(v)]));

  function guessLanguage(text) {
    const none = { lang: "", confident: false };
    const n = (text.match(/\p{L}/gu) || []).length;
    if (n < 40) return none;
    const share = (re) => (text.match(re) || []).length / n;

    if (share(/[\u3040-\u30ff]/g) > 0.1) return { lang: "ja", confident: true };
    if (share(/[\uac00-\ud7af]/g) > 0.3) return { lang: "ko", confident: true };
    if (share(/[\u4e00-\u9fff]/g) > 0.3) return { lang: "zh", confident: true };
    if (share(/[\u0400-\u04ff]/g) > 0.4) return { lang: "ru", confident: true };
    if (share(/[\u0600-\u06ff]/g) > 0.4) return { lang: "ar", confident: true };
    if (share(/[\u0900-\u097f]/g) > 0.4) return { lang: "hi", confident: true };
    if (share(/[\u0590-\u05ff]/g) > 0.4) return { lang: "he", confident: true };
    if (share(/[\u0370-\u03ff]/g) > 0.4) return { lang: "el", confident: true };

    const words = text.toLowerCase().match(/\p{L}+/gu) || [];
    if (words.length < 12) return none;
    const scores = Object.entries(STOPSETS)
      .map(([lang, set]) => [lang, words.reduce((a, w) => a + (set.has(w) ? 1 : 0), 0) / words.length])
      .sort((a, b) => b[1] - a[1]);
    const [best, second] = scores;
    const confident = best[1] >= 0.12 && best[1] >= second[1] * 1.4;
    return confident ? { lang: best[0], confident: true } : none;
  }

  // Usa o detector do Chrome quando já está baixado; senão, a estimativa local acima
  async function detectLanguage(sample) {
    const text = (sample || "").slice(0, 1500);
    try {
      if ("LanguageDetector" in self && (await LanguageDetector.availability()) === "available") {
        const det = await LanguageDetector.create();
        const res = await det.detect(text);
        const top = res && res[0];
        if (top && top.confidence > 0.6 && top.detectedLanguage !== "und") {
          return { lang: top.detectedLanguage.split("-")[0].toLowerCase(), confident: true };
        }
      }
    } catch { /* cai na estimativa local */ }
    return guessLanguage(text);
  }

  const primary = (l) => (l || "").split("-")[0].toLowerCase();

  // Mantém a variante regional (pt-BR) quando o idioma é o da página ou o do navegador
  function regional(source, attr) {
    if (primary(attr) === source) return attr;
    if (primary(navigator.language) === source) return navigator.language;
    return source;
  }

  function isBrowserTranslated() {
    const c = document.documentElement.classList;
    return c.contains("translated-ltr") || c.contains("translated-rtl");
  }

  // O tradutor do Chrome marca a página e só depois troca os textos: espera a página sossegar
  function settle(quiet = 700, cap = 5000) {
    return new Promise((resolve) => {
      let timer = setTimeout(done, quiet);
      const capTimer = setTimeout(done, cap);
      const mo = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, quiet); });
      mo.observe(document.documentElement, {
        subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ["class", "lang"],
      });
      function done() { mo.disconnect(); clearTimeout(timer); clearTimeout(capTimer); resolve(); }
    });
  }

  // Avisa o background se a página for traduzida (ou voltar ao original) durante a leitura
  let watcher = null;
  const pageSignature = () => (isBrowserTranslated() ? "T" : "O") + "|" + (document.documentElement.lang || "");
  function watchPage() {
    stopWatching();
    let last = pageSignature();
    watcher = new MutationObserver(() => {
      const now = pageSignature();
      if (now === last) return;
      last = now;
      try { chrome.runtime.sendMessage({ type: "page-changed" }); } catch { /* ignora */ }
    });
    watcher.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "lang"] });
  }
  function stopWatching() {
    if (watcher) { watcher.disconnect(); watcher = null; }
  }

  // Idioma da página, para o popup (antes de ler)
  async function pageLanguage() {
    const root = pickRoot();
    const sample = (root.innerText || "").replace(/\s+/g, " ").trim().slice(0, 1500);
    const det = await detectLanguage(sample);
    const translated = isBrowserTranslated();
    let lang = det.confident ? det.lang : primary(document.documentElement.lang);
    if (!lang && translated) lang = primary(navigator.language);
    return { lang, translated };
  }

  async function setupTranslation(target, source, chunks) {
    if (!("Translator" in self)) return { error: "no-api" };
    if (!source) return { error: "no-source" };
    if (source === target.split("-")[0].toLowerCase()) return { same: true };
    try {
      const pair = { sourceLanguage: source, targetLanguage: target };
      const avail = await Translator.availability(pair);
      if (avail === "unavailable") return { error: "unavailable" };
      // create() com download precisa de clique do usuário; o popup cuida disso
      if (avail !== "available") return { error: "needs-download" };
      const translator = await Translator.create(pair);
      tr = { translator, chunks, cache: new Map(), inflight: new Map() };
      return { source };
    } catch {
      return { error: "failed" };
    }
  }

  function translateChunk(i) {
    if (!tr || i < 0 || i >= tr.chunks.length) return Promise.resolve(null);
    if (tr.cache.has(i)) return Promise.resolve(tr.cache.get(i));
    if (!tr.inflight.has(i)) {
      const t = tr;
      const p = t.translator.translate(t.chunks[i])
        .then((r) => { t.cache.set(i, r); t.inflight.delete(i); return r; })
        .catch(() => { t.inflight.delete(i); return null; });
      t.inflight.set(i, p);
    }
    return tr.inflight.get(i);
  }

  // Devolve a frase i traduzida e já adianta as duas seguintes
  async function translated(i) {
    const r = await translateChunk(i);
    translateChunk(i + 1);
    translateChunk(i + 2);
    return r;
  }

  // Texto selecionado que não dá para mapear no DOM (campo de texto, por exemplo)
  function rawSelection() {
    const sel = window.getSelection ? window.getSelection().toString() : "";
    if (sel.trim()) return sel;
    const a = document.activeElement;
    if (a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT") &&
        typeof a.selectionStart === "number" && a.selectionStart !== a.selectionEnd) {
      try { return a.value.substring(a.selectionStart, a.selectionEnd); } catch { /* ignora */ }
    }
    return "";
  }

  async function prepare(mode, opts = {}) {
    clear();
    resetTranslation();
    progressOn = !!opts.progress;
    if (isBrowserTranslated()) await settle();
    const htmlLang = document.documentElement.lang || "";
    let nodes = [];
    let source = "page";

    const range = mode === "page" ? null : selectionRange();
    const raw = mode === "page" || range ? "" : (rawSelection() || opts.text || "");

    if (range) {
      let root = range.commonAncestorContainer;
      if (root.nodeType !== 1) root = root.parentNode;
      nodes = collect(root, range, SEL_SKIP);
      source = "selection";
    } else if (raw.trim()) {
      source = "selection";
    } else if (mode !== "selection") {
      const root = pickRoot();
      const skip = root === document.body
        ? BASE_SKIP + ",nav,header,footer,aside,form"
        : BASE_SKIP + ",nav,aside";
      nodes = collect(root, null, skip);
    }

    let s = "";
    let pos = [];
    state = null;

    if (nodes.length) {
      // Texto normalizado + mapa de cada caractere para (nó, posição) no DOM
      const out = [];
      const mapNode = [];
      const mapOff = [];
      let prevCh = "";
      let prevNon = "";
      let prevBlock = null;

      for (let ni = 0; ni < nodes.length; ni++) {
        const { node, from, to } = nodes[ni];
        const blk = blockOf(node.parentElement);
        const afterBr = node.previousSibling && node.previousSibling.nodeName === "BR";

        if (out.length && (blk !== prevBlock || afterBr)) {
          const ln = mapNode[out.length - 1];
          const lo = mapOff[out.length - 1];
          if (prevNon && !/[.!?…:;,]/.test(prevNon)) {
            out.push("."); mapNode.push(ln); mapOff.push(lo);
            prevCh = "."; prevNon = ".";
          }
          if (prevCh !== " ") {
            out.push(" "); mapNode.push(ln); mapOff.push(lo);
            prevCh = " ";
          }
        }
        prevBlock = blk;

        const data = node.nodeValue;
        for (let i = from; i < to; i++) {
          let ch = data[i];
          if (ch === "\u200b" || ch === "\u00ad") continue;
          if (/\s/.test(ch)) ch = " ";
          if (ch === " " && (prevCh === " " || prevCh === "")) continue;
          out.push(ch); mapNode.push(ni); mapOff.push(i);
          prevCh = ch;
          if (ch !== " ") prevNon = ch;
        }
        if (out.length > MAX_CHARS) break;
      }

      s = out.join("").trimEnd();
      pos = chunkPositions(s);
      state = { nodes, mapNode, mapOff, pos, text: s };
    }

    // Seleção sem como mapear no DOM: lê o texto puro (sem destaque na página)
    if (!s && source === "selection") {
      const text = (raw || rawSelection() || opts.text || "").replace(/\s+/g, " ").trim();
      if (text) { s = text; pos = chunkPositions(s); }
    }

    const chunks = pos.map(([a, b]) => s.slice(a, b));

    // Idioma do texto: o que o texto diz manda; depois o atributo lang; depois o do navegador
    const translatedByBrowser = isBrowserTranslated();
    const det = chunks.length ? await detectLanguage(s) : { lang: "", confident: false };
    let srcLang = det.confident ? det.lang : primary(htmlLang);
    if (!srcLang && translatedByBrowser) srcLang = primary(navigator.language);
    const lang = srcLang ? regional(srcLang, htmlLang) : (htmlLang || navigator.language || "pt-BR");
    const mid = nodes.length ? nodes[Math.floor(nodes.length / 2)].node.parentElement : document.body;
    const result = { chunks, lang, source, translatedByBrowser, dark: pageIsDark(mid) };

    if (chunks.length) watchPage();

    if (opts.translateTo && chunks.length) {
      const t = await setupTranslation(opts.translateTo, srcLang, chunks);
      if (t.error) result.translationError = t.error;
      else if (t.same) result.translation = { same: true };
      else result.translation = { source: t.source, target: opts.translateTo };
    }
    return result;
  }

  // Trecho [x, y) do texto normalizado -> Range no DOM
  function rangeForChars(x, y) {
    if (!state || x < 0 || y <= x) return null;
    const sn = state.nodes[state.mapNode[x]];
    const en = state.nodes[state.mapNode[y - 1]];
    if (!sn || !en || !sn.node.isConnected || !en.node.isConnected) return null;
    try {
      const r = new Range();
      r.setStart(sn.node, state.mapOff[x]);
      r.setEnd(en.node, state.mapOff[y - 1] + 1);
      return r;
    } catch {
      return null;
    }
  }

  function rangeFor(i) {
    if (!state || !state.pos[i]) return null;
    return rangeForChars(state.pos[i][0], state.pos[i][1]);
  }

  function scrollerOf(el) {
    for (let e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      const o = getComputedStyle(e).overflowY;
      if ((o === "auto" || o === "scroll") && e.scrollHeight > e.clientHeight + 4) return e;
    }
    return null;
  }

  // Rola suavemente quando o trecho sai da área visível
  function reveal(r) {
    const rect = r.getClientRects()[0] || r.getBoundingClientRect();
    const el = r.startContainer.parentElement;
    if (!el) return;
    const sc = scrollerOf(el);
    const view = sc ? sc.getBoundingClientRect() : { top: 0, bottom: innerHeight, height: innerHeight };
    if (rect.top < view.top + 70 || rect.bottom > view.bottom - 70) {
      (sc || window).scrollBy({ top: rect.top - view.top - view.height * 0.3, behavior: "smooth" });
    }
  }

  // ---------- Cores do texto: já lido / falta ler (alto contraste) ----------
  let progressOn = false;
  const cur = { i: null, word: null };   // frase e palavra atuais

  function paintProgress() {
    const del = (n) => { try { if (window.CSS && CSS.highlights) CSS.highlights.delete(n); } catch { /* ignora */ } };
    if (!progressOn || !state || cur.i === null || !state.pos[cur.i]) { del(HLR); del(HLU); return; }
    const total = state.text.length;
    const readEnd = cur.word ? cur.word[0] : state.pos[cur.i][0];
    const unreadStart = cur.word ? cur.word[1] : readEnd;
    const before = rangeForChars(Math.max(0, readEnd - PROGRESS_WINDOW), readEnd);
    const after = rangeForChars(unreadStart, Math.min(total, unreadStart + PROGRESS_WINDOW));
    if (before) setHighlight(HLR, before, 0); else del(HLR);
    if (after) setHighlight(HLU, after, 0); else del(HLU);
  }

  function setHighlight(name, range, priority) {
    try {
      if (!window.CSS || !CSS.highlights) return;
      const h = new Highlight(range);
      h.priority = priority;
      CSS.highlights.set(name, h);
    } catch { /* navegador sem suporte ao destaque */ }
  }

  function highlight(i) {
    clearWord();
    cur.i = i;
    const r = rangeFor(i);
    if (!r) return;
    setHighlight(HL, r, 1);
    paintProgress();
    reveal(r);
  }

  // ---------- Destaque da palavra ----------
  let wordTimer = null;

  function stopWordTrack() {
    if (wordTimer) { clearTimeout(wordTimer); wordTimer = null; }
  }
  function clearWord() {
    cur.word = null;
    stopWordTrack();
    try { if (window.CSS && CSS.highlights) CSS.highlights.delete(HLW); } catch { /* ignora */ }
  }

  function setWord(x, y) {
    const r = rangeForChars(x, y);
    if (!r) return;
    cur.word = [x, y];
    setHighlight(HLW, r, 2);
    paintProgress();
    reveal(r);
  }

  const isWordChar = (c) => /[\p{L}\p{N}'’-]/u.test(c);

  // A voz avisou qual palavra vai falar (charIndex = posição no texto da frase)
  function wordAt(i, charIndex, length) {
    stopWordTrack();
    if (!state || tr || !state.pos[i]) return;   // com tradução, as palavras não coincidem
    const [a, b] = state.pos[i];
    const x = a + charIndex;
    if (!(charIndex >= 0) || x >= b) return;
    let y = length > 0 ? x + length : x;
    if (!(length > 0)) while (y < b && isWordChar(state.text[y])) y++;
    setWord(x, Math.min(Math.max(y, x + 1), b));
  }

  // Voz sem eventos de palavra: estima o ritmo pela velocidade medida nas frases anteriores
  function startWordTrack(i, cps) {
    stopWordTrack();
    if (!state || tr || !state.pos[i]) return;
    const [a, b] = state.pos[i];
    const text = state.text.slice(a, b);
    const re = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
    const words = [];
    let m;
    let t = 0;      // "tempo" em caracteres de fala
    let prevEnd = 0;
    while ((m = re.exec(text))) {
      const gap = text.slice(prevEnd, m.index);
      if (words.length) t += /[.!?…]/.test(gap) ? 8 : /[,;:]/.test(gap) ? 4 : 0;
      words.push({ from: m.index, to: m.index + m[0].length, at: t });
      t += m[0].length + 1;
      prevEnd = m.index + m[0].length;
    }
    if (!words.length) return;
    const speed = Math.max(Number(cps) || 15, 3);
    let k = 0;
    const step = () => {
      const w = words[k];
      setWord(a + w.from, a + w.to);
      k++;
      if (k < words.length) wordTimer = setTimeout(step, ((words[k].at - w.at) / speed) * 1000);
    };
    step();
  }

  // O background avisa quando cada frase começa e quando a voz chega numa palavra
  try {
    chrome.runtime.onMessage.addListener((m) => {
      if (!m || typeof m.type !== "string" || !m.type.startsWith("laut-")) return;
      if (m.type === "laut-start") { if (m.estimate === false) stopWordTrack(); else startWordTrack(m.i, m.cps); }
      else if (m.type === "laut-word") wordAt(m.i, m.charIndex, m.length);
      else if (m.type === "laut-stop-word") stopWordTrack();
      else if (m.type === "laut-mode") { progressOn = !!m.progress; paintProgress(); }
    });
  } catch { /* sem canal de mensagens */ }

  function clear() {
    stopWatching();
    clearWord();
    cur.i = null;
    try {
      if (window.CSS && CSS.highlights) { CSS.highlights.delete(HL); CSS.highlights.delete(HLR); CSS.highlights.delete(HLU); }
    } catch { /* ignora */ }
  }

  window.__laut = { v: V, prepare, highlight, clear, translated, pageLanguage, _guess: guessLanguage, _chunk: chunkPositions };
})();
