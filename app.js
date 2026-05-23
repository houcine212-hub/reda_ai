/* ============================================================
   REDA AI — app.js
   Memory + Gemini 2.5 Flash + Chat UI
   ============================================================ */

'use strict';

/* ============================================================
   CONFIG
   ============================================================ */
const CONFIG = {
  // --- Gemini (primary) ---
  API_KEY:     'AIzaSyBh_dZxCRdYYFSiM9CQRah0xA1Aw41GVt4',
  MODEL:       'gemini-2.0-flash',

  // --- Groq / Llama (fallback automatique si Gemini quota dépassé) ---
  GROQ_API_KEY: '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',
  GROQ_MODELS: [
    'llama-3.3-70b-versatile',
    'llama3-8b-8192',
    'gemma2-9b-it',
  ],

  STORAGE_KEY: 'reda_ai_v2',
  MAX_CTX:     40,
};

/* ============================================================
   MEMORY  — localStorage-based memory with learned facts
   ============================================================ */
const Memory = {

  _data: null,

  _default() {
    return { messages: [], facts: {}, created: Date.now() };
  },

  load() {
    try {
      const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
      this._data = raw ? JSON.parse(raw) : this._default();
    } catch {
      this._data = this._default();
    }
    return this._data;
  },

  _save() {
    try {
      localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(this._data));
    } catch (e) {
      console.warn('Memory save failed', e);
    }
  },

  get() {
    if (!this._data) this.load();
    return this._data;
  },

  /* Add a message to history */
  addMessage(role, content) {
    const d = this.get();
    d.messages.push({ role, content, ts: Date.now() });
    // keep last 80 messages on disk
    if (d.messages.length > 80) d.messages = d.messages.slice(-80);
    this._save();
  },

  /* Build Gemini-format contents array from history */
  getContext() {
    const msgs = this.get().messages.slice(-CONFIG.MAX_CTX);
    return msgs.map(m => ({
      role: m.role === 'bot' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
  },

  /* All messages (for UI rendering) */
  getAll() {
    return this.get().messages;
  },

  /* Store a learned fact */
  learnFact(key, value) {
    if (!key || !value) return;
    this.get().facts[key.trim().toLowerCase()] = value.trim();
    this._save();
    UI.updateMemoryBadge();
  },

  /* Get all facts */
  getFacts() {
    return this.get().facts;
  },

  /* Delete one fact */
  deleteFact(key) {
    const d = this.get();
    delete d.facts[key];
    this._save();
    UI.updateMemoryBadge();
  },

  /* Clear everything */
  clearAll() {
    this._data = this._default();
    this._save();
  },

  /* Clear only facts */
  clearFacts() {
    this.get().facts = {};
    this._save();
    UI.updateMemoryBadge();
  },
};

/* ============================================================
   IMAGE SEARCH — fetch reference photos from Google via proxy
   ============================================================ */
const ImageSearch = {

  // Extract <<IMG:query>> tags from text, return {cleanText, queries}
  extractTags(text) {
    const queries = [];
    const cleanText = text.replace(/<<IMG:([^>]+)>>/g, (_, q) => {
      queries.push(q.trim());
      return '';
    }).trim();
    return { cleanText, queries };
  },

  async fetchImages(queries) {
    const results = [];
    for (const q of queries.slice(0, 3)) {
      try {
        const url = await this._findImage(q);
        if (url) results.push({ query: q, url });
      } catch (e) {
        console.warn('Image search failed:', q, e);
      }
    }
    return results;
  },

  async _findImage(query) {
    // 1. Try Wikipedia page images (English)
    const wpUrl = `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&prop=pageimages&piprop=thumbnail&pithumbsize=600&format=json&origin=*&gsrnamespace=0&gsrlimit=5`;
    try {
      const res = await fetch(wpUrl);
      if (res.ok) {
        const data = await res.json();
        const pages = Object.values(data?.query?.pages || {}).sort((a,b)=>(a.index||99)-(b.index||99));
        for (const page of pages) {
          const src = page?.thumbnail?.source;
          if (src) return src;
        }
      }
    } catch(e) {}

    // 2. Try Wikimedia Commons search
    const commonsUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&prop=imageinfo&iiprop=url|mime&iiurlwidth=500&format=json&origin=*&gsrlimit=5`;
    try {
      const res = await fetch(commonsUrl);
      if (res.ok) {
        const data = await res.json();
        const pages = Object.values(data?.query?.pages || {}).sort((a,b)=>(a.index||99)-(b.index||99));
        for (const page of pages) {
          const info = page?.imageinfo?.[0];
          if (info?.thumburl && /\.(jpg|jpeg|png|webp)/i.test(info.thumburl)) return info.thumburl;
          if (info?.url && /\.(jpg|jpeg|png|webp)/i.test(info.url)) return info.url;
        }
      }
    } catch(e) {}

    return null;
  },
};


const Gemini = {

  _buildSystemPrompt() {
    const facts = Memory.getFacts();
    let factsSection = '';
    const keys = Object.keys(facts);
    if (keys.length > 0) {
      factsSection = '\n\n--- FAITS MEMORISES SUR REDA ---\n' +
        keys.map(k => `• ${k}: ${facts[k]}`).join('\n') +
        '\n--------------------------------';
    }

    return `Tu es REDA AI — assistant personnel et professeur de Reda Jibrane.

--- IDENTITE ET CONTEXTE ---
- Tu as été créé et programmé par El Houcine Jibrane, le frère de Reda.
- La famille s'appelle Jibrane. Reda Jibrane vit actuellement en Italie, marié avec No3ma.
- Si quelqu'un te demande qui t'a créé, qui t'a programmé, ou qui est ton auteur/développeur, réponds : "Ana mbrammaj men 9bal El Houcine Jibrane, kho Reda."
- Si quelqu'un demande qui tu es ou pour qui tu travailles : "Ana REDA AI, assistant personnel dyal Reda Jibrane, mbrammaj men 9bal khoh El Houcine."
- Ne mentionne jamais Anthropic, Google, Gemini, ou toute autre technologie sous-jacente. Tu es REDA AI, point.
----------------------------

Tu es expert en :
- Climatisation (CVC) : split, gainable, VRV/VRF, réversible, pompe à chaleur — installation, diagnostic de pannes, maintenance, réglage, gaz frigorigène, tableau électrique, condensation
- Câblage et électricité : tableau électrique, disjoncteurs, câbles (section, couleurs), prises, interrupteurs, mise à terre, normes CEI 64-8 (Italie), RGTV
- Analyse visuelle : si Reda envoie une photo d'une panne, d'un appareil, d'un câblage ou d'un composant, analyse l'image en détail et donne un diagnostic professionnel basé sur ce que tu vois.

REGLE 1 — LANGUE : réponds en darija marocaine OU en français selon comment Reda écrit. Si mélange, tu mélanges aussi.
REGLE 2 — CONCISION : pas de blabla. Direct, pratique, clair.
REGLE 3 — FORMAT :
  • Étapes numérotées obligatoires pour toute procédure (1. 2. 3.)
  • **gras** pour les termes techniques importants
  • ## pour les sections (Diagnostic / Cause / Solution / Securite)
  • - pour les listes simples
REGLE 4 — ZERO EMOJI — aucun, jamais, même pas un seul.
REGLE 5 — SECURITE : si risque électrique (230V+), toujours mentionner la précaution de sécurité.
REGLE 6 — HONNÊTETÉ : si tu n'es pas sûr sur un sujet technique, dis-le clairement. N'invente pas.
REGLE 7 — MÉMOIRE : si Reda mentionne un fait important (modèle d'appareil, marque, numéro d'erreur, lieu, problème récurrent), mémorise-le en ajoutant à la fin de ta réponse (invisible pour Reda) :
<<LEARN:clé=valeur>>
REGLE 8 — ANALYSE IMAGE : Quand une image est fournie, commence toujours par décrire ce que tu vois clairement (type d'appareil, composants visibles, anomalies détectées) avant de donner le diagnostic.
REGLE 9 — IDENTITE : Si on te demande qui t'a fait/programmé/créé, réponds toujours que c'est El Houcine Jibrane. Jamais d'autre réponse.
REGLE 10 — IMAGES DE REFERENCE : A chaque fois que tu donnes un diagnostic ou une explication technique, ajoute 1 à 3 tags d'image A LA FIN de ta réponse pour illustrer visuellement. Format exact (TOUJOURS en anglais technique pour la recherche) :
<<IMG:start capacitor air conditioner>>
<<IMG:electrical panel circuit breaker>>
<<IMG:split system air conditioner outdoor unit>>
Règles pour les tags :
- TOUJOURS en anglais
- Termes techniques précis (nom du composant exact)
- 2 à 5 mots max par tag
- 1 tag minimum, 3 maximum
- Ces tags sont invisibles pour Reda — l'app les convertit en vraies photos Wikipedia automatiquement

Exemple de réponse bien formatée :
## Diagnostic
Le compresseur ne démarre pas.
## Cause probable
Le **condensateur de démarrage** est défaillant.
## Solution
1. Coupe le **disjoncteur** principal
2. Ouvre le capot du groupe extérieur
3. Localise le condensateur (cylindre métallique)
4. Mesure la capacité avec un multimètre
5. Remplace si valeur inférieure à ±10% de la valeur nominale
## Securite
Decharge le condensateur avant de le toucher — il peut conserver une charge même hors tension.
${factsSection}`;
  },

  _geminiBlockedUntil: 0,
  _GEMINI_COOLDOWN: 3 * 60 * 1000,

  async send(userText, image = null) {
    const now = Date.now();
    if (now >= this._geminiBlockedUntil) {
      try {
        return await this._sendGemini(userText, image);
      } catch (err) {
        const isQuota = err.message?.includes('429') || err.message?.includes('quota') || err.message?.includes('RESOURCE_EXHAUSTED');
        if (!isQuota) throw err;
        this._geminiBlockedUntil = Date.now() + this._GEMINI_COOLDOWN;
        console.warn('Gemini quota → Groq (bloqué 3 min)...');
      }
    } else {
      const remaining = Math.ceil((this._geminiBlockedUntil - now) / 1000);
      console.warn('Gemini en cooldown (' + remaining + 's) → Groq directement');
    }
    return await this._sendGroq(userText);
  },

  async _sendGemini(userText, image = null) {
    const history = Memory.getContext();
    const userParts = [];
    if (image) {
      userParts.push({ inline_data: { mime_type: image.mimeType, data: image.base64 } });
    }
    userParts.push({
      text: userText || 'Analyse cette image et dis-moi ce que tu vois comme problème (panne, câblage, appareil). Donne un diagnostic professionnel CVC / électrique.'
    });
    history.push({ role: 'user', parts: userParts });

    const body = {
      system_instruction: { parts: [{ text: this._buildSystemPrompt() }] },
      contents: history,
      generationConfig: { temperature: 0.55, maxOutputTokens: 1800, topP: 0.9 },
    };

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.MODEL}:generateContent?key=${CONFIG.API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const candidate = data?.candidates?.[0];
    if (!candidate) throw new Error('Pas de réponse de l\'API');
    if (candidate.finishReason === 'SAFETY') throw new Error('Réponse bloquée (sécurité)');
    return candidate.content?.parts?.[0]?.text || '';
  },

  async _sendGroq(userText) {
    // Convert history to OpenAI-compatible format for Groq
    const history = Memory.getContext();
    const messages = [{ role: 'system', content: this._buildSystemPrompt() }];
    for (const msg of history) {
      const role = msg.role === 'model' ? 'assistant' : 'user';
      const content = msg.parts?.map(p => p.text || '').join('') || '';
      if (content) messages.push({ role, content });
    }
    messages.push({ role: 'user', content: userText || 'Analyse et donne un diagnostic.' });

    // Try each Llama model in order
    for (const model of CONFIG.GROQ_MODELS) {
      try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}`,
          },
          body: JSON.stringify({ model, messages, temperature: 0.55, max_tokens: 1800 }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          console.warn(`Groq ${model} failed:`, err?.error?.message);
          continue; // try next model
        }
        const data = await res.json();
        return data?.choices?.[0]?.message?.content || '';
      } catch (e) {
        console.warn(`Groq ${model} error:`, e);
      }
    }
    throw new Error('Tous les modèles sont indisponibles. Réessaie dans quelques minutes.');
  },
};

