// ==UserScript==
// @name         南信大（NUIST）实验室安全平台 · 自动连续学习
// @namespace    https://github.com/buerka/nuist-sakt-auto
// @version      1.9.0
// @description  南京信息工程大学（NUIST）实验室安全准入与教育平台：自动逐节播放未学课时、AI 答题、考试页自动作答。
// @author       buerka
// @license      MIT
// @match        https://sakt.nuist.edu.cn/students/*
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
 *   3. 面板分四页：运行 / 设置 / AI / 考试；标题栏可拖动，右上角可最小化
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
    aiTimeout: 30000,
    aiMaxTokens: 1024,
    aiVotes: 2,
    aiExtra: '',
    examAutoSubmit: false,
    bankFirst: true
  };

  const CFG_KEY = 'sakt.config';
  const TOKEN_KEY = 'pro__Access-Token';
  const QKEY = 'sakt.queue';
  const QLOG = 'sakt.quizlog';
  const EXAMLOG = 'sakt.examlog';
  const AICACHE = 'sakt.aiCache';
  const BANK_KEY = 'sakt.bank';
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

  async function scanWrongLessons() {
    const r = await api('/jcedutec/courseSource/myCourseTypeTree', { id: curId(), graphId: curGraph() });
    if (!r.success) throw new Error(r.message || '拉取课程目录失败');
    const lessons = [];
    (r.result || []).forEach(g => (g.children || []).forEach(c => lessons.push({ id: c.key, name: c.title })));
    const items = [];
    for (let i = 0; i < lessons.length; i++) {
      const c = lessons[i];
      setStatus(`扫描错题：${i + 1}/${lessons.length}`);
      try {
        const d = await api('/jcedutec/courseSource/getById', { id: c.id, graphId: curGraph() });
        if (d.success && Number(d.result.unCorrect) > 0) {
          items.push({
            id: c.id,
            name: d.result.name || c.name,
            wrong: Number(d.result.unCorrect) || 0,
            dur: Number(d.result.duration) || 0
          });
        }
      } catch (e) { /* 单节失败就跳过 */ }
      await sleep(80);
    }
    return items;
  }

  async function relearn() {
    if (state.starting || timer) return;
    const go = window.confirm('将扫描所有课时的错题，只重播有错题的课时，并按题库/AI 重新作答。期间请保持页面打开。确定开始扫描？');
    if (!go) return;
    state.starting = true;
    let items = [];
    try {
      setStatus('正在扫描错题…');
      items = await scanWrongLessons();
    } catch (e) {
      setStatus('扫描失败：' + e.message);
      return;
    } finally {
      state.starting = false;
    }
    if (!items.length) {
      setStatus('没有需要重修的课时');
      return;
    }
    const wrongTotal = items.reduce((sum, x) => sum + x.wrong, 0);
    const seconds = items.reduce((sum, x) => sum + x.dur, 0);
    const minutes = Math.max(1, Math.round(seconds / Math.max(1, CFG.rate) / 60 + items.length * 0.1));
    const ok = window.confirm(`找到 ${items.length} 节有错题的课时（共 ${wrongTotal} 处），预计 ${minutes} 分钟。开始重修？`);
    if (!ok) {
      setStatus('已取消重修');
      return;
    }
    saveQueue({ graphId: curGraph(), items: items.map(x => ({ id: x.id, name: x.name })) });
    await start();
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

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function isReasonerModel() {
    // deepseek-reasoner / *-thinking / o1 这类模型不接受 temperature，省略用默认值
    return /reasoner|thinking|(^|[-_/])r1([-_/]|$)|(^|[-_/])o[134]([-_/]|$)/i.test(String(CFG.aiModel || ''));
  }

  function aiExtraParams() {
    const raw = String(CFG.aiExtra || '').trim();
    if (!raw) return {};
    try {
      const obj = JSON.parse(raw);
      return isPlainObject(obj) ? obj : {};
    } catch (e) {
      return {};
    }
  }

  // ---------------- 本地题库 ----------------
  let bankIndex = null;
  let bankMeta = null;

  function normText(s) {
    return String(s == null ? '' : s)
      .replace(/\s+/g, '')
      .replace(/（/g, '(')
      .replace(/）/g, ')')
      .replace(/[，]/g, ',')
      .replace(/[：]/g, ':')
      .replace(/[；]/g, ';')
      .replace(/[！]/g, '!')
      .replace(/[？]/g, '?')
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .trim();
  }

  function normStem(s) {
    // 题干匹配忽略结尾标点和空的括号占位，兼容「（）」「（ ）」「。」等写法
    let t = normText(s).replace(/[。．.、；;，,：:!！?？]+$/g, '');
    if (t.slice(-2) === '()') t = t.slice(0, -2);
    return t.replace(/[。．.、；;，,：:!！?？]+$/g, '');
  }

  function loadBank() {
    if (bankIndex) return true;
    try {
      const raw = localStorage.getItem(BANK_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.questions)) return false;
      bankMeta = data.meta || { variants: data.questions.length };
      bankIndex = new Map();
      data.questions.forEach(v => {
        if (!v || !v.s || !Array.isArray(v.o) || !Array.isArray(v.a)) return;
        const key = normStem(v.s);
        if (!key) return;
        const list = bankIndex.get(key);
        if (list) list.push(v);
        else bankIndex.set(key, [v]);
      });
      return bankIndex.size > 0;
    } catch (e) {
      bankIndex = null;
      bankMeta = null;
      return false;
    }
  }

  function bankAnswer(q) {
    if (!CFG.bankFirst) return null;
    if (!loadBank()) return null;
    const variants = bankIndex.get(normStem(q.stem));
    if (!variants || !variants.length) return null;
    const current = (q.options || [])
      .filter(o => o && o.letter && o.text)
      .map(o => ({ letter: String(o.letter).toUpperCase(), key: normText(o.text) }));
    if (current.length < 2) return null;
    if (new Set(current.map(o => o.key)).size !== current.length) return null;
    const curKey = current.map(o => o.key).sort().join('|');
    for (const v of variants) {
      if (v.conflict || !v.o || !v.a || v.o.length !== current.length) continue;
      const optKeys = v.o.map(normText);
      if (optKeys.some(k => !k)) continue;
      if (optKeys.slice().sort().join('|') !== curKey) continue;
      const answerKeys = v.a
        .map(l => optKeys['ABCD'.indexOf(String(l).toUpperCase())])
        .filter(Boolean);
      if (!answerKeys.length || answerKeys.length !== v.a.length) continue;
      const letters = [];
      let ok = true;
      answerKeys.forEach(k => {
        const hit = current.find(o => o.key === k);
        if (!hit) ok = false;
        else letters.push(hit.letter);
      });
      if (!ok || !letters.length) continue;
      return { letters: [...new Set(letters)].sort(), variant: v };
    }
    return null;
  }

  function isTrueValue(v) {
    if (v === true || v === 1) return true;
    if (v == null || v === false || v === 0) return false;
    return /^(true|yes|y|correct|right|正确|对|是|选|选中|√|✓)$/i.test(String(v).trim());
  }

  // 从文本里按大括号配对提取所有 JSON 对象（支持嵌套，比如 judge 里再套一层）
  function jsonObjects(raw) {
    const text = String(raw || '');
    const out = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== '{') continue;
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let j = i; j < text.length; j++) {
        const ch = text[j];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            out.push(text.slice(i, j + 1));
            break;
          }
        }
      }
    }
    return out;
  }

  // 多选题：解析 {"judge":{"A":true,"B":false,...},"answer":"AC"} 里的逐选项判断
  function parseJudgeMap(raw, q) {
    const candidates = jsonObjects(raw);
    for (let i = candidates.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(candidates[i]);
        if (!isPlainObject(obj)) continue;
        const map = obj.judge || obj.judges || obj['判断'] || obj['选项判断'];
        if (!isPlainObject(map)) continue;
        const lookup = {};
        Object.keys(map).forEach(k => {
          const letter = String(k).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 1);
          if (letter) lookup[letter] = map[k];
        });
        // judge 必须覆盖全部选项，否则可能只是列了部分正确项，弃用
        if (!q.options.every(o => Object.prototype.hasOwnProperty.call(lookup, o.letter))) continue;
        const picked = q.options.filter(o => isTrueValue(lookup[o.letter])).map(o => o.letter);
        if (picked.length) return picked;
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  // 互斥选项：以上都是 / 以上都不对 / 全部正确……选中它就应清掉其他项
  function isExclusiveOption(text) {
    const t = String(text || '').replace(/[\s，。.,、;；:：!！?？]/g, '');
    if (t.length > 20) return false;
    const m = t.match(/^(?:以上|上述|全部|所有)(?:选项|说法|各项|这些|内容|描述|项目|所有|全部)*(.*)$/);
    if (!m) return false;
    const core = m[1];
    if (/^(?:都|均|全|全部)?(?:是|为)$/.test(core)) return true;
    return /^(?:都|均|全|全部)?(?:是|为)?(?:正确|对|符合|包括|不是|不对|不正确|错误|错|不符合)(?:的)?(?:说法|选项|做法|描述|内容|要求|规定|规范|标准|题意)?$/.test(core);
  }

  function normalizeLetters(letters, q) {
    const picked = letters
      .map(l => q.options.find(o => o.letter === l))
      .filter(Boolean);
    const exclusive = picked.find(o => isExclusiveOption(o.text));
    if (exclusive) return [exclusive.letter];
    const unique = [...new Set(letters)];
    // 单选/判断只保留一个字母，避免连点两个 radio 最后落在错误项上
    if (!q.multi) return [unique[0]];
    return unique.sort();
  }

  function parseAiAnswer(text, q) {
    const raw = String(text || '').trim();
    if (!raw) return [];
    const valid = new Set(q.options.map(o => o.letter));
    const dedupe = arr => [...new Set(arr)].filter(l => valid.has(l));

    // 1) JSON 输出：模型可能先分析再给答案，所以从后往前找最后一个合法 JSON
    const candidates = jsonObjects(raw);
    for (let i = candidates.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(candidates[i]);
        if (!isPlainObject(obj)) continue;
        const value = obj.answer != null ? obj.answer : obj.result != null ? obj.result : obj['答案'];
        if (value == null) continue;
        const letters = dedupe(String(value).toUpperCase().match(/[A-D]/g) || []);
        if (letters.length) return letters;
      } catch (e) { /* 不是 JSON，继续往前找 */ }
    }

    // 2) 显式答案前缀：取最后一次出现的「答案/选项/应选/选择/answer」后面的独立字母串
    const prefixRe = /(?:答案|选项|应选|选择|answer|choose)/gi;
    let prefix = null;
    let hit;
    while ((hit = prefixRe.exec(raw))) prefix = hit;
    if (prefix) {
      const start = prefix.index + prefix[0].length;
      const after = raw.slice(start, start + 48).replace(/\b(?:and|or)\b/gi, ' ');
      const run = after.match(/(?<![A-Za-z])([A-Da-d](?:[\s,，、;；和及/]*[A-Da-d])*)(?![A-Za-z])/);
      if (run) {
        const letters = dedupe(run[1].toUpperCase().match(/[A-D]/g) || []);
        if (letters.length) return letters;
      }
    }

    // 3) 整段只由字母和分隔符组成：A / AB / A,C / A、C
    if (/^[A-Da-d\s,，、;；和及]+$/.test(raw)) {
      const letters = dedupe(raw.toUpperCase().match(/[A-D]/g) || []);
      if (letters.length) return letters;
    }

    // 4) 判断题：正确 / 错误（含 不正确、√、× 等）
    const isJudge = q.options.length === 2
      && q.options.some(o => /正确/.test(o.text))
      && q.options.some(o => /错误/.test(o.text));
    if (isJudge) {
      const neg = /错误|不正确|不对|错的|×|✗/.test(raw);
      const pos = /正确|对的|√|✓/.test(raw);
      if (neg) {
        const hit = q.options.find(o => /错误|错|不正确/.test(o.text));
        if (hit) return [hit.letter];
      }
      if (pos && !neg) {
        const hit = q.options.find(o => /正确|对/.test(o.text));
        if (hit) return [hit.letter];
      }
    }

    // 5) 回显了选项文本：直接按文本匹配
    const byText = q.options
      .filter(o => o.text && o.text.length >= 2 && raw.includes(o.text))
      .map(o => o.letter);
    if (byText.length) return dedupe(byText);

    // 6) 兜底：独立字母（用词边界排除 BECAUSE 这类单词里的 A/C）
    const singles = raw.toUpperCase().match(/(?<![A-Z])[A-D](?![A-Z])/g) || [];
    const letters = dedupe(singles);
    if (letters.length && letters.length <= 2) return letters;

    return [];
  }

  function cacheKey(q) {
    // 接口 + 模型 + 题干 + 选项一起做 key：换模型/改选项后不会复用旧答案
    return 'v3|' + String(CFG.aiBaseUrl || '') + '|' + String(CFG.aiModel || '') + '|'
      + q.stem + '||' + q.options.map(o => o.text).join('||');
  }

  function readAiCache(key) {
    try {
      const all = JSON.parse(localStorage.getItem(AICACHE) || '{}');
      const hit = all[key];
      if (hit && Array.isArray(hit.letters) && hit.letters.length) {
        return { letters: hit.letters, votes: hit.votes || '缓存' };
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  function writeAiCache(key, letters, votes) {
    try {
      const all = JSON.parse(localStorage.getItem(AICACHE) || '{}');
      all[key] = { letters, votes, t: Date.now() };
      const keys = Object.keys(all);
      if (keys.length > 300) delete all[keys[0]];
      localStorage.setItem(AICACHE, JSON.stringify(all));
    } catch (e) { /* ignore */ }
  }

  function buildQuizMessages(q) {
    const options = q.options.map(o => o.letter + '. ' + o.text).join('\n');
    const lesson = pageLessonName();
    const multi = !!q.multi;
    const lines = [];
    if (lesson) lines.push('课程：' + lesson);
    lines.push('题型：' + (q.kindText || '未知'));
    lines.push('题目：' + q.stem);
    lines.push('选项：\n' + options);
    lines.push(multi ? '请逐个选项判断（每个选项都要给结论），最后单独一行输出 JSON：' : '请先逐项简要判断（两三句即可），最后单独一行输出 JSON 答案：');
    return [
      {
        role: 'system',
        content: [
          '你是中国高校「实验室安全准入」考试的答题助手，依据中国大陆高校实验室安全规范、国家标准和通用安全常识作答。',
          '要求：',
          '1. 逐项判断每个选项；题目情境不明确时，选最安全、最规范、最保守的做法。',
          '2. 注意绝对化表述（必须/严禁/所有/任何/一律）在判断题里常是陷阱；遇到「以上都对/以上都不对」要先验证其他选项。',
          '3. 多选题必须选出全部正确项，不漏选、不多选；单选题只选一个。',
          '4. 注意否定问法（错误、不正确、不属于、不包括、除外）：要选的是不符合的选项，不要答成正确项。',
          multi
            ? '5. 这是多选题：逐个选项独立判断，不要因为已选中两项就停止；最后一行只输出 JSON，如 {"judge":{"A":true,"B":false,"C":true,"D":false},"answer":"AC"}。judge 表示「该选项是否应被选中」（否定问法里，应选中的是错误项），必须覆盖全部选项。'
            : '5. 最后一行只输出 JSON，如 {"answer":"A"}；判断题输出正确/错误对应的字母。'
        ].join('\n')
      },
      { role: 'user', content: lines.join('\n') }
    ];
  }

  function askOnce(q, payload) {
    return aiRequest(payload).then(resp => {
      if (resp && resp.error) {
        throw new Error(resp.error.message || JSON.stringify(resp.error).slice(0, 80));
      }
      const choice = resp && resp.choices && resp.choices[0];
      const message = choice && choice.message;
      if (!message) throw new Error('返回结构异常：' + JSON.stringify(resp).slice(0, 80));
      // 部分思考模型会把内容放在 reasoning_content，content 为空
      const content = String(message.content || message.reasoning_content || '').trim();
      if (!content) throw new Error('AI 返回为空');
      // 多选题优先用逐选项判断，缺失时再退回 answer 字段
      const judge = q.multi ? parseJudgeMap(content, q) : null;
      const letters = judge || parseAiAnswer(content, q);
      if (!letters.length) {
        const cut = choice.finish_reason === 'length' ? '；输出被截断，请调大「最大 tokens」' : '';
        throw new Error('无法解析选项：' + content.slice(0, 40) + cut);
      }
      const usage = resp.usage || {};
      const cacheHit = Number(usage.prompt_cache_hit_tokens
        || (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens)
        || 0) || 0;
      return { letters, judge, raw: content, cacheHit };
    });
  }

  function voteLetters(results, total, q) {
    const sets = results.map(r => r.letters);
    if (!sets.length) return { letters: [], agree: 0, total };

    // 多选题：合并逐选项判断。每个样本对 A/B/C/D 都投了票，比只合并最终答案更不容易漏选
    if (q && q.multi) {
      const judged = results.filter(r => Array.isArray(r.judge) && r.judge.length);
      if (judged.length >= 2) {
        const counts = {};
        judged.forEach(r => r.judge.forEach(l => { counts[l] = (counts[l] || 0) + 1; }));
        const need = Math.floor(judged.length / 2) + 1;
        const letters = q.options.map(o => o.letter).filter(l => (counts[l] || 0) >= need);
        if (letters.length) {
          const agree = Math.min(...letters.map(l => counts[l]));
          return { letters, agree, total, counts };
        }
      }
    }

    const counts = new Map();
    sets.forEach(s => {
      const k = s.join('');
      counts.set(k, (counts.get(k) || 0) + 1);
    });
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    // 多数票直接胜出
    if (ranked[0][1] >= 2) {
      return { letters: ranked[0][0].split(''), agree: ranked[0][1], total };
    }
    if (sets.length === 1) return { letters: sets[0].slice(), agree: 1, total };
    // 几次结果只差一项：逐字母过半
    const letterCount = {};
    sets.forEach(s => s.forEach(l => { letterCount[l] = (letterCount[l] || 0) + 1; }));
    const need = Math.floor(sets.length / 2) + 1;
    const letters = Object.keys(letterCount).filter(l => letterCount[l] >= need).sort();
    if (letters.length) {
      const agree = Math.min(...letters.map(l => letterCount[l]));
      return { letters, agree, total, counts: letterCount };
    }
    return { letters: ranked[0][0].split(''), agree: ranked[0][1], total };
  }

  async function aiAnswer(q) {
    const key = cacheKey(q);
    const cached = readAiCache(key);
    if (cached) return { letters: cached.letters, raw: '(缓存)', votes: cached.votes };

    const requested = Math.max(1, Math.min(5, Number(CFG.aiVotes) || 1));
    // 2 = 自适应：先并发问 2 次，一致直接用，不一致再补第 3 次
    const firstCount = requested === 2 ? 2 : requested;
    const maxTokens = Math.max(64, Math.min(8192, Number(CFG.aiMaxTokens) || 1024));
    const base = { max_tokens: maxTokens };
    if (!isReasonerModel()) base.temperature = requested > 1 ? 0.7 : 0;
    const payload = Object.assign(
      {},
      base,
      aiExtraParams(),
      { model: CFG.aiModel, messages: buildQuizMessages(q) }
    );

    const settled = await Promise.allSettled(
      Array.from({ length: firstCount }, () => askOnce(q, payload))
    );
    const ok = settled.filter(r => r.status === 'fulfilled').map(r => r.value);
    if (!ok.length) {
      const first = settled.find(r => r.status === 'rejected');
      throw new Error(first ? first.reason.message : 'AI 请求失败');
    }

    let calls = firstCount;
    const disagree = ok.length < 2 || ok[0].letters.join('') !== ok[1].letters.join('');
    if (requested === 2 && disagree) {
      try {
        ok.push(await askOnce(q, payload));
        calls = 3;
      } catch (e) { /* 第 3 次失败就按前两次算 */ }
    }

    const { letters, agree, total, counts } = voteLetters(ok, calls, q);
    if (!letters.length) throw new Error('没有可用答案');
    const finalLetters = normalizeLetters(letters, q);
    const winner = ok.find(r => r.letters.join('') === finalLetters.join('')) || ok[0];
    const votes = `${agree}/${total}`;
    const cacheHit = ok.reduce((sum, r) => sum + (r.cacheHit || 0), 0);
    writeAiCache(key, finalLetters, votes);
    return { letters: finalLetters, raw: winner.raw, votes, counts, cacheHit };
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

    // DOM 里出现 checkbox 就按多选处理；再兜底看题型文字
    const multi = m.querySelectorAll('.ant-checkbox-wrapper').length > 0 || /多选|多项/.test(kindText);
    return { kindText, stem, options, multi };
  }

  function isChecked(node) {
    return /-checked/.test(node.className) || !!node.querySelector('.ant-checkbox-checked, .ant-radio-checked');
  }

  function chooseOptions(m, letters) {
    const wanted = new Set(letters);
    const multi = !!m.querySelector('.ant-checkbox-wrapper');
    m.querySelectorAll('.ant-radio-wrapper, .ant-checkbox-wrapper').forEach((node, index) => {
      const letterEl = node.querySelector('.letter');
      const letter = letterEl
        ? (letterEl.innerText || '').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 1)
        : ('ABCD'[index] || '');
      const checked = isChecked(node);
      if (wanted.has(letter)) {
        if (!checked) node.click();
      } else if (multi && checked) {
        // 多选题里上一轮误选的项要取消，避免和本轮答案混在一起
        node.click();
      }
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
      let aiRaw = '';
      let aiVotes = '';
      let aiJudge = '';
      let aiCacheHit = 0;

      const fromBank = bankAnswer(q);
      if (fromBank) {
        letters = fromBank.letters;
        source = 'bank';
        setAiStatus(`题库命中 → ${letters.join('')}`);
      } else if (CFG.useAI && CFG.aiBaseUrl && CFG.aiModel) {
        try {
          const result = await aiAnswer(q);
          letters = result.letters;
          aiRaw = result.raw;
          aiVotes = result.votes;
          aiCacheHit = result.cacheHit || 0;
          if (q.multi && result.counts) {
            aiJudge = q.options.map(o => o.letter + (result.counts[o.letter] || 0)).join(' ');
          }
          source = 'ai';
          setAiStatus(`AI ${aiVotes} → ${letters.join('')}｜${String(aiRaw).replace(/\s+/g, ' ').slice(0, 30)}`);
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
        aiVotes,
        aiJudge,
        aiCacheHit,
        aiError,
        aiRaw: aiRaw.slice(0, 200)
      });

      let why = '';
      if (source === 'default') {
        if (!CFG.useAI) why = 'AI 未启用';
        else if (!CFG.aiBaseUrl || !CFG.aiModel) why = 'AI 配置不完整';
        else if (aiError) why = 'AI 失败';
      }
      const tag = source === 'ai' ? `AI${aiVotes ? ' ' + aiVotes : ''}` : source === 'bank' ? '题库' : '默认';
      setStatus(`已作答：${letters.join('')}（${tag}${why ? ' · ' + why : ''}）`);
      console.log('[SAKT] 作答:', q.stem, '→', letters.join(''), source);
    } finally {
      answering = false;
    }
  }

  // ---------------- 切换课时 ----------------
  async function waitForLesson(timeout) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const name = pageLessonName();
      if (name) return name;
      await sleep(250);
    }
    return '';
  }

  async function waitForTree(timeout) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (document.querySelector('.ant-tree-node-content-wrapper')) return true;
      await sleep(250);
    }
    return false;
  }

  async function clickLessonByName(name) {
    await waitForTree(4000);
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

    const target = `/students/courseDetail?graphId=${curGraph()}&id=${item.id}`;
    if (location.pathname + location.search === target) return false;
    try {
      const last = JSON.parse(sessionStorage.getItem('sakt.navGuard') || 'null');
      if (last && last.url === target && Date.now() - last.t < 10000) {
        console.log('[SAKT] 跳过重复跳转:', target);
        return false;
      }
      sessionStorage.setItem('sakt.navGuard', JSON.stringify({ url: target, t: Date.now() }));
    } catch (e) { /* ignore */ }
    location.href = target;
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
    if (state.starting) return;
    state.starting = true;
    try {
      const q = await ensureQueue();
      if (!q.items.length) {
        setStatus('没有未学课时');
        return;
      }

      const currentName = await waitForLesson(8000);
      const current = clean(currentName);
      if (current) {
        const inQueue = q.items.some(x => clean(x.name) === current);
        if (!inQueue) {
          setStatus('当前课时已学完，跳转到：' + clean(q.items[0].name));
          await goToLesson(q.items[0]);
          await sleep(1500);
        }
      } else {
        setStatus('课程信息加载中，先播放当前视频');
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
    } finally {
      state.starting = false;
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
  const state = {
    running: false,
    starting: false,
    tab: 'run',
    status: '',
    examRunning: false,
    examStop: false,
    examSeen: false,
    examStatus: ''
  };
  const el = {};

  // ---------------- 考试页 ----------------
  function examActive() {
    const box = document.querySelector('.question-content');
    if (!box || !box.querySelector('.stem')) return false;
    return [...document.querySelectorAll('p.remark')].some(p => (p.innerText || '').includes('倒计时'));
  }

  function examInfo() {
    if (!examActive()) return null;
    const remark = [...document.querySelectorAll('p.remark')].find(p => (p.innerText || '').includes('倒计时'));
    const text = remark ? remark.innerText.replace(/\s+/g, ' ') : '';
    const navs = [...document.querySelectorAll('.index-num')];
    const total = Number((text.match(/共\s*(\d+)\s*题/) || [])[1]) || navs.length;
    const timer = (text.match(/倒计时[：:]\s*([\d:]+)/) || [])[1] || '';
    const idx = Number((document.querySelector('.index-num.active-num') || {}).innerText || 0);
    const answered = navs.filter(n => n.querySelector('.ant-badge-status-success')).length;
    return { total, timer, idx, answered };
  }

  function readExamQuestion() {
    const box = document.querySelector('.question-content');
    if (!box) return null;
    const stemEl = box.querySelector('.stem');
    const kindText = ((box.querySelector('.stem .grey') || {}).innerText || '').replace(/[()（）]/g, '').trim();
    const stem = String(stemEl ? stemEl.innerText : '')
      .replace(/^第\s*\d+\s*题\s*[：:]\s*/, '')
      .replace(/^[（(][^）)]*[）)]\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
    const wrappers = [...box.querySelectorAll('.ant-checkbox-wrapper, .ant-radio-wrapper')];
    const options = [];
    wrappers.forEach(w => {
      const input = w.querySelector('input');
      const letter = String((input && input.value) || '').toUpperCase();
      if (!letter) return;
      const parent = w.parentElement;
      let text = parent && parent.querySelector('.ml6') ? parent.querySelector('.ml6').innerText : '';
      if (!text && parent) text = parent.innerText.replace(/^\s*[A-Za-z]\s*[：:]\s*/, '');
      options.push({ letter, text: String(text || '').replace(/\s+/g, ' ').trim() });
    });
    const multi = !!box.querySelector('.ant-checkbox-group') || /多选|多项/.test(kindText);
    const checked = wrappers
      .filter(w => w.querySelector('input') && w.querySelector('input').checked)
      .map(w => String(w.querySelector('input').value).toUpperCase());
    return { kindText, stem, options, multi, checked };
  }

  async function examGoTo(i) {
    const active = () => (document.querySelector('.index-num.active-num') || {}).innerText.trim();
    if (active() === String(i)) return true;
    const node = [...document.querySelectorAll('.index-num')].find(n => (n.innerText || '').trim() === String(i));
    if (!node) return false;
    node.click();
    for (let k = 0; k < 40; k++) {
      await sleep(100);
      if (active() === String(i)) return true;
    }
    return false;
  }

  async function examChoose(letters) {
    const box = () => document.querySelector('.question-content');
    if (!box()) return false;
    const multi = !!box().querySelector('.ant-checkbox-group');
    const find = letter => [...box().querySelectorAll('.ant-checkbox-wrapper, .ant-radio-wrapper')]
      .find(w => String((w.querySelector('input') || {}).value || '').toUpperCase() === letter);

    if (multi) {
      const all = [...box().querySelectorAll('.ant-checkbox-wrapper')];
      for (const w of all) {
        const letter = String((w.querySelector('input') || {}).value || '').toUpperCase();
        if (!letters.includes(letter) && w.querySelector('input').checked) {
          const fresh = find(letter);
          if (fresh) fresh.click();
          await sleep(120);
        }
      }
    }
    for (const letter of letters) {
      let ok = false;
      // 每次重新查节点并确认真的勾上：Vue 会在勾选后重渲染，旧节点再点可能不生效
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        const w = find(letter);
        if (!w) break;
        if (w.querySelector('input').checked) { ok = true; break; }
        w.click();
        for (let k = 0; k < 8; k++) {
          await sleep(60);
          const cur = find(letter);
          if (cur && cur.querySelector('input').checked) { ok = true; break; }
        }
      }
    }
    return true;
  }

  function logExam(entry) {
    try {
      const log = JSON.parse(localStorage.getItem(EXAMLOG) || '[]');
      log.push(entry);
      localStorage.setItem(EXAMLOG, JSON.stringify(log.slice(-200)));
    } catch (e) { /* ignore */ }
  }

  function setExamStatus(text) {
    state.examStatus = text;
    if (el.examStatus) el.examStatus.textContent = text;
  }

  function renderExam() {
    if (!el.examTitle) return;
    const info = examInfo();
    if (!info) {
      el.examTitle.textContent = '未检测到进行中的考试';
      el.examProgress.textContent = '-';
      el.examTimer.textContent = '-';
      return;
    }
    el.examTitle.textContent = `共 ${info.total} 题`;
    el.examProgress.textContent = `${info.answered}/${info.total} 已答 · 当前第 ${info.idx} 题`;
    el.examTimer.textContent = info.timer || '-';
  }

  function renderExamActions() {
    if (!el.examActions) return;
    if (state.examRunning) {
      el.examActions.innerHTML = '<button class="sakt-btn ghost" id="sakt-exam-stop">停止</button>';
      $('#sakt-exam-stop', el.examActions).addEventListener('click', stopExam);
    } else {
      el.examActions.innerHTML = '<button class="sakt-btn solid" id="sakt-exam-start">开始自动答题</button>';
      $('#sakt-exam-start', el.examActions).addEventListener('click', startExam);
    }
  }

  function stopExam() {
    state.examStop = true;
    setExamStatus('正在停止…');
  }

  async function submitExam() {
    const btn = [...document.querySelectorAll('button')].find(b => (b.innerText || '').replace(/\s+/g, '') === '提交');
    if (!btn) { setExamStatus('找不到「提交」按钮，请手动提交'); return; }
    btn.click();
    await sleep(800);
    const modal = document.querySelector('.ant-modal');
    if (!modal) { setExamStatus('已点击提交，请在页面上确认结果'); return; }
    const ok = [...modal.querySelectorAll('button')].find(b => /^(确定|确认|是|提交|继续提交|仍然提交|仍要提交)$/.test((b.innerText || '').replace(/\s+/g, '')));
    if (ok) { ok.click(); setExamStatus('已提交试卷'); return; }
    setExamStatus('提交弹窗未找到确定按钮，请手动确认');
  }

  async function startExam() {
    if (state.examRunning) return;
    const info = examInfo();
    if (!info) { setExamStatus('未检测到进行中的考试'); return; }
    if (!CFG.useAI || !CFG.aiBaseUrl || !CFG.aiModel) {
      const go = window.confirm(`AI 未配置，将用默认选项（${CFG.answerFirst || 'A'}）作答，确定继续？`);
      if (!go) return;
    }
    state.examRunning = true;
    state.examStop = false;
    renderExamActions();
    const total = info.total;
    let answered = 0;
    let failed = 0;
    setExamStatus(`开始自动答题：共 ${total} 题`);
    try {
      for (let i = 1; i <= total; i++) {
        if (state.examStop) break;
        if (!(await examGoTo(i))) {
          failed++;
          setExamStatus(`第 ${i} 题定位失败，跳过`);
          continue;
        }
        let q = readExamQuestion();
        for (let k = 0; k < 20 && (!q || !q.options.length); k++) {
          await sleep(100);
          q = readExamQuestion();
        }
        if (!q || !q.options.length) { failed++; continue; }
        if (q.checked.length) {
          answered++;
          setExamStatus(`第 ${i}/${total} 题已答，跳过`);
          renderExam();
          continue;
        }

        let letters = [];
        let source = 'default';
        let votes = '';
        let err = '';
        let cacheHit = 0;
        const fromBank = bankAnswer(q);
        if (fromBank) {
          letters = fromBank.letters;
          source = 'bank';
        } else if (CFG.useAI && CFG.aiBaseUrl && CFG.aiModel) {
          try {
            const r = await aiAnswer(q);
            letters = r.letters;
            votes = r.votes;
            cacheHit = r.cacheHit || 0;
            source = 'ai';
          } catch (e) {
            err = e.message;
          }
        }
        if (!letters.length) letters = [CFG.answerFirst || 'A'];
        await examChoose(letters);
        await sleep(200);
        let picked = (readExamQuestion() || {}).checked || [];
        if (!picked.length) {
          await examChoose(letters);
          await sleep(300);
          picked = (readExamQuestion() || {}).checked || [];
        }
        if (!picked.length) failed++;
        answered++;
        logExam({
          t: Date.now(),
          idx: i,
          kind: q.kindText,
          stem: q.stem.slice(0, 160),
          picked,
          source,
          votes,
          cacheHit,
          err
        });
        const tag = source === 'ai' ? `AI ${votes}` : source === 'bank' ? '题库' : '默认';
        setExamStatus(`第 ${i}/${total} 题 → ${picked.join('') || letters.join('')}（${tag}${err ? ' · ' + err : ''}）`);
        renderExam();
        if (i < total) await sleep(500 + Math.random() * 400);
      }

      if (state.examStop) {
        setExamStatus(`已停止：本次答了 ${answered}/${total} 题`);
      } else if (CFG.examAutoSubmit) {
        setExamStatus(`已答完 ${answered}/${total} 题，正在提交…`);
        await submitExam();
      } else {
        setExamStatus(`已答完 ${answered}/${total} 题${failed ? `，${failed} 题失败` : ''}，请检查后手动提交`);
      }
    } catch (e) {
      setExamStatus('考试答题中断：' + e.message);
    } finally {
      state.examRunning = false;
      renderExamActions();
      renderExam();
    }
  }

  function startExamWatch() {
    setInterval(() => {
      if (!document.getElementById('sakt-panel')) return;
      if (!examActive()) return;
      if (!state.examSeen) {
        state.examSeen = true;
        switchTab('exam');
        renderExamActions();
      }
      if (state.tab === 'exam') renderExam();
    }, 1000);
  }

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
        cursor: move;
        user-select: none;
        touch-action: none;
      }
      #sakt-panel.dragging {
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.18);
      }
      #sakt-panel .sakt-head-right {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      #sakt-panel .sakt-min {
        width: 18px;
        height: 18px;
        padding: 0;
        border: 0;
        background: transparent;
        color: #999999;
        font-size: 14px;
        line-height: 16px;
        cursor: pointer;
      }
      #sakt-panel .sakt-min:hover {
        color: #111111;
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
        max-height: 62vh;
        overflow-y: auto;
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
      #sakt-panel.min {
        width: auto;
        min-width: 148px;
      }
      #sakt-panel.min .sakt-head {
        border-bottom: 0;
      }
      #sakt-panel.min .sakt-tabs,
      #sakt-panel.min .sakt-page,
      #sakt-panel.min .sakt-page.active {
        display: none;
      }
    `;
    document.head.appendChild(style);
  }

  function setupPanelUI(root) {
    const head = $('.sakt-head', root);
    const minBtn = $('#sakt-min', root);
    if (!head || !minBtn) return;
    const KEY = 'sakt.panelUI';

    const clamp = (left, top) => {
      const w = root.offsetWidth;
      const h = root.offsetHeight;
      const maxLeft = Math.max(0, window.innerWidth - w);
      const maxTop = Math.max(0, window.innerHeight - h);
      return { left: Math.min(Math.max(0, left), maxLeft), top: Math.min(Math.max(0, top), maxTop) };
    };
    const place = (left, top) => {
      root.style.left = left + 'px';
      root.style.top = top + 'px';
      root.style.right = 'auto';
      root.style.bottom = 'auto';
    };
    const save = () => {
      try {
        const r = root.getBoundingClientRect();
        localStorage.setItem(KEY, JSON.stringify({
          left: Math.round(r.left),
          top: Math.round(r.top),
          min: root.classList.contains('min')
        }));
      } catch (e) { /* ignore */ }
    };
    const setMin = (on, persist) => {
      root.classList.toggle('min', on);
      minBtn.textContent = on ? '+' : '−';
      minBtn.title = on ? '展开' : '最小化';
      if (root.style.left) {
        const r = root.getBoundingClientRect();
        const c = clamp(r.left, r.top);
        place(c.left, c.top);
      }
      if (persist) save();
    };

    // 恢复上次的位置和最小化状态
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (saved && typeof saved === 'object') {
        if (saved.min) root.classList.add('min');
        if (Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
          const c = clamp(saved.left, saved.top);
          place(c.left, c.top);
        }
      }
    } catch (e) { /* ignore */ }
    minBtn.textContent = root.classList.contains('min') ? '+' : '−';
    minBtn.title = root.classList.contains('min') ? '展开' : '最小化';

    let drag = null;
    head.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      if (e.target.closest('button, input, select, a')) return;
      const r = root.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
      try { head.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      root.classList.add('dragging');
      e.preventDefault();
    });
    head.addEventListener('pointermove', e => {
      if (!drag) return;
      const c = clamp(e.clientX - drag.dx, e.clientY - drag.dy);
      place(c.left, c.top);
      drag.moved = true;
    });
    const endDrag = e => {
      if (!drag) return;
      if (drag.moved) save();
      drag = null;
      root.classList.remove('dragging');
      try { head.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    };
    head.addEventListener('pointerup', endDrag);
    head.addEventListener('pointercancel', endDrag);

    minBtn.addEventListener('click', e => {
      e.stopPropagation();
      setMin(!root.classList.contains('min'), true);
    });

    window.addEventListener('resize', () => {
      if (!root.style.left) return;
      const r = root.getBoundingClientRect();
      const c = clamp(r.left, r.top);
      place(c.left, c.top);
    });
  }

  function buildPanel() {
    injectCSS();
    const root = document.createElement('div');
    root.id = 'sakt-panel';
    root.innerHTML = `
      <div class="sakt-head">
        <span class="sakt-title"><b>SAKT</b><i>自动学习</i></span>
        <span class="sakt-head-right">
          <span class="sakt-dot" id="sakt-dot">●</span>
          <button class="sakt-min" id="sakt-min" type="button" title="最小化">−</button>
        </span>
      </div>
      <div class="sakt-tabs">
        <button class="sakt-tab active" data-tab="run">运行</button>
        <button class="sakt-tab" data-tab="cfg">设置</button>
        <button class="sakt-tab" data-tab="ai">AI</button>
        <button class="sakt-tab" data-tab="exam">考试</button>
        <button class="sakt-tab" data-tab="bank">题库</button>
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
        <label class="sakt-field"><span>超时(ms)</span><input type="number" id="sakt-timeout" min="3000" max="180000" step="1000"></label>
        <label class="sakt-field"><span>最大 tokens</span><input type="number" id="sakt-maxtokens" min="64" max="8192" step="64"></label>
        <label class="sakt-field"><span>投票次数</span>
          <select id="sakt-votes">
            <option value="1">1 次（快）</option>
            <option value="2">2+1 次（推荐）</option>
            <option value="3">3 次（固定）</option>
            <option value="5">5 次（最准）</option>
          </select>
        </label>
        <label class="sakt-field"><span>额外参数</span><input type="text" id="sakt-extra" placeholder='{"reasoning_effort":"high"}'></label>
        <div class="sakt-actions">
          <button class="sakt-btn solid" id="sakt-save-ai">保存</button>
          <button class="sakt-btn ghost" id="sakt-test-ai">测试连接</button>
          <button class="sakt-btn ghost" id="sakt-clear-cache">清空缓存</button>
        </div>
        <div class="sakt-status" id="sakt-ai-status"></div>
        <div class="sakt-hint">OpenAI 兼容接口（DeepSeek、通义千问、Kimi 等均可）。Key 只存在本机 localStorage。开思考模式请把「最大 tokens」调到 1024 以上；不同厂商的思考/联网参数可写在「额外参数」里，脚本原样透传。投票「2+1」= 先并发问 2 次，答案一致直接用，不一致再补第 3 次；命中本地缓存时 0 次请求。</div>
      </div>
      <div class="sakt-page" data-page="exam">
        <div class="sakt-row"><span class="sakt-muted">试卷</span><span class="sakt-value" id="sakt-exam-title">-</span></div>
        <div class="sakt-row"><span class="sakt-muted">进度</span><span class="sakt-value" id="sakt-exam-progress">-</span></div>
        <div class="sakt-row"><span class="sakt-muted">倒计时</span><span class="sakt-value" id="sakt-exam-timer">-</span></div>
        <label class="sakt-field"><span>答完自动提交</span><input type="checkbox" id="sakt-exam-submit"></label>
        <div class="sakt-actions" id="sakt-exam-actions"></div>
        <div class="sakt-status" id="sakt-exam-status"></div>
        <div class="sakt-hint">先在考试列表点「开始考试」进入答题页，再点「开始自动答题」。脚本按题号顺序作答，已答的题会跳过；默认不自动提交。模拟考试不计成绩，正式考试请自行确认风险。</div>
      </div>
      <div class="sakt-page" data-page="bank">
        <div class="sakt-row"><span class="sakt-muted">题库</span><span class="sakt-value" id="sakt-bank-info">未导入</span></div>
        <label class="sakt-field"><span>优先题库</span><input type="checkbox" id="sakt-bank-use"></label>
        <div class="sakt-actions">
          <button class="sakt-btn solid" id="sakt-bank-import">导入 JSON</button>
          <button class="sakt-btn ghost" id="sakt-bank-clear">清除</button>
        </div>
        <input type="file" id="sakt-bank-file" accept=".json,application/json" style="display:none">
        <div class="sakt-status" id="sakt-bank-status"></div>
        <div class="sakt-hint">导入从题库页导出的 sakt-bank.json。命中题库时直接用平台标准答案，未命中再问 AI。题库只存本机 localStorage，不会上传。</div>
      </div>
    `;
    document.body.appendChild(root);
    setupPanelUI(root);

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
    el.maxtokens = $('#sakt-maxtokens', root);
    el.votes = $('#sakt-votes', root);
    el.extra = $('#sakt-extra', root);
    el.examTitle = $('#sakt-exam-title', root);
    el.examProgress = $('#sakt-exam-progress', root);
    el.examTimer = $('#sakt-exam-timer', root);
    el.examSubmit = $('#sakt-exam-submit', root);
    el.examActions = $('#sakt-exam-actions', root);
    el.examStatus = $('#sakt-exam-status', root);
    el.bankInfo = $('#sakt-bank-info', root);
    el.bankUse = $('#sakt-bank-use', root);
    el.bankStatus = $('#sakt-bank-status', root);
    el.bankFile = $('#sakt-bank-file', root);

    el.rate.value = CFG.rate;
    el.muted.checked = !!CFG.muted;
    el.autoanswer.checked = !!CFG.autoAnswer;
    el.autonext.checked = !!CFG.autoNext;
    el.first.value = CFG.answerFirst || 'A';
    el.useai.checked = !!CFG.useAI;
    el.baseurl.value = CFG.aiBaseUrl || '';
    el.apikey.value = CFG.aiKey || '';
    el.model.value = CFG.aiModel || '';
    el.timeout.value = CFG.aiTimeout || DEFAULTS.aiTimeout;
    el.maxtokens.value = CFG.aiMaxTokens || DEFAULTS.aiMaxTokens;
    el.votes.value = String(CFG.aiVotes || DEFAULTS.aiVotes);
    el.extra.value = CFG.aiExtra || '';
    el.examSubmit.checked = !!CFG.examAutoSubmit;
    el.bankUse.checked = !!CFG.bankFirst;

    $('#sakt-save-cfg', root).addEventListener('click', saveSettings);
    $('#sakt-save-ai', root).addEventListener('click', saveAiSettings);
    $('#sakt-test-ai', root).addEventListener('click', testAi);
    $('#sakt-clear-cache', root).addEventListener('click', () => {
      localStorage.removeItem(AICACHE);
      setAiStatus('AI 答案缓存已清空，下道题会重新请求');
    });
    el.examSubmit.addEventListener('change', () => {
      CFG.examAutoSubmit = el.examSubmit.checked;
      saveConfig();
      setExamStatus(CFG.examAutoSubmit ? '答完试卷后会自动点提交' : '答完试卷后不自动提交');
    });
    $('#sakt-bank-import', root).addEventListener('click', () => el.bankFile.click());
    el.bankFile.addEventListener('change', () => {
      importBank(el.bankFile.files && el.bankFile.files[0]);
      el.bankFile.value = '';
    });
    $('#sakt-bank-clear', root).addEventListener('click', () => {
      localStorage.removeItem(BANK_KEY);
      bankIndex = null;
      bankMeta = null;
      setBankStatus('题库已清除');
      renderBank();
    });
    el.bankUse.addEventListener('change', () => {
      CFG.bankFirst = el.bankUse.checked;
      saveConfig();
      setBankStatus(CFG.bankFirst ? '命中题库时优先用平台答案' : '已关闭题库优先，全部交给 AI');
    });

    renderActions();
    renderStatus();
    renderExamActions();
    renderExam();
    renderBank();
  }

  function switchTab(name) {
    state.tab = name;
    document.querySelectorAll('#sakt-panel .sakt-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tab === name);
    });
    document.querySelectorAll('#sakt-panel .sakt-page').forEach(page => {
      page.classList.toggle('active', page.dataset.page === name);
    });
    if (name === 'exam') {
      renderExam();
      renderExamActions();
    }
    if (name === 'bank') renderBank();
  }

  function setStatus(text) {
    state.status = text;
    if (el.status) el.status.textContent = text;
  }

  function setAiStatus(text) {
    if (el.aiStatus) el.aiStatus.textContent = text;
  }

  function setBankStatus(text) {
    if (el.bankStatus) el.bankStatus.textContent = text;
  }

  function renderBank() {
    if (!el.bankInfo) return;
    if (!loadBank()) {
      el.bankInfo.textContent = '未导入';
      return;
    }
    const meta = bankMeta || {};
    const stems = meta.stems || (bankIndex ? bankIndex.size : 0);
    const variants = meta.variants || 0;
    el.bankInfo.textContent = `${stems} 题 · ${variants} 条`;
  }

  function importBank(file) {
    if (!file) return;
    setBankStatus('读取中…');
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result || ''));
        if (!data || !Array.isArray(data.questions) || !data.questions.length) {
          throw new Error('缺少 questions 数组');
        }
        if (data.questions.length > 20000) throw new Error('题目数量异常');
        const raw = JSON.stringify(data);
        if (raw.length > 4 * 1024 * 1024) throw new Error('文件过大（>4MB）');
        try {
          localStorage.setItem(BANK_KEY, raw);
        } catch (e) {
          throw new Error('本地存储空间不足，请先清除旧题库');
        }
        bankIndex = null;
        bankMeta = null;
        const stems = data.meta && data.meta.stems ? data.meta.stems : data.questions.length;
        setBankStatus(`已导入 ${data.questions.length} 条 / ${stems} 个题干`);
        renderBank();
      } catch (e) {
        setBankStatus('导入失败：' + e.message);
      }
    };
    reader.onerror = () => setBankStatus('读取文件失败');
    reader.readAsText(file);
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
    CFG.aiTimeout = Number.isFinite(t) && t >= 3000 && t <= 180000 ? Math.round(t) : DEFAULTS.aiTimeout;
    const mt = Number(el.maxtokens.value);
    CFG.aiMaxTokens = Number.isFinite(mt) && mt >= 64 && mt <= 8192 ? Math.round(mt) : DEFAULTS.aiMaxTokens;
    const v = Number(el.votes.value);
    CFG.aiVotes = [1, 2, 3, 5].includes(v) ? v : DEFAULTS.aiVotes;
    CFG.aiExtra = el.extra.value.trim();
    saveConfig();

    let note = '';
    if (CFG.aiExtra) {
      try {
        if (!isPlainObject(JSON.parse(CFG.aiExtra))) note = '（额外参数必须是 JSON 对象，已忽略）';
      } catch (e) {
        note = '（额外参数不是合法 JSON，已忽略）';
      }
    }
    setAiStatus('AI 设置已保存' + note);
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
      const maxTokens = Math.max(256, Math.min(2048, Number(CFG.aiMaxTokens) || 1024));
      const base = { max_tokens: maxTokens };
      if (!isReasonerModel()) base.temperature = 0;
      const resp = await aiRequest(Object.assign(
        {},
        base,
        aiExtraParams(),
        { model: CFG.aiModel, messages: [{ role: 'user', content: '请只输出数字 1' }] }
      ));
      if (resp && resp.error) {
        throw new Error(resp.error.message || JSON.stringify(resp.error).slice(0, 80));
      }
      const choice = resp && resp.choices && resp.choices[0];
      const message = choice && choice.message;
      if (!message) throw new Error('返回结构异常：' + JSON.stringify(resp).slice(0, 80));
      const text = String(message.content || message.reasoning_content || '').trim();
      const u = resp.usage || {};
      const usage = u.total_tokens ? `，${u.total_tokens} tokens` : '';
      const cached = Number(u.prompt_cache_hit_tokens
        || (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens)
        || 0) || 0;
      const cacheText = cached ? `，缓存命中 ${cached} tokens` : '';
      const cut = choice.finish_reason === 'length' ? '（输出被截断，请调大「最大 tokens」）' : '';
      setAiStatus(`模型已回复（${Date.now() - started}ms${usage}${cacheText}）：「${text || '(空)'}」${cut}`);
    } catch (e) {
      setAiStatus('失败：' + e.message);
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
        <button class="sakt-btn ghost" id="sakt-relearn">重修错题</button>
      `;
      $('#sakt-start', el.actions).addEventListener('click', start);
      $('#sakt-relearn', el.actions).addEventListener('click', relearn);
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
  function autoGuard() {
    const now = Date.now();
    let g = { t: now, n: 1 };
    try {
      const saved = JSON.parse(sessionStorage.getItem('sakt.autoGuard') || 'null');
      if (saved && now - saved.t < 60000) {
        g = { t: saved.t, n: saved.n + 1 };
      }
    } catch (e) { /* ignore */ }
    sessionStorage.setItem('sakt.autoGuard', JSON.stringify(g));
    return g.n;
  }

  W.__saktStart = start;
  W.__saktStop = stop;
  W.__saktParse = parseAiAnswer;
  W.__saktAsk = aiAnswer;
  W.__saktExamRead = readExamQuestion;
  W.__saktExamStart = startExam;
  W.__saktExamStop = stopExam;
  W.__saktBank = bankAnswer;
  W.__saktNormStem = normStem;
  W.__saktNormText = normText;
  W.__saktScanWrong = scanWrongLessons;
  W.__saktRelearn = relearn;

  (async () => {
    buildPanel();
    startExamWatch();
    if (!curGraph() || !curId()) {
      setStatus('请在课程学习页使用');
      return;
    }
    try {
      const q = await ensureQueue();
      if (!q.items.length) setStatus('没有未学课时');
      if (localStorage.getItem(AUTO) === '1' && q.items.length) {
        const loads = autoGuard();
        if (loads <= 3) {
          console.log('[SAKT] 检测到未完成队列，自动继续');
          await start();
        } else {
          setStatus('检测到页面反复刷新，已暂停自动启动，请点「开始」');
          console.warn('[SAKT] 60 秒内整页加载超过 3 次，已停止自动启动');
        }
      }
    } catch (e) {
      setStatus('课程目录读取失败：' + e.message);
      console.error('[SAKT] 初始化失败:', e);
    }
  })();
})();