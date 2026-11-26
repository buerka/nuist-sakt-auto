// ==UserScript==
// @name         南信大实验室安全平台 · 自动连续学习
// @namespace    local.sakt.auto
// @version      1.0.0
// @description  自动逐节播放「未学」课时：防挂机续播、自动处理弹窗习题、播完自动进入下一节。仅用于本人已登录的课程页面。
// @author       buerka
// @license      MIT
// @match        https://sakt.nuist.edu.cn/students/courseDetail*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/buerka/sakt-auto/main/sakt-auto.user.js
// @downloadURL  https://raw.githubusercontent.com/buerka/sakt-auto/main/sakt-auto.user.js
// @supportURL   https://github.com/buerka/sakt-auto/issues
// ==/UserScript==

/**
 * 用法（油猴 / Tampermonkey）：
 *   1. 安装 Tampermonkey 扩展
 *   2. 新建脚本，粘贴本文件全部内容，保存
 *   3. 登录平台 → 我的课程 → 进入任意课程，右下角点「开始」
 *   4. 之后它会自己跑完全部未学课时；课程页刷新/跳转后会自动继续
 *
 * 说明：
 *   - 视频是真实按 RATE 倍速播放，完成记录由平台自己的 /finish 接口写入，
 *     本脚本不伪造任何进度，也不直接调用完成接口。
 *   - 弹窗习题平台不校验对错（提交即放行），脚本默认选第一个选项，
 *     并把题目/所选答案记到 localStorage['sakt.quizlog']，方便事后复习。
 *   - 停止：面板「停止」，或控制台执行 window.__saktStop()
 */