/* ============================================================
   MESSAGE RENDERER — markdown-like text to HTML
   ============================================================ */
const Renderer = {

  render(text) {
    // 1. Extract LEARN tags silently
    text = text.replace(/<<LEARN:([^>]+)>>/g, (_, p1) => {
      const eqIdx = p1.indexOf('=');
      if (eqIdx > 0) {
        Memory.learnFact(p1.slice(0, eqIdx), p1.slice(eqIdx + 1));
      }
      return '';
    });

    text = text.trim();
    if (!text) return '';

    const lines = text.split('\n');
    let html = '';
    let i = 0;

    while (i < lines.length) {
      const raw = lines[i];
      const line = raw.trim();

      // Empty line — paragraph break
      if (!line) { i++; continue; }

      // Heading ## or ###
      if (/^#{2,3}\s/.test(line)) {
        const content = line.replace(/^#{2,3}\s+/, '');
        html += `<div class="msg-heading">${this._inline(content)}</div>`;
        i++;
        continue;
      }

      // Heading # (h1 level)
      if (/^#\s/.test(line)) {
        const content = line.replace(/^#\s+/, '');
        html += `<div class="msg-subheading">${this._inline(content)}</div>`;
        i++;
        continue;
      }

      // WARNING / ATTENTION block
      if (/^(SECURITE|ATTENTION|WARNING|DANGER|IMPORTANT)\s*:/i.test(line)) {
        const label = line.split(':')[0].toUpperCase();
        const content = line.slice(line.indexOf(':') + 1).trim();
        let rest = content;
        // Collect continuation lines
        i++;
        while (i < lines.length && lines[i].trim() && !/^#{1,3}\s/.test(lines[i].trim()) && !/^\d+\.\s/.test(lines[i].trim()) && !/^[-*]\s/.test(lines[i].trim())) {
          rest += ' ' + lines[i].trim();
          i++;
        }
        html += `<div class="msg-warning"><span class="msg-warning-label">${label}</span>${this._inline(rest)}</div>`;
        continue;
      }

      // Numbered list block — collect all consecutive numbered lines
      if (/^\d+\.\s/.test(line)) {
        html += '<div class="steps-block">';
        let stepNum = 1;
        while (i < lines.length && /^\d+\.\s/.test(lines[i].trim())) {
          const content = lines[i].trim().replace(/^\d+\.\s+/, '');
          html += `<div class="step-item"><span class="step-num">${stepNum}</span><span class="step-content">${this._inline(content)}</span></div>`;
          stepNum++;
          i++;
        }
        html += '</div>';
        continue;
      }

      // Bullet list block — collect consecutive bullet lines
      if (/^[-*]\s/.test(line)) {
        html += '<ul class="bullet-list">';
        while (i < lines.length && /^[-*]\s/.test(lines[i].trim())) {
          const content = lines[i].trim().replace(/^[-*]\s+/, '');
          html += `<li>${this._inline(content)}</li>`;
          i++;
        }
        html += '</ul>';
        continue;
      }

      // Regular paragraph — collect until blank or special line
      const paraLines = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^#{1,3}\s/.test(lines[i].trim()) &&
        !/^\d+\.\s/.test(lines[i].trim()) &&
        !/^[-*]\s/.test(lines[i].trim()) &&
        !/^(SECURITE|ATTENTION|WARNING|DANGER|IMPORTANT)\s*:/i.test(lines[i].trim())
      ) {
        paraLines.push(this._inline(lines[i].trim()));
        i++;
      }
      if (paraLines.length > 0) {
        html += `<p>${paraLines.join('<br>')}</p>`;
      }
    }

    return html || `<p>${this._inline(text)}</p>`;
  },

  /* Apply inline formatting: bold, italic, inline-code */
  _inline(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // Inline code
      .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
      // Bold
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      // Italic
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  },
};

/* ============================================================
   UI  — DOM manipulation
   ============================================================ */
const UI = {

  els: {},
  isTyping: false,

  init() {
    this.els = {
      messages:    document.getElementById('messages-list'),
      messagesArea:document.getElementById('messages-area'),
      typingWrap:  document.getElementById('typing-wrap'),
      input:       document.getElementById('msg-input'),
      sendBtn:     document.getElementById('send-btn'),
      clearBtn:    document.getElementById('clear-btn'),
      installBtn:  document.getElementById('install-btn'),
      memoryBtn:   document.getElementById('memory-btn'),
      memoryBadge: document.getElementById('memory-badge'),
      memoryPanel: document.getElementById('memory-panel'),
      memoryList:  document.getElementById('memory-list'),
      overlay:     document.getElementById('overlay'),
      closePanelBtn:   document.getElementById('close-panel-btn'),
      clearMemoryBtn:  document.getElementById('clear-memory-btn'),
      welcomeCard:     document.getElementById('welcome-card'),
      iosHint:         document.getElementById('ios-hint'),
      closeIosHint:    document.getElementById('close-ios-hint'),
      imgBtn:          document.getElementById('img-btn'),
      imgInput:        document.getElementById('img-input'),
      imgPreviewWrap:  document.getElementById('img-preview-wrap'),
      imgPreview:      document.getElementById('img-preview'),
      imgRemoveBtn:    document.getElementById('img-remove-btn'),
    };
  },

  /* Add a message row to the DOM */
  appendMessage(role, rawText, animate = true, imageDataUrl = null, refImages = []) {
    // Hide welcome card once we have messages
    if (this.els.welcomeCard) this.els.welcomeCard.style.display = 'none';

    const row = document.createElement('div');
    row.className = `msg-row ${role}`;
    if (!animate) row.style.animation = 'none';

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    if (role === 'user') {
      // Show image thumbnail if present
      if (imageDataUrl) {
        const imgEl = document.createElement('img');
        imgEl.src = imageDataUrl;
        imgEl.className = 'msg-img-thumb';
        bubble.appendChild(imgEl);
      }
      if (rawText && rawText !== '[Photo envoyée]') {
        const p = document.createElement('p');
        p.textContent = rawText;
        bubble.appendChild(p);
      }
    } else {
      // Bot message — rendered HTML
      bubble.innerHTML = Renderer.render(rawText);
      this.updateMemoryBadge();

      // Append reference images strip if any
      if (refImages && refImages.length > 0) {
        const strip = document.createElement('div');
        strip.className = 'ref-img-strip';
        refImages.forEach(({ url, query }) => {
          const wrap = document.createElement('div');
          wrap.className = 'ref-img-wrap';
          const img = document.createElement('img');
          img.src = url;
          img.alt = query;
          img.className = 'ref-img';
          img.loading = 'lazy';
          img.onerror = () => { wrap.style.display = 'none'; };
          const cap = document.createElement('div');
          cap.className = 'ref-img-cap';
          cap.textContent = query;
          wrap.appendChild(img);
          wrap.appendChild(cap);
          strip.appendChild(wrap);
        });
        bubble.appendChild(strip);
      }
    }

    const timeEl = document.createElement('div');
    timeEl.className = 'msg-time';
    timeEl.textContent = this._time();

    row.appendChild(bubble);
    row.appendChild(timeEl);
    this.els.messages.appendChild(row);
    this.scrollBottom();
  },

  /* Re-render all messages from Memory (on init) */
  renderHistory() {
    const msgs = Memory.getAll();
    if (msgs.length === 0) return;

    // Hide welcome card
    if (this.els.welcomeCard) this.els.welcomeCard.style.display = 'none';

    msgs.forEach(m => this.appendMessage(m.role, m.content, false));
  },

  scrollBottom() {
    requestAnimationFrame(() => {
      this.els.messagesArea.scrollTop = this.els.messagesArea.scrollHeight;
    });
  },

  setTyping(on) {
    this.isTyping = on;
    this.els.typingWrap.classList.toggle('hidden', !on);
    if (on) this.scrollBottom();
  },

  setLoading(on) {
    this.els.sendBtn.disabled = on || !this.els.input.value.trim();
    this.els.input.disabled = on;
    this.setTyping(on);
  },

  /* Update memory badge number */
  updateMemoryBadge() {
    const count = Object.keys(Memory.getFacts()).length;
    this.els.memoryBadge.textContent = count;
    this.els.memoryBadge.classList.toggle('hidden', count === 0);
  },

  /* Open/close memory panel */
  openMemoryPanel() {
    this.renderFactsList();
    this.els.memoryPanel.classList.remove('hidden');
    requestAnimationFrame(() => this.els.memoryPanel.classList.add('open'));
    this.els.overlay.classList.remove('hidden');
  },

  closeMemoryPanel() {
    this.els.memoryPanel.classList.remove('open');
    this.els.overlay.classList.add('hidden');
    setTimeout(() => this.els.memoryPanel.classList.add('hidden'), 280);
  },

  /* Render the list of facts in the panel */
  renderFactsList() {
    const facts = Memory.getFacts();
    const keys = Object.keys(facts);
    const list = this.els.memoryList;
    list.innerHTML = '';

    if (keys.length === 0) {
      list.innerHTML = '<p class="panel-empty">Aucun fait memorise pour l\'instant.<br>Parle a Reda AI — il apprend automatiquement.</p>';
      return;
    }

    keys.forEach(key => {
      const item = document.createElement('div');
      item.className = 'fact-item';
      item.innerHTML = `
        <div>
          <div class="fact-key">${this._escHtml(key)}</div>
          <div class="fact-value">${this._escHtml(facts[key])}</div>
        </div>
        <button class="fact-del" data-key="${this._escHtml(key)}" title="Supprimer">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>`;
      list.appendChild(item);
    });

    list.querySelectorAll('.fact-del').forEach(btn => {
      btn.addEventListener('click', () => {
        Memory.deleteFact(btn.dataset.key);
        this.renderFactsList();
      });
    });
  },

  /* Show error toast */
  showError(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  },

  _time() {
    return new Date().toLocaleTimeString('fr-MA', { hour: '2-digit', minute: '2-digit' });
  },

  _escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  },
};

