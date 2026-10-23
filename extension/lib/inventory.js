// 注入页面执行的函数。注意：这些函数会被 chrome.scripting.executeScript 序列化后注入，
// 所以内部不能引用本模块的其他变量，所有工具函数都必须写在函数体内部。

/**
 * 收集当前视口内"可能被点击/需要识别"的元素，并给每个元素打上 data-zhunxing-id 编号。
 * 返回 { url, title, viewport, dialogs, signature, items }
 */
export function collectInventory(opts) {
  const options = opts || {};
  const maxItems = Math.max(20, Math.min(500, options.maxItems || 300));
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;

  const norm = (value, max) => {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    if (max && text.length > max) return text.slice(0, max) + '…';
    return text;
  };
  const toHex = (color) => {
    if (!color || color === 'transparent' || color === 'rgba(0, 0, 0, 0)') return '';
    const match = String(color).match(/rgba?\(([^)]+)\)/);
    if (!match) return '';
    const parts = match[1].split(',').map((part) => parseFloat(part.trim()));
    if (parts.length >= 4 && parts[3] < 0.12) return '';
    const hex = (n) => Math.round(Math.max(0, Math.min(255, n || 0))).toString(16).padStart(2, '0');
    return `#${hex(parts[0])}${hex(parts[1])}${hex(parts[2])}`;
  };
  const styleCache = new Map();
  const styleOf = (el) => {
    let style = styleCache.get(el);
    if (!style) {
      style = getComputedStyle(el);
      styleCache.set(el, style);
    }
    return style;
  };
  const isVisible = (el, rect) => {
    if (!rect || rect.width < 2 || rect.height < 2) return false;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= vh || rect.left >= vw) return false;
    const style = styleOf(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (parseFloat(style.opacity || '1') < 0.05) return false;
    return true;
  };
  const tagOf = (el) => String(el.tagName || '').toLowerCase();
  const textOf = (el) => {
    const tag = tagOf(el);
    if (tag === 'input') {
      const type = String(el.getAttribute('type') || 'text').toLowerCase();
      const direct = norm(el.getAttribute('aria-label') || el.getAttribute('title') || '', 60);
      if (type === 'checkbox' || type === 'radio') {
        const labelText = el.labels && el.labels.length ? norm(el.labels[0].innerText || '', 60) : '';
        return direct || labelText || (type === 'radio' ? '（单选框）' : '（勾选框）');
      }
      if (type === 'button' || type === 'submit') return direct || norm(el.value || '', 60) || '（按钮）';
      const text = norm(el.value || el.getAttribute('placeholder') || direct, 60);
      return text || '（输入框）';
    }
    if (tag === 'select') {
      const option = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
      return norm((option && option.text) || el.getAttribute('aria-label') || '', 60);
    }
    if (tag === 'textarea') {
      return norm(el.value || el.getAttribute('placeholder') || '', 60) || '（输入框）';
    }
    const direct = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt');
    if (direct) return norm(direct, 60);
    return norm(el.innerText || el.textContent || '', 60);
  };
  const rowOf = (el) => {
    let node = el;
    for (let i = 0; i < 8 && node; i += 1) {
      const tag = tagOf(node);
      const role = node.getAttribute && node.getAttribute('role');
      const cls = String(node.className || '');
      if (tag === 'tr' || role === 'row' || tag === 'li' || /(^|\s)(row|ant-table-row|el-table__row)(\s|$)/.test(cls)) {
        const text = norm(node.innerText || '', 80);
        if (text) return text;
      }
      node = node.parentElement;
    }
    return '';
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = tagOf(el);
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = String(el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button') return 'button';
      return 'textbox';
    }
    if (tag === 'tr') return 'row';
    if (tag === 'td' || tag === 'th') return 'gridcell';
    return '';
  };
  const statusOf = (el) => {
    const parts = [];
    const tag = tagOf(el);
    if (tag === 'input' || tag === 'textarea' || el.isContentEditable) parts.push('editable');
    if (tag === 'select') parts.push('select');
    if (tag === 'input') {
      const type = String(el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') parts.push('checkbox');
      if (type === 'radio') parts.push('radio');
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled');
    if (el.checked || el.getAttribute('aria-checked') === 'true') parts.push('checked');
    if (el.getAttribute('aria-selected') === 'true') parts.push('selected');
    const cls = String(el.className || '');
    if (/(^|\s|-)(active|selected|current|checked|today)(\s|$|-)/.test(cls)) parts.push('selected');
    return parts.join(',') || '-';
  };
  const isCovered = (el, rect) => {
    const x = Math.min(Math.max(rect.left + rect.width / 2, 0), Math.max(vw - 1, 0));
    const y = Math.min(Math.max(rect.top + rect.height / 2, 0), Math.max(vh - 1, 0));
    const hit = document.elementFromPoint(x, y);
    if (!hit) return 0;
    return hit === el || el.contains(hit) || (hit.contains && hit.contains(el)) ? 0 : 1;
  };
  const classOf = (el) => {
    const raw = typeof el.className === 'string' ? el.className : el.getAttribute('class') || '';
    return norm(raw, 80);
  };

  // 清掉上一轮编号
  document.querySelectorAll('[data-zhunxing-id]').forEach((el) => el.removeAttribute('data-zhunxing-id'));

  const interactiveSelector = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]', '[role="option"]',
    '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="combobox"]', '[role="gridcell"]',
    '[onclick]', '[tabindex]:not([tabindex="-1"])',
    '[class*="btn"]', '[class*="Btn"]', '[class*="button"]', '[class*="Button"]',
    '[class*="ant-picker"]', '[class*="ant-select"]', '[class*="el-button"]',
  ].join(',');
  const cellSelector = ['td', 'th', '[class*="date"]', '[class*="Date"]', '[class*="day"]', '[class*="Day"]', '[class*="calendar"]', '[class*="Calendar"]', '[class*="cell"]', '[class*="Cell"]'].join(',');
  const textSelector = 'div,span,p,li,em,i,b,strong,label,dt,dd';

  const candidates = [];
  const seen = new Set();
  const addCandidate = (el, priority, allowLarge = false) => {
    if (!el || seen.has(el)) return;
    const tag = tagOf(el);
    if (['script', 'style', 'noscript', 'head', 'html', 'body'].includes(tag)) return;
    const rect = el.getBoundingClientRect();
    if (!isVisible(el, rect)) return;
    // 非交互的大块元素（日历容器、面板、表格外层）不放进清单，避免模型点"整块容器"
    const isInteractive = priority === 0;
    const isTablePart = ['td', 'th', 'tr'].includes(tag);
    const huge = rect.width * rect.height > 240 * 160;
    if (!isInteractive && !isTablePart && !allowLarge && huge) return;
    if (!allowLarge && rect.width * rect.height > 0.55 * vw * vh && !isInteractive) return;
    if (!isInteractive && !isTablePart && !allowLarge) {
      const roughText = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (roughText.length > 18) return; // 整行日期、面板文案等容器，不参与点击
    }
    const cls = String(el.className || '');
    const isChartEl = ['canvas', 'svg'].includes(tag) || /chart|echarts|graph/i.test(cls);
    seen.add(el);
    candidates.push({ el, priority, rect, chart: isChartEl });
  };

  document.querySelectorAll(interactiveSelector).forEach((el) => addCandidate(el, 0));
  document.querySelectorAll(cellSelector).forEach((el) => addCandidate(el, 1));
  // 图表类容器（canvas/svg/echarts 等）允许大尺寸，供模型计算坐标点
  document.querySelectorAll('canvas, svg, [class*="chart"], [class*="Chart"], [class*="echarts"], [class*="graph"]').forEach((el) => addCandidate(el, 1, true));

  let scanned = 0;
  const textNodes = document.querySelectorAll(textSelector);
  for (const el of textNodes) {
    scanned += 1;
    if (scanned > 12000) break;
    if (seen.has(el)) continue;
    const rect = el.getBoundingClientRect();
    if (!isVisible(el, rect)) continue;
    const text = norm(el.innerText || el.textContent || '', 20);
    const cls = classOf(el);
    const style = styleOf(el);
    const isDateLike = /^(\d{1,2}[日号]?|今天|今日|周[一二三四五六日天]|星期[一二三四五六日天])$/.test(text);
    const isSmallColored = rect.width <= 64 && rect.height <= 64 && (toHex(style.backgroundColor) || '') !== '';
    const hasStatusClass = /red|green|gray|grey|danger|success|disabled|selected|active|today|weekend|holiday|filled|unfilled|unpaid/i.test(cls);
    const isPointer = style.cursor === 'pointer';
    const isOptionLike = isPointer && text.length > 0 && text.length <= 24 && rect.width * rect.height <= 260 * 90;
    if (isDateLike || isSmallColored || hasStatusClass || isOptionLike) addCandidate(el, 2);
  }

  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (Math.abs(a.rect.top - b.rect.top) > 4) return a.rect.top - b.rect.top;
    return a.rect.left - b.rect.left;
  });
  const picked = candidates.slice(0, maxItems);
  picked.sort((a, b) => {
    if (Math.abs(a.rect.top - b.rect.top) > 6) return a.rect.top - b.rect.top;
    return a.rect.left - b.rect.left;
  });

  const items = picked.map(({ el, rect, priority, chart }, index) => {
    el.setAttribute('data-zhunxing-id', String(index));
    const style = styleOf(el);
    const statusText = statusOf(el);
    const isPointer = style.cursor === 'pointer';
    const isChart = Boolean(chart);
    const statusWithPointer = isChart ? (statusText === '-' ? 'chart' : `${statusText},chart`)
      : (isPointer ? (statusText === '-' ? 'pointer' : `${statusText},pointer`) : statusText);
    return {
      i: index,
      tag: tagOf(el),
      role: isChart ? 'chart' : roleOf(el),
      text: isChart ? '(图表)' : textOf(el),
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      bg: toHex(style.backgroundColor),
      fg: toHex(style.color),
      row: rowOf(el),
      status: statusWithPointer,
      cls: priority === 0 ? '' : classOf(el),
      covered: isCovered(el, rect),
    };
  });

  const collectDialogs = () => {
    const dialogs = [];
    const seenText = new Set();
    document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]').forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (!isVisible(el, rect)) return;
      const text = norm(el.innerText || '', 300);
      if (!text || seenText.has(text)) return;
      seenText.add(text);
      const style = styleOf(el);
      if (parseFloat(style.opacity || '1') < 0.1) return;
      dialogs.push(text);
    });
    return dialogs;
  };

  const signature = (() => {
    const text = document.body ? document.body.innerText || '' : '';
    const sample = text.slice(0, 30000);
    let hash = 2166136261;
    for (let i = 0; i < sample.length; i += 1) {
      hash ^= sample.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return `${hash.toString(16)}-${location.href}-${Math.round(window.scrollY)}`;
  })();

  const visibleText = (() => {
    const raw = document.body ? document.body.innerText || '' : '';
    return raw.replace(/\s+/g, ' ').trim().slice(0, 1200);
  })();

  return {
    url: location.href,
    title: document.title,
    visibleText,
    viewport: { w: vw, h: vh, dpr: window.devicePixelRatio || 1, scrollX: window.scrollX, scrollY: window.scrollY },
    dialogs: collectDialogs(),
    signature,
    items,
    totalCandidates: candidates.length,
  };
}

