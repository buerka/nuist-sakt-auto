// ==UserScript==
// @name         南信大（NUIST）实验室安全平台 · 自动连续学习
// @namespace    https://github.com/buerka/nuist-sakt-auto
// @version      1.2.0
// @description  南京信息工程大学（NUIST）实验室安全准入与教育平台：自动逐节播放未学课时，支持 AI 答题、防挂机续播、自动切课。
// @author       buerka
// @license      MIT
// @match        https://sakt.nuist.edu.cn/students/courseDetail*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      *
// @updateURL    https://raw.githubusercontent.com/buerka/nuist-sakt-auto/main/sakt-auto.user.js
// @downloadURL  https://raw.githubusercontent.com/buerka/nuist-sakt-auto/main/sakt-auto.user.js
// @supportURL   https://github.com/buerka/nuist-sakt-auto/issues
// ==/UserScript==

/**
 * 用法（Tampermonkey）：
 *   1. 安装 Tampermonkey，新建脚本粘贴本文件并保存
 *   2. 登录平台，进入课程页，右下角面板点「开始自动学习」
 *   3. 面板分三页：运行 / 设置 / AI
 *
 * 说明：
 *   - 视频真实按设定倍速播放，完成记录由平台自身接口写入，脚本不伪造进度
 *   - 弹窗习题默认选 A；开启 AI 后可调用 OpenAI 兼容接口作答
 *   - AI Key 只保存在本机 localStorage，不会发送给平台
 */