(() => {
  'use strict';
  if (window.__saktRunning) return;

  // ======================= 可调参数 =======================
  const CFG = {
    rate: 1.5,          // 播放倍速（1 = 原速；建议 1~2）
    muted: true,        // 静音播放，后台标签页也能继续
    autoAnswer: true,   // 自动作答弹窗习题
    autoNext: true,     // 播完自动进入下一节
    answerFirst: 'A',   // 自动作答选第几个选项（A/B/C/D）
  };
  // =======================================================

  const TOKEN_KEY = 'pro__Access-Token';
  const QKEY = 'sakt.queue';
  const QLOG = 'sakt.quizlog';
  const AUTO = 'sakt.auto';   // '1' = 下次打开课程页自动继续

  const $ = (s, r = document) => r.querySelector(s);
  const sleep = ms => new Promise(res => setTimeout(res, ms));
  const clean = s => (s || '').replace(/^\([^)]*\)\s*/, '').trim();   // 去掉 (未学)/(学完) 前缀
  const token = () => { try { return JSON.parse(localStorage.getItem(TOKEN_KEY)).value; } catch (e) { return ''; } };
  const curGraph = () => new URLSearchParams(location.search).get('graphId');
  const curId = () => new URLSearchParams(location.search).get('id');

  async function api(path, params) {
    const qs = new URLSearchParams(params || {}).toString();
    const r = await fetch(`/api/jeecg-boot${path}${qs ? '?' + qs : ''}`, {
      headers: { 'X-Access-Token': token() },
      credentials: 'include',
    });
    return r.json();
  }

  // ---------------- 队列 ----------------
  function loadQueue() {
    try {
      const q = JSON.parse(localStorage.getItem(QKEY) || 'null');
      if (q && q.graphId === curGraph() && Array.isArray(q.items)) return q;
    } catch (e) {}
    return null;
  }
  const saveQueue = q => localStorage.setItem(QKEY, JSON.stringify(q));

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
    const el = $('.right .title') || $('.right > .title');
    return el ? el.innerText.trim() : '';
  }
  function visibleModal() {
    return [...document.querySelectorAll('.ant-modal-wrap')].find(m => getComputedStyle(m).display !== 'none');
  }

  // ---------------- 自动作答 ----------------
  const handledModals = new WeakMap();   // 弹窗 → 上次提交时间，避免每秒重复作答
  function answerQuiz(m) {
    const now = Date.now();
    const last = handledModals.get(m) || 0;
    if (now - last < 5000) return false;   // 已提交过，等它关闭
    const stem = (m.querySelector('.sub-title')?.innerText || '').trim().replace(/\s+/g, ' ');
    const picked = [];
    m.querySelectorAll('.ant-radio-group, .ant-checkbox-group').forEach(g => {
      const items = [...g.querySelectorAll('.ant-radio-wrapper, .ant-checkbox-wrapper')];
      const checked = items.find(x => /-checked/.test(x.className));
      if (checked) { picked.push(checked.innerText.trim().split('\n')[0]); return; }
      const idx = Math.max(0, 'ABCD'.indexOf(CFG.answerFirst));
      const target = items[Math.min(idx, items.length - 1)];
      if (target) { target.click(); picked.push((target.innerText || '').trim().split('\n')[0]); }
    });
    try {
      const log = JSON.parse(localStorage.getItem(QLOG) || '[]');
      log.push({ t: Date.now(), lesson: pageLessonName(), stem, picked });
      localStorage.setItem(QLOG, JSON.stringify(log.slice(-500)));
    } catch (e) {}
    // 注意：按钮渲染文字是「提 交」，中间有空格，必须去空白后匹配
    const btn = [...m.querySelectorAll('button')].find(b => (b.innerText || '').replace(/\s+/g, '').includes('提交'));
    if (btn && !btn.disabled) {
      handledModals.set(m, now);
      btn.click();
      console.log('[SAKT] 自动作答:', stem, '→', picked.join(' / '));
      return true;
    }
    return false;
  }

  // ---------------- 切换下一节 ----------------
  async function clickLessonByName(name) {
    // 展开所有折叠的分组
    for (let i = 0; i < 3; i++) {
      const closed = [...document.querySelectorAll('.ant-tree-switcher_close')];
      if (!closed.length) break;
      closed.forEach(s => s.click());
      await sleep(250);
    }
    const key = clean(name);
    const nodes = [...document.querySelectorAll('.ant-tree-node-content-wrapper')];
    const node = nodes.find(el => clean(el.innerText).includes(key)) ||
                 nodes.find(el => clean(el.innerText) === key);
    if (node) { node.click(); return true; }
    return false;
  }

  async function goToLesson(item) {
    if (await clickLessonByName(item.name)) return true;
    // 兜底 1：SPA 双跳，强制重建 courseDetail 组件
    const router = document.querySelector('#app')?.__vue__?.$router;
    if (router) {
      try {
        await router.push('/students/myCourse');
        await sleep(400);
        await router.push({ path: '/students/courseDetail', query: { graphId: curGraph(), id: item.id } });
        return true;
      } catch (e) {}
    }
    // 兜底 2：整页跳转（油猴模式下刷新后会自动继续）
    location.href = `/students/courseDetail?graphId=${curGraph()}&id=${item.id}`;
    return true;
  }

  // ---------------- 播放控制 ----------------
  let video = null, resuming = false, endedHandled = false, lastSrc = '';

  function ensureVideo() {
    video = $('video');
    if (!video) return false;
    if (video.muted !== CFG.muted) video.muted = CFG.muted;
    if (video.playbackRate !== CFG.rate) video.playbackRate = CFG.rate;
    if (video.currentSrc !== lastSrc) { lastSrc = video.currentSrc; endedHandled = false; }
    return true;
  }
  async function tryPlay() {
    if (!video || resuming || !video.paused || video.ended) return;
    resuming = true;
    try { await video.play(); } catch (e) {}
    resuming = false;
  }

  let timer = null;
  function startLoop() {
    if (timer) return;
    timer = setInterval(async () => {
      if (!ensureVideo()) return;

      // 1) 弹窗习题
      const m = visibleModal();
      if (m) { if (CFG.autoAnswer) answerQuiz(m); return; }

      // 2) 防挂机/后台暂停 → 续播
      if (video.paused && !video.ended) await tryPlay();
      if (video.playbackRate !== CFG.rate) video.playbackRate = CFG.rate;

      // 3) 播完 → 下一节
      if (video.ended && !endedHandled) {
        endedHandled = true;
        console.log('[SAKT] 本节完成，等待平台记录…');
        setTimeout(async () => {
          const q = loadQueue();
          if (!q) return;
          const name = pageLessonName();
          const i = q.items.findIndex(x => clean(x.name) === clean(name));
          if (i > -1) { q.items.splice(i, 1); saveQueue(q); }
          if (CFG.autoNext && q.items.length) {
            const next = q.items[Math.min(i < 0 ? 0 : i, q.items.length - 1)];
            console.log('[SAKT] 下一节:', clean(next.name));
            endedHandled = false;
            renderPanel();
            await goToLesson(next);
          } else {
            console.log('[SAKT] 全部完成 🎉');
            localStorage.setItem(AUTO, '0');
            renderPanel('全部完成');
          }
        }, 4000);
      }
      renderPanel();
    }, 1000);
  }

  // ---------------- 面板 ----------------
  let panel;
  function renderPanel(note) {
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'sakt-panel';
      panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;background:rgba(17,24,39,.92);color:#fff;padding:10px 12px;border-radius:8px;font:12px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3);min-width:220px';
      document.body.appendChild(panel);
    }
    if (!window.__saktRunning) {
      panel.innerHTML = `<div style="font-weight:600;margin-bottom:6px">SAKT 自动学习</div>
        <div style="opacity:.75;margin-bottom:6px">停留在此页，点开始后自动跑</div>
        <button id="sakt-start" style="width:100%;cursor:pointer;border:0;border-radius:4px;padding:4px 0">开始自动刷课</button>`;
      $('#sakt-start').onclick = start;
      return;
    }
    const q = loadQueue();
    const total = q ? q.items.length : 0;
    const name = pageLessonName();
    const idx = q ? q.items.findIndex(x => clean(x.name) === clean(name)) : -1;
    const t = video ? `${Math.floor(video.currentTime)}s / ${Math.floor(video.duration || 0)}s` : '-';
    panel.innerHTML = `
      <div style="font-weight:600;margin-bottom:4px">自动学习${note ? ' · ' + note : ''}</div>
      <div>剩余：${total} 节${idx > -1 ? `（本节第 ${idx + 1} 节）` : ''}</div>
      <div>本节：${clean(name).slice(0, 22) || '-'}</div>
      <div>进度：${t} · ${CFG.rate}x · ${video && !video.paused ? '播放中' : '等待'}</div>
      <div style="margin-top:6px;display:flex;gap:6px">
        <button id="sakt-pause" style="flex:1;cursor:pointer;border:0;border-radius:4px;padding:3px 0">${timer ? '暂停' : '继续'}</button>
        <button id="sakt-stop" style="flex:1;cursor:pointer;border:0;border-radius:4px;padding:3px 0">停止</button>
      </div>`;
    $('#sakt-pause').onclick = () => { if (timer) { clearInterval(timer); timer = null; localStorage.setItem(AUTO, '0'); if (video) video.pause(); } else { localStorage.setItem(AUTO, '1'); startLoop(); tryPlay(); } renderPanel(); };
    $('#sakt-stop').onclick = stop;
  }

  function stop() {
    clearInterval(timer); timer = null;
    window.__saktRunning = false;
    localStorage.setItem(AUTO, '0');
    renderPanel();
    console.log('[SAKT] 已停止（再次开始请点面板按钮）');
  }

  async function start() {
    const q = await ensureQueue();
    if (!q.items.length) { renderPanel('没有未学课时'); return; }
    localStorage.setItem(AUTO, '1');
    window.__saktRunning = true;
    ensureVideo();
    await tryPlay();
    startLoop();
    renderPanel();
    console.log(`[SAKT] 启动：剩余 ${q.items.length} 节，倍速 ${CFG.rate}x`);
  }

  window.__saktStart = start;
  window.__saktStop = stop;

  // ---------------- 自动恢复 ----------------
  (async () => {
    if (!curGraph() || !curId()) return;
    await sleep(800);
    const q = await ensureQueue();
    if (localStorage.getItem(AUTO) === '1' && q.items.length) {
      console.log('[SAKT] 检测到上次未完成的队列，自动继续');
      start();
    } else {
      renderPanel();
    }
  })().catch(e => console.error('[SAKT] 初始化失败:', e));
})();