/**
 * 按编号重新定位元素（防止截屏后元素被重建），滚动到视口中央并返回最新坐标。
 */
export function locateElementForClick(elementId) {
  const norm = (value, max) => {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return max && text.length > max ? text.slice(0, max) + '…' : text;
  };
  const el = document.querySelector(`[data-zhunxing-id="${String(elementId).replace(/[^0-9]/g, '')}"]`);
  if (!el) return { ok: false, stale: true, reason: '元素已经不在页面上（可能页面刚刷新过）' };
  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  } catch {
    el.scrollIntoView();
  }
  const rect = el.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return { ok: false, stale: true, reason: '元素尺寸为 0，无法点击' };
  const x = Math.min(Math.max(rect.left + rect.width / 2, 1), Math.max(window.innerWidth - 2, 1));
  const y = Math.min(Math.max(rect.top + rect.height / 2, 1), Math.max(window.innerHeight - 2, 1));
  const hit = document.elementFromPoint(x, y);
  const hitSelf = !!hit && (hit === el || el.contains(hit) || (hit.contains && hit.contains(el)));
  const tag = String(el.tagName || '').toLowerCase();
  const inputType = tag === 'input' ? String(el.getAttribute('type') || 'text').toLowerCase() : '';
  let text = '';
  if (tag === 'input' && (inputType === 'checkbox' || inputType === 'radio')) {
    text = el.getAttribute('aria-label') || el.getAttribute('title') || (el.labels && el.labels.length ? el.labels[0].innerText : '') || '';
  } else if (tag === 'input') {
    text = el.value || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '';
  } else {
    text = el.innerText || el.textContent || '';
  }
  return {
    ok: true,
    x,
    y,
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    area: Math.round(rect.width * rect.height),
    textLength: norm(text, 500).length,
    hitSelf,
    disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
    tag,
    text: norm(text, 60),
    scrollY: Math.round(window.scrollY),
  };
}