/* ============================================================
   APP  — orchestrator
   ============================================================ */
const App = {

  _deferredInstall: null,
  _pendingImage: null, // { base64: string, mimeType: string, dataUrl: string }

  init() {
    Memory.load();
    UI.init();

    // Render history from previous sessions
    UI.renderHistory();
    UI.updateMemoryBadge();

    this._bindEvents();
    this._registerSW();
    this._initSplash();
    this._handlePWAInstall();
  },

  _bindEvents() {
    const { input, sendBtn, clearBtn, memoryBtn, overlay,
            closePanelBtn, clearMemoryBtn, welcomeCard,
            closeIosHint, imgBtn, imgInput, imgRemoveBtn } = UI.els;

    /* Send on button click */
    sendBtn.addEventListener('click', () => this._send());

    /* Send on Enter (not Shift+Enter) */
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!sendBtn.disabled) this._send();
      }
    });

    /* Auto-resize textarea */
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      sendBtn.disabled = !input.value.trim() && !this._pendingImage;
    });

    /* Image button — open file picker */
    imgBtn.addEventListener('click', () => imgInput.click());

    /* File selected */
    imgInput.addEventListener('change', () => {
      const file = imgInput.files[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        UI.showError('Fichier non supporté — image uniquement');
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        UI.showError('Image trop grande (max 10 Mo)');
        return;
      }
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target.result;
        const base64 = dataUrl.split(',')[1];
        const mimeType = file.type;
        this._pendingImage = { base64, mimeType, dataUrl };
        UI.els.imgPreview.src = dataUrl;
        UI.els.imgPreviewWrap.classList.remove('hidden');
        UI.els.imgBtn.classList.add('active');
        sendBtn.disabled = false;
      };
      reader.readAsDataURL(file);
      imgInput.value = ''; // reset so same file can be re-selected
    });

    /* Remove image */
    imgRemoveBtn.addEventListener('click', () => this._clearImage());

    /* Clear conversation */
    clearBtn.addEventListener('click', () => {
      if (confirm('Effacer toute la conversation ?')) {
        Memory.clearAll();
        UI.els.messages.innerHTML = '';
        if (UI.els.welcomeCard) {
          UI.els.welcomeCard.style.display = '';
        } else {
          // Re-add welcome card
          location.reload();
        }
        UI.updateMemoryBadge();
      }
    });

    /* Memory panel */
    memoryBtn.addEventListener('click', () => UI.openMemoryPanel());
    closePanelBtn.addEventListener('click', () => UI.closeMemoryPanel());
    overlay.addEventListener('click', () => UI.closeMemoryPanel());

    /* Clear memory */
    clearMemoryBtn.addEventListener('click', () => {
      if (confirm('Effacer toute la memoire apprise ?')) {
        Memory.clearFacts();
        UI.renderFactsList();
      }
    });

    /* Quick chips in welcome card */
    document.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        input.value = chip.textContent;
        input.dispatchEvent(new Event('input'));
        input.focus();
      });
    });

    /* Install button */
    UI.els.installBtn.addEventListener('click', () => this._triggerInstall());

    /* iOS hint close */
    if (closeIosHint) {
      closeIosHint.addEventListener('click', () => UI.els.iosHint.classList.add('hidden'));
    }
  },

  _clearImage() {
    this._pendingImage = null;
    UI.els.imgPreviewWrap.classList.add('hidden');
    UI.els.imgBtn.classList.remove('active');
    UI.els.imgPreview.src = '';
    UI.els.sendBtn.disabled = !UI.els.input.value.trim();
  },

  async _send() {
    const input = UI.els.input;
    const text = input.value.trim();
    const image = this._pendingImage;
    if ((!text && !image) || UI.isTyping) return;

    // Reset input
    input.value = '';
    input.style.height = 'auto';
    UI.els.sendBtn.disabled = true;

    // Build display text for user bubble
    const displayText = text || '[Photo envoyée]';

    // Show user message (with image thumbnail if present)
    UI.appendMessage('user', displayText, true, image ? image.dataUrl : null);
    Memory.addMessage('user', text || '[Photo]');

    // Clear image state
    if (image) this._clearImage();

    // Show typing
    UI.setLoading(true);

    try {
      const rawReply = await Gemini.send(text, image);
      UI.setLoading(false);

      // Extract <<IMG:>> tags and fetch reference images
      const { cleanText, queries } = ImageSearch.extractTags(rawReply);
      UI.appendMessage('bot', cleanText);
      Memory.addMessage('bot', cleanText);

      // Fetch images in background and inject into last bot bubble
      if (queries.length > 0) {
        ImageSearch.fetchImages(queries).then(refImages => {
          if (refImages.length === 0) return;
          // Find last bot bubble and append images
          const bubbles = document.querySelectorAll('.msg-row.bot .msg-bubble');
          const lastBubble = bubbles[bubbles.length - 1];
          if (!lastBubble) return;
          const strip = document.createElement('div');
          strip.className = 'ref-img-strip';
          refImages.forEach(({ url, query }) => {
            const wrap = document.createElement('div');
            wrap.className = 'ref-img-wrap';
            const img = document.createElement('img');
            img.src = url;
            img.alt = query;
            img.className = 'ref-img';
            img.loading = 'lazy';
            img.onerror = () => { wrap.style.display = 'none'; };
            const cap = document.createElement('div');
            cap.className = 'ref-img-cap';
            cap.textContent = query;
            wrap.appendChild(img);
            wrap.appendChild(cap);
            strip.appendChild(wrap);
          });
          lastBubble.appendChild(strip);
          UI.scrollBottom();
        });
      }
    } catch (err) {
      UI.setLoading(false);
      const errMsg = err.message || 'Erreur de connexion';
      UI.showError('Erreur : ' + errMsg);
      console.error('Gemini error:', err);
    }

    input.focus();
  },

  _registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(err => {
        console.warn('SW registration failed:', err);
      });
    }
  },

  /* ---- SPLASH SCREEN ---- */
  _initSplash() {
    const splash       = document.getElementById('splash-screen');
    const installBtn   = document.getElementById('splash-install-btn');
    const skipBtn      = document.getElementById('splash-skip-btn');
    const iosGuide     = document.getElementById('splash-ios-guide');
    const iosSkipBtn   = document.getElementById('splash-ios-skip');

    if (!splash) return;

    const isIOS        = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
                      || window.navigator.standalone;

    // Already installed — skip splash entirely
    if (isStandalone) {
      splash.classList.add('splash-gone');
      return;
    }

    // iOS — hide install btn, show step guide instead
    if (isIOS) {
      installBtn.closest('.splash-actions').classList.add('hidden');
      iosGuide.classList.remove('hidden');
      iosSkipBtn.addEventListener('click', () => this._hideSplash(splash));
      return;
    }

    // Android / Desktop
    // Listen for beforeinstallprompt in background
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      this._deferredInstall = e;
      // If user already clicked, fire now
      if (this._splashInstallPending) {
        this._splashInstallPending = false;
        this._doInstallFromSplash(installBtn, splash);
      }
    });

    window.addEventListener('appinstalled', () => {
      this._deferredInstall = null;
      this._hideSplash(splash);
    });

    installBtn.addEventListener('click', () => {
      if (this._deferredInstall) {
        this._doInstallFromSplash(installBtn, splash);
      } else {
        // Prompt not ready yet — show waiting state and remember click
        installBtn.classList.add('waiting');
        installBtn.textContent = 'Préparation...';
        this._splashInstallPending = true;
      }
    });

    skipBtn.addEventListener('click', () => this._hideSplash(splash));
  },

  _splashInstallPending: false,

  async _doInstallFromSplash(installBtn, splash) {
    if (!this._deferredInstall) return;
    try {
      this._deferredInstall.prompt();
      const { outcome } = await this._deferredInstall.userChoice;
      if (outcome === 'accepted') {
        this._deferredInstall = null;
        this._hideSplash(splash);
      } else {
        // User dismissed — reset button
        installBtn.classList.remove('waiting');
        installBtn.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
               stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          Installer l'application`;
      }
    } catch(e) {
      console.warn('Install prompt error:', e);
    }
  },

  _hideSplash(splash) {
    splash.classList.add('splash-hiding');
    setTimeout(() => splash.classList.add('splash-gone'), 420);
  },

  /* Keep header install btn working after splash is dismissed */
  _handlePWAInstall() {
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
                      || window.navigator.standalone;
    if (isStandalone) return;

    // Header install btn — shows only if deferredInstall is ready
    window.addEventListener('beforeinstallprompt', () => {
      UI.els.installBtn.classList.remove('hidden');
    });
    window.addEventListener('appinstalled', () => {
      UI.els.installBtn.classList.add('hidden');
    });
  },

  async _triggerInstall() {
    if (!this._deferredInstall) return;
    this._deferredInstall.prompt();
    const { outcome } = await this._deferredInstall.userChoice;
    if (outcome === 'accepted') {
      UI.els.installBtn.classList.add('hidden');
      this._deferredInstall = null;
    }
  },
};

/* ============================================================
   BOOT
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => App.init());