/* global unsafeWindow, GM_xmlhttpRequest */
(() => {
  'use strict';

  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (W.__saktRunning) return;

  const DEFAULTS = {
    rate: 1.5,
    muted: true,
    autoAnswer: true,
    autoNext: true,
    answerFirst: 'A',
    useAI: false,
    aiBaseUrl: '',
    aiKey: '',
    aiModel: '',
    aiTimeout: 20000
  };

  const CFG_KEY = 'sakt.config';
  const TOKEN_KEY = 'pro__Access-Token';
  const QKEY = 'sakt.queue';
  const QLOG = 'sakt.quizlog';
  const AICACHE = 'sakt.aiCache';
  const AUTO = 'sakt.auto';

  let CFG = loadConfig();

  function loadConfig() {
    try {
      return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(CFG_KEY) || '{}'));
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }

  function saveConfig() {
    localStorage.setItem(CFG_KEY, JSON.stringify(CFG));
  }

  const $ = (sel, root = document) => root.querySelector(sel);
  const sleep = ms => new Promise(res => setTimeout(res, ms));
  const clean = s => (s || '').replace(/^\([^)]*\)\s*/, '').trim();
  const token = () => {
    try {
      return JSON.parse(localStorage.getItem(TOKEN_KEY)).value;
    } catch (e) {
      return '';
    }
  };
  const curGraph = () => new URLSearchParams(location.search).get('graphId');
  const curId = () => new URLSearchParams(location.search).get('id');

  async function api(path, params) {
    const qs = new URLSearchParams(params || {}).toString();
    const r = await fetch(`/api/jeecg-boot${path}${qs ? '?' + qs : ''}`, {
      headers: { 'X-Access-Token': token() },
      credentials: 'include'
    });
    return r.json();
  }

  // ---------------- 队列 ----------------
  function loadQueue() {
    try {
      const q = JSON.parse(localStorage.getItem(QKEY) || 'null');
      if (q && q.graphId === curGraph() && Array.isArray(q.items)) return q;
    } catch (e) { /* ignore */ }
    return null;
  }

  function saveQueue(q) {
    localStorage.setItem(QKEY, JSON.stringify(q));
  }

  async function buildQueue() {
    const r = await api('/jcedutec/courseSource/myCourseTypeTree', { id: curId(), graphId: curGraph() });
    if (!r.success) throw new Error(r.message || '拉取课程目录失败');
    const items = [];
    (r.result || []).forEach(g => (g.children || []).forEach(c => {
      if (!/^\(学完\)/.test(c.title || '')) items.push({ id: c.key || c.eventKey, name: c.title });
    }));
    const q = { graphId: curGraph(), items };
    saveQueue(q);
    return q;
  }

  async function ensureQueue() {
    return loadQueue() || buildQueue();
  }

  // ---------------- 页面读取 ----------------
  function pageLessonName() {
    const node = $('.right .title');
    return node ? node.innerText.trim() : '';
  }

  function visibleModal() {
    return [...document.querySelectorAll('.ant-modal-wrap')].find(m => getComputedStyle(m).display !== 'none');
  }

  function closeModal() {
    const modal = visibleModal();
    if (!modal) return;
    const btn = modal.querySelector('.ant-modal-close');
    if (btn) btn.click();
  }

  // ---------------- AI 接口 ----------------
  function aiRequest(payload) {
    const base = String(CFG.aiBaseUrl || '').replace(/\/+$/, '');
    const url = base + '/chat/completions';
    const headers = { 'Content-Type': 'application/json' };
    if (CFG.aiKey) headers.Authorization = 'Bearer ' + CFG.aiKey;
    const data = JSON.stringify(payload);
    const timeout = Number(CFG.aiTimeout) || 20000;

    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'POST',
          url,
          headers,
          data,
          timeout,
          onload: res => {
            try {
              resolve(JSON.parse(res.responseText));
            } catch (e) {
              reject(new Error('返回内容不是 JSON'));
            }
          },
          onerror: () => reject(new Error('网络错误')),
          ontimeout: () => reject(new Error('请求超时'))
        });
      });
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    return fetch(url, { method: 'POST', headers, body: data, signal: ctrl.signal })
      .then(r => r.json())
      .finally(() => clearTimeout(timer));
  }

  function parseLetters(text) {
    const found = String(text || '').toUpperCase().match(/[A-D]/g);
    if (!found) return [];
    return [...new Set(found)];
  }

  function readAiCache(stem) {
    try {
      const all = JSON.parse(localStorage.getItem(AICACHE) || '{}');
      const hit = all[stem];
      return hit && Array.isArray(hit.letters) ? hit.letters : null;
    } catch (e) {
      return null;
    }
  }

  function writeAiCache(stem, letters) {
    try {
      const all = JSON.parse(localStorage.getItem(AICACHE) || '{}');
      all[stem] = { letters, t: Date.now() };
      const keys = Object.keys(all);
      if (keys.length > 300) delete all[keys[0]];
      localStorage.setItem(AICACHE, JSON.stringify(all));
    } catch (e) { /* ignore */ }
  }

  async function aiAnswer(q) {
    const cached = readAiCache(q.stem);
    if (cached) return cached;

    const options = q.options.map(o => o.letter + '. ' + o.text).join('\n');
    const payload = {
      model: CFG.aiModel,
      temperature: 0,
      max_tokens: 16,
      messages: [
        {
          role: 'system',
          content: '你是实验室安全考试助手。只输出选项字母，不要解释。多选题输出多个字母，例如 AC。'
        },
        {
          role: 'user',
          content: `题型：${q.kindText}\n题目：${q.stem}\n选项：\n${options}\n请只回答字母：`
        }
      ]
    };

    const resp = await aiRequest(payload);
    const content = resp && resp.choices && resp.choices[0] && resp.choices[0].message
      ? resp.choices[0].message.content
      : '';
    if (!content) throw new Error('AI 返回为空');

    const letters = parseLetters(content).filter(l => q.options.some(o => o.letter === l));
    if (!letters.length) throw new Error('无法解析选项：' + String(content).slice(0, 40));
    writeAiCache(q.stem, letters);
    return letters;
  }

  // ---------------- 弹窗习题 ----------------
  function extractQuiz(m) {
    const sub = (m.querySelector('.sub-title')?.innerText || '').trim();
    const kindMatch = sub.match(/^\((.*?)\)/);
    const kindText = kindMatch ? kindMatch[1] : '';
    const stem = sub.replace(/^\([^)]*\)\s*/, '').replace(/\s+/g, ' ').trim();

    const options = [];
    m.querySelectorAll('.ant-radio-wrapper, .ant-checkbox-wrapper').forEach(node => {
      const letterEl = node.querySelector('.letter');
      const letterText = letterEl ? (letterEl.innerText || '').trim() : '';
      let letter = letterText.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 1);
      if (!letter) letter = 'ABCD'[options.length] || '';
      const full = (node.innerText || '').replace(/\s+/g, ' ').trim();
      const text = letterText ? full.replace(letterText.replace(/\s+/g, ' '), '').trim() : full;
      options.push({ letter, text });
    });

    return { kindText, stem, options };
  }

  function isChecked(node) {
    return /-checked/.test(node.className) || !!node.querySelector('.ant-checkbox-checked, .ant-radio-checked');
  }

  function chooseOptions(m, letters) {
    const wanted = new Set(letters);
    m.querySelectorAll('.ant-radio-wrapper, .ant-checkbox-wrapper').forEach((node, index) => {
      const letterEl = node.querySelector('.letter');
      const letter = letterEl
        ? (letterEl.innerText || '').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 1)
        : ('ABCD'[index] || '');
      if (wanted.has(letter) && !isChecked(node)) node.click();
    });
  }

  function logQuiz(entry) {
    try {
      const log = JSON.parse(localStorage.getItem(QLOG) || '[]');
      log.push(entry);
      localStorage.setItem(QLOG, JSON.stringify(log.slice(-500)));
    } catch (e) { /* ignore */ }
  }

  let answering = false;
  const handledModals = new WeakMap();

  async function handleQuiz(m) {
    if (!CFG.autoAnswer) {
      setStatus('等待作答（自动答题已关闭）');
      return;
    }
    const now = Date.now();
    if (answering || now - (handledModals.get(m) || 0) < 4000) return;

    answering = true;
    handledModals.set(m, now);

    try {
      const q = extractQuiz(m);
      let letters = [];
      let source = 'default';
      let aiError = '';

      if (CFG.useAI && CFG.aiBaseUrl && CFG.aiModel) {
        try {
          letters = await aiAnswer(q);
          source = 'ai';
        } catch (e) {
          aiError = e.message;
          setAiStatus('AI 失败：' + e.message + '，改用默认选项');
        }
      }

      if (!letters.length) {
        letters = [CFG.answerFirst || 'A'];
        source = 'default';
      }

      chooseOptions(m, letters);
      await sleep(200);
      const btn = [...m.querySelectorAll('button')].find(b => (b.innerText || '').replace(/\s+/g, '').includes('提交'));
      if (btn && !btn.disabled) btn.click();

      logQuiz({
        t: now,
        lesson: pageLessonName(),
        stem: q.stem,
        picked: letters,
        source,
        aiError
      });

      setStatus(`已作答：${letters.join('')}（${source === 'ai' ? 'AI' : '默认'}）`);
      console.log('[SAKT] 作答:', q.stem, '→', letters.join(''), source);
    } finally {
      answering = false;
    }
  }

  // ---------------- 切换课时 ----------------
  async function clickLessonByName(name) {
    for (let i = 0; i < 3; i++) {
      const closed = [...document.querySelectorAll('.ant-tree-switcher_close')];
      if (!closed.length) break;
      closed.forEach(s => s.click());
      await sleep(250);
    }
    const key = clean(name);
    const nodes = [...document.querySelectorAll('.ant-tree-node-content-wrapper')];
    const node = nodes.find(el => clean(el.innerText).includes(key));
    if (node) {
      node.click();
      return true;
    }
    return false;
  }

  async function goToLesson(item) {
    closeModal();
    if (await clickLessonByName(item.name)) return true;

    const app = W.document ? W.document.querySelector('#app') : null;
    const router = app && app.__vue__ ? app.__vue__.$router : null;
    if (router) {
      try {
        await router.push('/students/myCourse');
        await sleep(400);
        await router.push({ path: '/students/courseDetail', query: { graphId: curGraph(), id: item.id } });
        return true;
      } catch (e) { /* ignore */ }
    }

    location.href = `/students/courseDetail?graphId=${curGraph()}&id=${item.id}`;
    return true;
  }

  // ---------------- 播放控制 ----------------
  let video = null;
  let resuming = false;
  let endedHandled = false;
  let lastSrc = '';

  function ensureVideo() {
    video = $('video');
    if (!video) return false;
    if (video.muted !== CFG.muted) video.muted = CFG.muted;
    if (video.playbackRate !== Number(CFG.rate)) video.playbackRate = Number(CFG.rate);
    if (video.currentSrc !== lastSrc) {
      lastSrc = video.currentSrc;
      endedHandled = false;
    }
    return true;
  }

  function tryPlay() {
    if (!video || resuming || !video.paused || video.ended) return;
    resuming = true;
    Promise.resolve(video.play()).catch(() => {}).finally(() => {
      resuming = false;
    });
  }

  let timer = null;

  async function tick() {
    if (!ensureVideo()) return;

    const modal = visibleModal();
    if (modal) {
      await handleQuiz(modal);
      renderStatus();
      return;
    }

    if (video.paused && !video.ended) tryPlay();
    if (video.playbackRate !== Number(CFG.rate)) video.playbackRate = Number(CFG.rate);

    if (video.ended && !endedHandled) {
      endedHandled = true;
      console.log('[SAKT] 本节完成，等待平台记录…');
      setTimeout(async () => {
        const q = loadQueue();
        if (!q) return;
        const name = pageLessonName();
        const i = q.items.findIndex(x => clean(x.name) === clean(name));
        if (i > -1) {
          q.items.splice(i, 1);
          saveQueue(q);
        }
        if (CFG.autoNext && q.items.length) {
          const next = q.items[Math.min(i < 0 ? 0 : i, q.items.length - 1)];
          console.log('[SAKT] 下一节:', clean(next.name));
          endedHandled = false;
          renderStatus();
          await goToLesson(next);
        } else {
          console.log('[SAKT] 全部完成');
          localStorage.setItem(AUTO, '0');
          stopLoop();
          setStatus('全部完成');
        }
      }, 4000);
    }

    renderStatus();
  }

  function startLoop() {
    if (timer) return;
    timer = setInterval(() => {
      tick().catch(e => console.error('[SAKT] tick:', e));
    }, 1000);
    renderActions();
  }

  function stopLoop() {
    clearInterval(timer);
    timer = null;
    renderActions();
  }

  async function start() {
    try {
      const q = await ensureQueue();
      if (!q.items.length) {
        setStatus('没有未学课时');
        return;
      }

      const current = clean(pageLessonName());
      const inQueue = q.items.some(x => clean(x.name) === current);
      if (!inQueue) {
        setStatus('当前课时已学完，跳转到：' + clean(q.items[0].name));
        await goToLesson(q.items[0]);
        await sleep(1500);
      }

      localStorage.setItem(AUTO, '1');
      state.running = true;
      W.__saktRunning = true;
      ensureVideo();
      tryPlay();
      startLoop();
      renderStatus();
      setStatus(`启动：剩余 ${q.items.length} 节，倍速 ${CFG.rate}x`);
      console.log(`[SAKT] 启动：剩余 ${q.items.length} 节，倍速 ${CFG.rate}x`);
    } catch (e) {
      setStatus('启动失败：' + e.message);
    }
  }

  function togglePause() {
    if (timer) {
      stopLoop();
      if (video) video.pause();
      localStorage.setItem(AUTO, '0');
      setStatus('已暂停');
    } else {
      localStorage.setItem(AUTO, '1');
      state.running = true;
      W.__saktRunning = true;
      startLoop();
      tryPlay();
      setStatus('继续播放');
    }
    renderStatus();
  }

  function stop() {
    stopLoop();
    state.running = false;
    W.__saktRunning = false;
    localStorage.setItem(AUTO, '0');
    setStatus('已停止');
    renderStatus();
  }

  // ---------------- 面板 ----------------
  const state = { running: false, tab: 'run', status: '' };
  const el = {};

  function injectCSS() {
    if (document.getElementById('sakt-style')) return;
    const style = document.createElement('style');
    style.id = 'sakt-style';
    style.textContent = `
      #sakt-panel {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 99999;
        width: 292px;
        background: #ffffff;
        color: #111111;
        border: 1px solid #111111;
        border-radius: 2px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.1);
        font: 12.5px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
        overflow: hidden;
      }
      #sakt-panel .sakt-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px;
        border-bottom: 1px solid #111111;
      }
      #sakt-panel .sakt-title b {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.14em;
      }
      #sakt-panel .sakt-title i {
        margin-left: 6px;
        font-style: normal;
        font-size: 11px;
        color: #999999;
      }
      #sakt-panel .sakt-dot {
        font-size: 9px;
        color: #d4d4d4;
      }
      #sakt-panel .sakt-tabs {
        display: flex;
        border-bottom: 1px solid #e8e8e8;
      }
      #sakt-panel .sakt-tab {
        flex: 1;
        margin-bottom: -1px;
        padding: 8px 0;
        border: 0;
        border-bottom: 2px solid transparent;
        background: transparent;
        color: #999999;
        font-size: 12px;
        cursor: pointer;
      }
      #sakt-panel .sakt-tab:hover {
        color: #111111;
      }
      #sakt-panel .sakt-tab.active {
        color: #111111;
        border-bottom-color: #111111;
        font-weight: 600;
      }
      #sakt-panel .sakt-page {
        display: none;
        padding: 12px;
      }
      #sakt-panel .sakt-page.active {
        display: block;
      }
      #sakt-panel .sakt-row {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 5px;
      }
      #sakt-panel .sakt-muted {
        flex: none;
        color: #999999;
      }
      #sakt-panel .sakt-value {
        color: #111111;
        text-align: right;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #sakt-panel .sakt-bar {
        height: 2px;
        margin: 8px 0 2px;
        background: #eeeeee;
        overflow: hidden;
      }
      #sakt-panel .sakt-bar-inner {
        width: 0;
        height: 100%;
        background: #111111;
        transition: width 0.4s linear;
      }
      #sakt-panel .sakt-actions {
        display: flex;
        gap: 8px;
        margin-top: 12px;
      }
      #sakt-panel .sakt-btn {
        flex: 1;
        padding: 7px 0;
        border-radius: 2px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s, color 0.15s;
      }
      #sakt-panel .sakt-btn.solid {
        border: 1px solid #111111;
        background: #111111;
        color: #ffffff;
      }
      #sakt-panel .sakt-btn.solid:hover {
        background: #000000;
      }
      #sakt-panel .sakt-btn.ghost {
        border: 1px solid #111111;
        background: #ffffff;
        color: #111111;
      }
      #sakt-panel .sakt-btn.ghost:hover {
        background: #111111;
        color: #ffffff;
      }
      #sakt-panel .sakt-field {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin: 9px 0;
        color: #111111;
      }
      #sakt-panel .sakt-field input[type="number"],
      #sakt-panel .sakt-field input[type="text"],
      #sakt-panel .sakt-field input[type="password"],
      #sakt-panel .sakt-field select {
        width: 158px;
        padding: 4px 6px;
        border: 1px solid #d4d4d4;
        border-radius: 2px;
        background: #ffffff;
        color: #111111;
        font-size: 12px;
        outline: none;
      }
      #sakt-panel .sakt-field input[type="number"]:focus,
      #sakt-panel .sakt-field input[type="text"]:focus,
      #sakt-panel .sakt-field input[type="password"]:focus,
      #sakt-panel .sakt-field select:focus {
        border-color: #111111;
      }
      #sakt-panel .sakt-field input[type="checkbox"] {
        width: 14px;
        height: 14px;
        accent-color: #111111;
      }
      #sakt-panel .sakt-hint {
        margin-top: 8px;
        color: #999999;
        font-size: 11px;
        line-height: 1.6;
      }
      #sakt-panel .sakt-status {
        margin-top: 8px;
        min-height: 16px;
        color: #555555;
        font-size: 11.5px;
        word-break: break-all;
      }
    `;
    document.head.appendChild(style);
  }

  function buildPanel() {
    injectCSS();
    const root = document.createElement('div');
    root.id = 'sakt-panel';
    root.innerHTML = `
      <div class="sakt-head">
        <span class="sakt-title"><b>SAKT</b><i>自动学习</i></span>
        <span class="sakt-dot" id="sakt-dot">●</span>
      </div>
      <div class="sakt-tabs">
        <button class="sakt-tab active" data-tab="run">运行</button>
        <button class="sakt-tab" data-tab="cfg">设置</button>
        <button class="sakt-tab" data-tab="ai">AI</button>
      </div>
      <div class="sakt-page active" data-page="run">
        <div class="sakt-row"><span class="sakt-muted">剩余</span><span class="sakt-value" id="sakt-left">-</span></div>
        <div class="sakt-row"><span class="sakt-muted">本节</span><span class="sakt-value" id="sakt-cur">-</span></div>
        <div class="sakt-row"><span class="sakt-muted">进度</span><span class="sakt-value" id="sakt-prog">-</span></div>
        <div class="sakt-bar"><div class="sakt-bar-inner" id="sakt-bar"></div></div>
        <div class="sakt-actions" id="sakt-actions"></div>
        <div class="sakt-status" id="sakt-status"></div>
      </div>
      <div class="sakt-page" data-page="cfg">
        <label class="sakt-field"><span>播放倍速</span><input type="number" id="sakt-rate" min="1" max="4" step="0.25"></label>
        <label class="sakt-field"><span>静音播放</span><input type="checkbox" id="sakt-muted"></label>
        <label class="sakt-field"><span>自动答题</span><input type="checkbox" id="sakt-autoanswer"></label>
        <label class="sakt-field"><span>自动切下一节</span><input type="checkbox" id="sakt-autonext"></label>
        <label class="sakt-field"><span>默认选项</span>
          <select id="sakt-first">
            <option value="A">A</option>
            <option value="B">B</option>
            <option value="C">C</option>
            <option value="D">D</option>
          </select>
        </label>
        <div class="sakt-actions">
          <button class="sakt-btn solid" id="sakt-save-cfg">保存设置</button>
        </div>
        <div class="sakt-hint">保存后立即生效。倍速建议 1~2；自动答题不校验对错，答错会计入平台「答错」计数。</div>
      </div>
      <div class="sakt-page" data-page="ai">
        <label class="sakt-field"><span>启用 AI 答题</span><input type="checkbox" id="sakt-useai"></label>
        <label class="sakt-field"><span>接口地址</span><input type="text" id="sakt-baseurl" placeholder="https://api.deepseek.com/v1"></label>
        <label class="sakt-field"><span>API Key</span><input type="password" id="sakt-apikey" placeholder="sk-..."></label>
        <label class="sakt-field"><span>模型</span><input type="text" id="sakt-model" placeholder="deepseek-chat"></label>
        <label class="sakt-field"><span>超时(ms)</span><input type="number" id="sakt-timeout" min="3000" max="120000" step="1000"></label>
        <div class="sakt-actions">
          <button class="sakt-btn ghost" id="sakt-test-ai">测试连接</button>
          <button class="sakt-btn solid" id="sakt-save-ai">保存</button>
        </div>
        <div class="sakt-status" id="sakt-ai-status"></div>
        <div class="sakt-hint">OpenAI 兼容接口（DeepSeek、通义千问、Kimi 等均可）。Key 只存在本机 localStorage。AI 答错同样会计入平台答题记录。</div>
      </div>
    `;
    document.body.appendChild(root);

    el.root = root;
    el.dot = $('#sakt-dot', root);
    el.left = $('#sakt-left', root);
    el.cur = $('#sakt-cur', root);
    el.prog = $('#sakt-prog', root);
    el.bar = $('#sakt-bar', root);
    el.actions = $('#sakt-actions', root);
    el.status = $('#sakt-status', root);
    el.aiStatus = $('#sakt-ai-status', root);

    root.querySelectorAll('.sakt-tab').forEach(tab => {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    el.rate = $('#sakt-rate', root);
    el.muted = $('#sakt-muted', root);
    el.autoanswer = $('#sakt-autoanswer', root);
    el.autonext = $('#sakt-autonext', root);
    el.first = $('#sakt-first', root);
    el.useai = $('#sakt-useai', root);
    el.baseurl = $('#sakt-baseurl', root);
    el.apikey = $('#sakt-apikey', root);
    el.model = $('#sakt-model', root);
    el.timeout = $('#sakt-timeout', root);

    el.rate.value = CFG.rate;
    el.muted.checked = !!CFG.muted;
    el.autoanswer.checked = !!CFG.autoAnswer;
    el.autonext.checked = !!CFG.autoNext;
    el.first.value = CFG.answerFirst || 'A';
    el.useai.checked = !!CFG.useAI;
    el.baseurl.value = CFG.aiBaseUrl || '';
    el.apikey.value = CFG.aiKey || '';
    el.model.value = CFG.aiModel || '';
    el.timeout.value = CFG.aiTimeout || 20000;

    $('#sakt-save-cfg', root).addEventListener('click', saveSettings);
    $('#sakt-save-ai', root).addEventListener('click', saveAiSettings);
    $('#sakt-test-ai', root).addEventListener('click', testAi);

    renderActions();
    renderStatus();
  }

  function switchTab(name) {
    state.tab = name;
    document.querySelectorAll('#sakt-panel .sakt-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tab === name);
    });
    document.querySelectorAll('#sakt-panel .sakt-page').forEach(page => {
      page.classList.toggle('active', page.dataset.page === name);
    });
  }

  function setStatus(text) {
    state.status = text;
    if (el.status) el.status.textContent = text;
  }

  function setAiStatus(text) {
    if (el.aiStatus) el.aiStatus.textContent = text;
  }

  function saveSettings() {
    const rate = Number(el.rate.value);
    CFG.rate = Number.isFinite(rate) && rate >= 1 && rate <= 4 ? rate : DEFAULTS.rate;
    CFG.muted = el.muted.checked;
    CFG.autoAnswer = el.autoanswer.checked;
    CFG.autoNext = el.autonext.checked;
    CFG.answerFirst = el.first.value || 'A';
    saveConfig();
    if (video) {
      video.muted = CFG.muted;
      video.playbackRate = CFG.rate;
    }
    setStatus('设置已保存');
    renderStatus();
  }

  function saveAiSettings() {
    CFG.useAI = el.useai.checked;
    CFG.aiBaseUrl = el.baseurl.value.trim();
    CFG.aiKey = el.apikey.value.trim();
    CFG.aiModel = el.model.value.trim();
    const t = Number(el.timeout.value);
    CFG.aiTimeout = Number.isFinite(t) && t >= 3000 ? t : DEFAULTS.aiTimeout;
    saveConfig();
    setAiStatus('AI 设置已保存');
  }

  async function testAi() {
    saveAiSettings();
    if (!CFG.aiBaseUrl || !CFG.aiModel) {
      setAiStatus('请先填写接口地址和模型');
      return;
    }
    setAiStatus('测试中…');
    const started = Date.now();
    try {
      const resp = await aiRequest({
        model: CFG.aiModel,
        temperature: 0,
        max_tokens: 4,
        messages: [{ role: 'user', content: '只输出数字 1' }]
      });
      const content = resp && resp.choices && resp.choices[0] && resp.choices[0].message
        ? resp.choices[0].message.content
        : JSON.stringify(resp).slice(0, 60);
      setAiStatus(`连接成功（${Date.now() - started}ms）：${String(content).slice(0, 40)}`);
    } catch (e) {
      setAiStatus('连接失败：' + e.message);
    }
  }

  function renderActions() {
    if (!el.actions) return;
    if (timer) {
      el.actions.innerHTML = `
        <button class="sakt-btn ghost" id="sakt-pause">暂停</button>
        <button class="sakt-btn solid" id="sakt-stop">停止</button>
      `;
      $('#sakt-pause', el.actions).addEventListener('click', togglePause);
      $('#sakt-stop', el.actions).addEventListener('click', stop);
    } else {
      el.actions.innerHTML = `
        <button class="sakt-btn solid" id="sakt-start">开始自动学习</button>
      `;
      $('#sakt-start', el.actions).addEventListener('click', start);
    }
  }

  function renderStatus() {
    if (!el.root) return;
    const q = loadQueue();
    const name = pageLessonName();
    const total = q ? q.items.length : 0;
    el.left.textContent = total + ' 节';
    el.cur.textContent = clean(name) || '-';
    if (video) {
      const t = Math.floor(video.currentTime || 0);
      const d = Math.floor(video.duration || 0);
      const playState = video.paused ? '暂停' : '播放中';
      el.prog.textContent = `${t}s / ${d}s · ${CFG.rate}x · ${playState}`;
      if (el.bar) el.bar.style.width = (d > 0 ? Math.min(100, (t / d) * 100) : 0) + '%';
    } else {
      el.prog.textContent = '-';
      if (el.bar) el.bar.style.width = '0%';
    }
    el.dot.style.color = timer ? '#111111' : '#d4d4d4';
  }

  // ---------------- 启动 ----------------
  W.__saktStart = start;
  W.__saktStop = stop;

  (async () => {
    buildPanel();
    if (!curGraph() || !curId()) {
      setStatus('请在课程学习页使用');
      return;
    }
    try {
      const q = await ensureQueue();
      if (!q.items.length) setStatus('没有未学课时');
      if (localStorage.getItem(AUTO) === '1' && q.items.length) {
        console.log('[SAKT] 检测到未完成队列，自动继续');
        await start();
      }
    } catch (e) {
      setStatus('课程目录读取失败：' + e.message);
      console.error('[SAKT] 初始化失败:', e);
    }
  })();
})();