/**
 * 聚焦输入框并把已有内容全选（后续用 CDP 输入文字时替换选区）。
 * 返回 { ok, editable, tag, currentValue }
 */
export function focusElementForTyping(elementId) {
  const el = document.querySelector(`[data-zhunxing-id="${String(elementId).replace(/[^0-9]/g, '')}"]`);
  if (!el) return { ok: false, stale: true, reason: '输入框已经不在页面上' };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  try { el.focus({ preventScroll: true }); } catch { try { el.focus(); } catch {} }
  const tag = String(el.tagName || '').toLowerCase();
  const editable = tag === 'input' || tag === 'textarea' || el.isContentEditable;
  if (!editable) return { ok: false, invalid: true, reason: `目标 <${tag}> 不是输入框，不能输入文字` };
  let currentValue = '';
  try {
    if (tag === 'input' || tag === 'textarea') {
      currentValue = String(el.value || '');
      if (typeof el.select === 'function') el.select();
    } else {
      currentValue = String(el.innerText || '');
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  } catch {
    // 忽略选择失败，继续尝试输入
  }
  const rect = el.getBoundingClientRect();
  return {
    ok: true,
    editable: true,
    tag,
    currentValue: currentValue.slice(0, 100),
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

/**
 * 读取输入框当前内容，用于验证 CDP 输入是否真的写进去了。
 */
export function readElementValue(elementId) {
  const el = document.querySelector(`[data-zhunxing-id="${String(elementId).replace(/[^0-9]/g, '')}"]`);
  if (!el) return { ok: false, stale: true };
  const tag = String(el.tagName || '').toLowerCase();
  const value = tag === 'input' || tag === 'textarea' ? String(el.value || '') : String(el.innerText || '');
  return { ok: true, value: value.slice(0, 500), tag };
}

/**
 * 兜底：用原生 setter + input/change 事件把值写入（适配 React/Vue 受控输入框）。
 */
export function setElementValueByScript(elementId, text) {
  const el = document.querySelector(`[data-zhunxing-id="${String(elementId).replace(/[^0-9]/g, '')}"]`);
  if (!el) return { ok: false, stale: true };
  const tag = String(el.tagName || '').toLowerCase();
  try {
    el.focus({ preventScroll: true });
    if (tag === 'input') {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, text);
    } else if (tag === 'textarea') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, text);
    } else {
      el.innerText = text;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: tag === 'input' || tag === 'textarea' ? el.value : el.innerText };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

/**
 * 原生 <select>：按选项文字选中（原生下拉弹层不在 DOM 里，只能用这种方式选）。
 * 返回 { ok, value, optionText }
 */
export function selectNativeOption(elementId, optionText) {
  const el = document.querySelector(`[data-zhunxing-id="${String(elementId).replace(/[^0-9]/g, '')}"]`);
  if (!el) return { ok: false, stale: true, reason: '下拉框已经不在页面上' };
  if (String(el.tagName || '').toLowerCase() !== 'select') return { ok: false, invalid: true, reason: '目标不是原生 <select>，请改用“点击触发器 + 点击选项”的方式' };
  const wanted = String(optionText || '').trim();
  const options = Array.from(el.options || []);
  const match = options.find((option) => (option.text || '').trim() === wanted)
    || options.find((option) => (option.text || '').trim().includes(wanted))
    || options.find((option) => (option.value || '').trim() === wanted);
  if (!match) {
    return { ok: false, invalid: true, reason: `下拉框里没有找到选项「${wanted}」`, options: options.map((option) => (option.text || '').trim()).slice(0, 20) };
  }
  el.focus();
  el.value = match.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: el.value, optionText: (match.text || '').trim() };
}

/**
 * 判断某个视口坐标最上层是不是图表（canvas/svg/图表容器），是的话坐标点击不要吸附到别的元素。
 */
export function topElementIsChart(px, py) {
  const hit = document.elementFromPoint(px, py);
  if (!hit) return { isChart: false };
  let node = hit;
  for (let i = 0; i < 5 && node; i += 1) {
    const tag = String(node.tagName || '').toLowerCase();
    const cls = typeof node.className === 'string' ? node.className : '';
    if (tag === 'canvas' || tag === 'svg' || /chart|echarts|graph/i.test(cls)) {
      return { isChart: true, tag, className: cls.slice(0, 60) };
    }
    node = node.parentElement;
  }
  return { isChart: false, tag: String(hit.tagName || '').toLowerCase() };
}

/**
 * 把模型给的截图像素点吸附到附近元素（先用包含判断，再按距离阈值）。
 */
export function snapPointToElement(px, py, tolerance) {
  const limit = typeof tolerance === 'number' && tolerance > 0 ? tolerance : 32;
  const maxArea = 300 * 200;
  const els = Array.from(document.querySelectorAll('[data-zhunxing-id]'));
  let best = null;
  let bestScore = Infinity;
  let bestArea = Infinity;
  for (const el of els) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const area = rect.width * rect.height;
    if (area > maxArea) continue; // 大容器不参与吸附
    if (px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom) {
      // 包含这个点的元素里，选面积最小的（最具体的那个元素）
      if (area < bestArea) {
        best = el;
        bestArea = area;
        bestScore = 0;
      }
      continue;
    }
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const distance = Math.hypot(cx - px, cy - py);
    if (distance < bestScore && bestScore > 0) {
      bestScore = distance;
      best = el;
      bestArea = area;
    }
  }
  if (!best || bestScore > limit) return { ok: false, score: Math.round(bestScore === Infinity ? 0 : bestScore) };
  try {
    best.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  } catch {
    best.scrollIntoView();
  }
  const rect = best.getBoundingClientRect();
  const x = Math.min(Math.max(rect.left + rect.width / 2, 1), Math.max(window.innerWidth - 2, 1));
  const y = Math.min(Math.max(rect.top + rect.height / 2, 1), Math.max(window.innerHeight - 2, 1));
  return {
    ok: true,
    x,
    y,
    score: Math.round(bestScore),
    elementId: best.getAttribute('data-zhunxing-id'),
    text: String(best.innerText || best.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
  };
}

/**
 * 滚动页面（正数向下）。
 */
export function scrollPageBy(deltaY) {
  window.scrollBy({ top: Number(deltaY) || 0, behavior: 'instant' });
  return { scrollY: Math.round(window.scrollY), maxScroll: Math.round((document.documentElement.scrollHeight || 0) - window.innerHeight) };
}

/**
 * 等待页面渲染稳定：连续两次文本签名一致即认为稳定。返回最后一次读到的签名。
 */
export function waitForStablePage(opts) {
  const options = opts || {};
  const intervalMs = Math.max(60, options.intervalMs || 150);
  const stableTimes = Math.max(2, options.stableTimes || 3);
  const timeoutMs = Math.max(300, options.timeoutMs || 6000);
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let lastSig = '';
    let sameCount = 0;
    const read = () => {
      const text = document.body ? document.body.innerText || '' : '';
      const sample = text.slice(0, 30000);
      let hash = 2166136261;
      for (let i = 0; i < sample.length; i += 1) {
        hash ^= sample.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      return `${hash.toString(16)}-${location.href}-${Math.round(window.scrollY)}-${document.readyState}`;
    };
    const tick = () => {
      const sig = read();
      if (sig === lastSig) sameCount += 1;
      else {
        sameCount = 0;
        lastSig = sig;
      }
      if (sameCount >= stableTimes - 1 || Date.now() - startedAt >= timeoutMs) {
        resolve({ signature: lastSig, ready: document.readyState, waitedMs: Date.now() - startedAt, timedOut: Date.now() - startedAt >= timeoutMs });
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}
