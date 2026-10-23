// 运行引擎：截图 → 收集元素 → 请模型决策 → 真实点击 → 校验页面变化 → 记录。
// 引擎跑在侧边栏页面里（不是 Service Worker），避免 MV3 后台被回收导致长任务中断。

import { loadConversation, loadSettings, newId, saveConversation, sleep, MAX_CONVERSATION_MESSAGES } from './config.js';
import { chatCompletion, DeepSeekError } from './deepseek.js';
import { DebuggerSession, CdpError } from './cdp.js';
import {
  collectInventory,
  focusElementForTyping,
  locateElementForClick,
  readElementValue,
  scrollPageBy,
  selectNativeOption,
  setElementValueByScript,
  snapPointToElement,
  topElementIsChart,
} from './inventory.js';
import { buildMessages, parseAction } from './planner.js';

const MAX_LOGS = 300;
const TOTAL_HINTS_LIMIT = 400;

function now() {
  return Date.now();
}

function errorText(error) {
  if (!error) return '未知错误';
  if (error instanceof DeepSeekError) return error.message;
  return String(error.message || error);
}

export class RunEngine {
  constructor() {
    this.status = 'idle';
    this.runState = null;
    this.session = null;
    this.tabId = null;
    this._originTabId = null;
    this._originUrl = '';
    this._stopRequested = false;
    this._running = false;
    this._createdTabs = new Map();
    this._tabListeners = [];
    this._download = null;
    this._settings = null;
    this._lastClickElement = null;
    this._sameElementStreak = 0;
    this._consecutiveErrors = 0;
    this._dialogCount = 0;
    this._pendingMessages = [];
    this.conversation = [];
    this._priorConversation = [];
    this._conversationFinalized = false;
    this._parseFailureStreak = 0;
    this._urlStreakUrl = '';
    this._urlStreakCount = 0;
    this._lastClickText = '';
    this._sameTextStreak = 0;
    this._prevInventoryItems = null;
    this._allDisabledStreak = 0;
    this._justSubmitted = false;
  }

  // ---------- 多轮对话 ----------

  async _appendConversation(entry) {
    const item = { at: now(), ...entry };
    this.conversation = [...(this.conversation || []), item].slice(-MAX_CONVERSATION_MESSAGES);
    try {
      await saveConversation(this.conversation);
    } catch (error) {
      console.debug('[准星] 保存对话失败', error);
    }
    if (typeof this.onConversationChange === 'function') {
      try {
        this.onConversationChange(this.conversation);
      } catch {
        // 渲染异常不影响运行
      }
    }
  }

  /**
   * 运行中追加一条用户指令：会写进对话记录，并在下一步模型请求里以最高优先级出现。
   * 返回 { ok, queued }。
   */
  injectMessage(text) {
    const content = String(text || '').replace(/\s+$/g, '').trim().slice(0, 2000);
    if (!content) return { ok: false, error: '指令内容为空' };
    if (!this._running) return { ok: false, error: '当前没有正在运行的任务，请直接发送新指令开始' };
    this._pendingMessages.push(content);
    this._appendConversation({ role: 'user', text: content, kind: 'injection' });
    this._log({
      step: this.runState?.step || 0,
      at: now(),
      action: 'notice',
      reason: `收到补充指令，将在下一步交给模型：${content}`,
      result: 'ok',
      pageChanged: null,
    });
    this._persist();
    return { ok: true, queued: true };
  }

  get running() {
    return this._running;
  }

  _emit() {
    if (typeof this.onUpdate === 'function') {
      try {
        this.onUpdate(this.runState);
      } catch {
        // 面板渲染异常不影响运行
      }
    }
  }

  _setState(patch) {
    this.runState = { ...this.runState, ...patch };
    this._emit();
  }

  async _persist() {
    if (!this.runState) return;
    try {
      await chrome.storage.local.set({ runState: this.runState });
    } catch (error) {
      console.debug('[准星] 保存运行状态失败', error);
    }
  }

  _log(entry) {
    if (!this.runState) return;
    const logs = this.runState.logs || [];
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    this.runState.logs = logs;
    this._emit();
  }

  _finish(status, { summary = '', error = '' } = {}) {
    this._setState({ status, endedAt: now(), summary: summary || this.runState?.summary || '', lastError: error || '' });
    this._persist();
    if (!this._conversationFinalized) {
      this._conversationFinalized = true;
      const text = summary
        || (status === 'failed' ? `执行失败：${error || '未知原因'}` : status === 'stopped' ? '已停止执行' : '任务结束');
      this._appendConversation({ role: 'assistant', kind: 'result', status, text });
    }
  }

  // ---------- 目标标签页 ----------

  async _resolveStartTab(tabId) {
    if (tabId) {
      const tab = await chrome.tabs.get(tabId);
      return tab;
    }
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active) return active;
    const [any] = await chrome.tabs.query({ lastFocusedWindow: true });
    return any;
  }

  _watchTabs() {
    const onCreated = (tab) => {
      if (this.tabId && tab.openerTabId === this.tabId) {
        this._createdTabs.set(tab.id, { at: now(), adopted: false });
      }
    };
    const onRemoved = (tabId) => {
      this._createdTabs.delete(tabId);
    };
    chrome.tabs.onCreated.addListener(onCreated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    this._tabListeners = [onCreated, onRemoved];
  }

  _unwatchTabs() {
    if (this._tabListeners.length === 2) {
      chrome.tabs.onCreated.removeListener(this._tabListeners[0]);
      chrome.tabs.onRemoved.removeListener(this._tabListeners[1]);
    }
    this._tabListeners = [];
    this._createdTabs.clear();
  }

  async _switchTarget(tabId, reason = '') {
    if (this._createdTabs.has(tabId)) this._createdTabs.get(tabId).adopted = true;
    if (this.session) await this.session.detach();
    this.tabId = tabId;
    this.session = new DebuggerSession(tabId);
    await this.session.attach();
    this.session.onEvent((method) => {
      if (method === 'Page.javascriptDialogOpening') {
        this._dialogCount += 1;
        this.session.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      }
    });
    this._setState({ tabId });
    if (reason) {
      this._log({ step: this.runState?.step || 0, at: now(), action: 'notice', reason, result: 'ok', pageChanged: true });
    }
    await this._persist();
  }

  async _ensureTargetAlive() {
    try {
      const tab = await chrome.tabs.get(this.tabId);
      if (tab && /^https?:/i.test(tab.url || '')) return;
    } catch {
      // 标签页已关闭，走兜底
    }
    const fallback = await this._pickFallbackTab();
    if (!fallback) throw new Error('目标标签页已经关闭，找不到可以继续操作的页面。');
    await this._switchTarget(fallback.id, `原标签页已关闭，已切换到新页面：${fallback.url}`);
  }

  async _pickFallbackTab() {
    // 1) 本轮新建、还没用过的 http(s) 标签页（例如"复制"打开了新页面）
    const created = [];
    for (const [tabId, meta] of this._createdTabs) {
      if (meta.adopted) continue;
      try {
        const tab = await chrome.tabs.get(tabId);
        if (/^https?:/i.test(tab.url || '')) created.push(tab);
      } catch {
        // 已关闭
      }
    }
    if (created.length) return created[created.length - 1];

    // 2) 起始标签页还在的话，切回去（例如日历标签页被 window.close 关掉）
    if (this._originTabId) {
      try {
        const tab = await chrome.tabs.get(this._originTabId);
        if (tab && /^https?:/i.test(tab.url || '')) return tab;
      } catch {
        // 已关闭
      }
    }

    // 3) 最后才找同窗口、同源的标签页，避免误操作到不相关的页面
    try {
      let origin = '';
      try {
        origin = new URL(this._originUrl || '').origin;
      } catch {
        origin = '';
      }
      const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
      const sameOrigin = tabs.filter(
        (tab) => tab.id && tab.id !== this.tabId && /^https?:/i.test(tab.url || '') && (!origin || String(tab.url).startsWith(origin)),
      );
      if (sameOrigin.length) return sameOrigin[sameOrigin.length - 1];
    } catch {
      // ignore
    }
    return null;
  }

  async _maybeFollowNewTab() {
    try {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (active && active.id && active.id !== this.tabId && this._createdTabs.has(active.id) && /^https?:/i.test(active.url || '')) {
        await this._switchTarget(active.id, `检测到新标签页，已切换过去：${active.url}`);
        return true;
      }
      // 兜底：有些网站用 window.open 在后台开新标签页，不会变成当前标签页。
      // 这种情况下当前页面通常没有变化，所以依次挑一个本轮新建的、还没用过的 http(s) 标签页。
      const candidates = [];
      for (const [tabId, meta] of this._createdTabs) {
        if (tabId === this.tabId || meta.adopted) continue;
        try {
          const tab = await chrome.tabs.get(tabId);
          if (/^https?:/i.test(tab.url || '')) candidates.push(tab);
        } catch {
          // 已关闭
        }
      }
      if (candidates.length) {
        const newest = candidates[candidates.length - 1];
        await this._switchTarget(newest.id, `检测到后台新标签页，已切换过去：${newest.url}`);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // ---------- 页面操作 ----------

  async _executeInPage(fn, args = [], retries = 2) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: this.tabId, allFrames: false },
          func: fn,
          args,
        });
        return results?.[0]?.result;
      } catch (error) {
        lastError = error;
        if (this._stopRequested) throw error;
        await sleep(320);
      }
    }
    throw new Error(`页面脚本执行失败：${errorText(lastError)}`);
  }

  async _waitPageStable(timeoutMs = 8000) {
    const startedAt = now();
    let lastKey = null;
    let sameCount = 0;
    while (now() - startedAt < timeoutMs) {
      if (this._stopRequested) break;
      let info = null;
      try {
        info = await this.session.pageInfo();
      } catch {
        info = null;
      }
      if (info && info.url) {
        const key = `${info.sig}|${info.url}|${info.ready}`;
        if (key === lastKey) sameCount += 1;
        else {
          sameCount = 0;
          lastKey = key;
        }
        if (sameCount >= 2 && info.ready === 'complete') return info;
      }
      await sleep(180);
    }
    try {
      return await this.session.pageInfo();
    } catch {
      return { url: '', sig: '', ready: 'unknown' };
    }
  }

  async _sleepUnlessStopped(ms) {
    const endAt = now() + ms;
    while (now() < endAt) {
      if (this._stopRequested) return;
      await sleep(Math.min(120, endAt - now()));
    }
  }

  // ---------- 截图与缩放 ----------

  async _captureImage(settings) {
    const shot = await this.session.captureScreenshot(settings.screenshotQuality || 72);
    const base64 = await this._shrinkImage(shot.data, settings);
    const info = await this._imageSize(base64);
    return {
      dataUrl: `data:image/jpeg;base64,${base64}`,
      info,
      viewport: { w: shot.cssWidth, h: shot.cssHeight, dpr: shot.dpr },
    };
  }

  async _imageSize(base64) {
    try {
      const blob = await this._b64ToBlob(base64, 'image/jpeg');
      const bitmap = await createImageBitmap(blob);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return size;
    } catch {
      return { width: 0, height: 0 };
    }
  }

  async _shrinkImage(base64, settings) {
    const maxWidth = Math.max(400, Math.min(2000, Number(settings.maxImageWidth) || 1200));
    try {
      const blob = await this._b64ToBlob(base64, 'image/jpeg');
      const bitmap = await createImageBitmap(blob);
      if (bitmap.width <= maxWidth) {
        bitmap.close();
        return base64;
      }
      const scale = maxWidth / bitmap.width;
      const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: Math.max(0.4, Math.min(0.95, (settings.screenshotQuality || 72) / 100)) });
      return await this._blobToB64(outBlob);
    } catch (error) {
      console.debug('[准星] 图片缩放失败，使用原图', error);
      return base64;
    }
  }

  async _b64ToBlob(base64, type) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type });
  }

  async _blobToB64(blob) {
    const buffer = await blob.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  // ---------- 模型调用 ----------

  async _callModel(settings, messages, { task, inventory, logs, step, stats, hints, imageInfo, prevSignature, conversation, injections, pageChanges }) {
    const baseArgs = {
      apiBase: settings.apiBase,
      apiKey: settings.apiKey,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
    };

    // 第一次按用户配置请求；解析失败后依次降级：
    //   1) 关闭思考模式 + JSON Output（避免思考内容占用输出预算导致 content 为空）
    //   2) 关闭思考模式 + 自由文本，只要求输出 JSON（DeepSeek 的 JSON Output 偶发空内容，走这条通常能拿到）
    const correctionText = '你上一条回复没有遵守格式。请只返回一个合法 JSON 动作：以 { 开头、} 结尾，不要输出任何解释、不要 markdown 代码块。';
    const buildCorrectionMessages = () => {
      const correction = buildMessages({
        task,
        inventory,
        logs,
        step,
        maxSteps: settings.maxSteps,
        stats,
        hints,
        imageDataUrl: null,
        imageInfo,
        prevSignature,
        conversation,
        injections,
        pageChanges,
      });
      correction.push({ role: 'user', content: [{ type: 'text', text: correctionText }] });
      return correction;
    };

    const attemptsPlan = [
      { label: 'configured', thinking: settings.thinking, responseFormat: 'json_object', maxTokens: 2000, messages },
      { label: 'no-thinking-json', thinking: 'disabled', responseFormat: 'json_object', maxTokens: 1600, messages: buildCorrectionMessages() },
      { label: 'no-thinking-text', thinking: 'disabled', responseFormat: 'none', maxTokens: 1600, messages: buildCorrectionMessages() },
    ];

    const failures = [];
    let lastRaw = null;
    for (let i = 0; i < attemptsPlan.length; i += 1) {
      const plan = attemptsPlan[i];
      let result;
      try {
        result = await chatCompletion({
          ...baseArgs,
          thinking: plan.thinking,
          messages: plan.messages,
          maxTokens: plan.maxTokens,
          responseFormat: plan.responseFormat,
        });
      } catch (error) {
        const retryable = error instanceof DeepSeekError && (error.status === 0 || error.status === 429 || error.status >= 500);
        const isLast = i === attemptsPlan.length - 1;
        if (!retryable || isLast) throw error;
        failures.push({ attempt: i + 1, label: plan.label, error: String(error.message || error) });
        await this._sleepUnlessStopped(1000);
        continue;
      }
      this._addUsage(result.usage);
      const parsed = parseAction(result.content, { itemCount: inventory.items.length });
      if (parsed.ok) {
        return { action: parsed.action, raw: result, fallbackAttempts: i };
      }
      lastRaw = result;
      failures.push({
        attempt: i + 1,
        label: plan.label,
        thinking: plan.thinking,
        responseFormat: plan.responseFormat,
        finishReason: result.finishReason || '',
        contentLength: (result.content || '').length,
        reasoningLength: (result.reasoning || '').length,
        contentSnippet: (result.content || '').slice(0, 200),
        error: parsed.error,
      });
    }

    // 三次都没拿到可解析的 JSON：不当作致命错误，交给下一步重新请求（同时把诊断信息写进日志）。
    return {
      action: { type: 'wait', ms: 1200, reason: '模型这次没有返回可解析的 JSON，已自动等待后重试', memo: '' },
      raw: lastRaw || {},
      parseFailure: failures,
    };
  }

  _addUsage(usage) {
    if (!usage || !this.runState) return;
    const stats = this.runState.stats;
    stats.promptTokens += Number(usage.prompt_tokens || 0);
    stats.completionTokens += Number(usage.completion_tokens || 0);
    stats.apiCalls += 1;
  }

  // ---------- 动作执行 ----------

  async _clickByElement(elementId) {
    const located = await this._executeInPage(locateElementForClick, [elementId]);
    if (!located || !located.ok) {
      return {
        result: 'stale',
        error: located?.reason || '元素已经不在页面上',
        point: null,
        elementText: '',
      };
    }
    // 防“点整块容器”：非交互元素如果特别大或文字特别长，多半是日历/面板外层，不点它
    const tagLower = String(located.tag || '').toLowerCase();
    if (tagLower === 'select') {
      return { result: 'invalid', error: '这是原生下拉框，请用 selectOption 动作按选项文字选择，不要直接点击', point: null, elementText: located.text };
    }
    if (tagLower === 'canvas' || tagLower === 'svg') {
      return { result: 'invalid', error: '这是图表/画布元素，请用 clickPoint 指定截图坐标点击（或先 hover 看提示），不要点图表中心', point: null, elementText: located.text };
    }
    const interactiveTags = ['button', 'a', 'input', 'select', 'textarea', 'label', 'option', 'summary'];
    const area = located.area || (located.width || 0) * (located.height || 0);
    const tagIsInteractive = interactiveTags.includes(String(located.tag || '').toLowerCase());
    if (!tagIsInteractive && (area > 500 * 300 || (located.textLength || 0) > 240)) {
      return {
        result: 'invalid',
        error: `元素尺寸 ${located.width}x${located.height}、文字 ${located.textLength || 0} 字，看起来是整块容器，不是具体可点目标`,
        point: null,
        elementText: located.text,
      };
    }
    if (this._settings.dryRun) {
      return { result: 'ok', point: [located.x, located.y], elementText: located.text, dryRun: true };
    }
    await this.session.click(located.x, located.y);
    return {
      result: 'ok',
      point: [Math.round(located.x), Math.round(located.y)],
      elementText: located.text,
      covered: located.hitSelf === false,
      disabled: located.disabled === true,
    };
  }

  async _clickByPoint(point, imageInfo, viewport) {
    const imgW = imageInfo?.width || viewport.w;
    const imgH = imageInfo?.height || viewport.h;
    const cssX = Math.max(1, Math.min(viewport.w - 2, (Number(point[0]) / imgW) * viewport.w));
    const cssY = Math.max(1, Math.min(viewport.h - 2, (Number(point[1]) / imgH) * viewport.h));
    let snapped = null;
    let chartHit = null;
    try {
      chartHit = await this._executeInPage(topElementIsChart, [cssX, cssY]);
    } catch {
      chartHit = null;
    }
    if (!(chartHit && chartHit.isChart)) {
      try {
        snapped = await this._executeInPage(snapPointToElement, [cssX, cssY, 36]);
      } catch {
        snapped = null;
      }
    }
    const clickX = snapped?.ok ? snapped.x : cssX;
    const clickY = snapped?.ok ? snapped.y : cssY;
    if (this._settings.dryRun) {
      return { result: 'ok', point: [Math.round(clickX), Math.round(clickY)], elementText: snapped?.text || '', snapped: !!snapped?.ok, dryRun: true };
    }
    await this.session.click(clickX, clickY);
    return {
      result: 'ok',
      point: [Math.round(clickX), Math.round(clickY)],
      elementText: snapped?.text || (chartHit?.isChart ? '(图表坐标)' : ''),
      snapped: !!snapped?.ok,
      chartPoint: !!(chartHit && chartHit.isChart),
    };
  }

  async _typeIntoElement(elementId, text, options = {}) {
    const focus = await this._executeInPage(focusElementForTyping, [elementId]);
    if (!focus || !focus.ok) {
      return {
        result: focus?.invalid ? 'invalid' : 'stale',
        error: focus?.reason || '输入框已经不在页面上',
        elementText: '',
      };
    }
    // 先真实点一下输入框确保聚焦，再用 CDP 输入文字
    if (this._settings.dryRun) {
      return { result: 'ok', elementText: '', inputText: text, dryRun: true };
    }
    try {
      await this.session.click(focus.x, focus.y);
    } catch {
      // 点不到也继续尝试直接用 insertText（可能已经聚焦）
    }
    await this._executeInPage(focusElementForTyping, [elementId]);
    await this.session.insertText(text);
    await this._sleepUnlessStopped(180);
    let typed = null;
    try {
      typed = await this._executeInPage(readElementValue, [elementId]);
    } catch {
      typed = null;
    }
    const expected = String(text || '').trim();
    const actual = typed && typed.ok ? String(typed.value || '') : '';
    if (!actual.includes(expected) && expected) {
      // 受控组件兜底：用原生 setter + input/change 事件写值
      const fallback = await this._executeInPage(setElementValueByScript, [elementId, text]);
      if (fallback?.ok) {
        await this._sleepUnlessStopped(120);
        try {
          typed = await this._executeInPage(readElementValue, [elementId]);
          typed.fallback = true;
        } catch {
          typed = null;
        }
      }
    }
    const finalValue = typed && typed.ok ? String(typed.value || '') : '';
    if (options.submit) {
      await this._sleepUnlessStopped(120);
      await this.session.pressKey('Enter');
    }
    return {
      result: 'ok',
      elementText: '',
      inputText: text,
      typedValue: finalValue.slice(0, 100),
      submit: !!options.submit,
    };
  }

  async _selectOption(elementId, optionText) {
    const located = await this._executeInPage(locateElementForClick, [elementId]);
    if (!located || !located.ok) {
      return { result: 'stale', error: located?.reason || '下拉框已经不在页面上', elementText: '' };
    }
    const wantText = String(optionText || '').trim();
    if (!wantText) return { result: 'invalid', error: 'selectOption 必须提供要选择的选项文字（option）' };
    if (String(located.tag || '').toLowerCase() === 'select') {
      const picked = await this._executeInPage(selectNativeOption, [elementId, wantText]);
      if (!picked || !picked.ok) {
        return { result: 'invalid', error: picked?.reason || `原生下拉框里没找到选项「${wantText}」`, elementText: located.text };
      }
      await this._sleepUnlessStopped(this._settings.clickDelayMs || 300);
      return { result: 'ok', elementText: picked.optionText || located.text, selectedValue: picked.value, optionText: picked.optionText };
    }
    // 自定义下拉：先点触发器展开，再在最新元素清单里按文字找选项
    if (this._settings.dryRun) return { result: 'ok', elementText: located.text, optionText: wantText, dryRun: true };
    await this.session.click(located.x, located.y);
    let chosen = null;
    for (let attempt = 0; attempt < 3 && !chosen; attempt += 1) {
      await this._sleepUnlessStopped(350);
      let inv = null;
      try {
        inv = await this._executeInPage(collectInventory, [{ maxItems: 300 }]);
      } catch {
        inv = null;
      }
      const items = (inv && inv.items) || [];
      const exact = items.find((item) => String(item.text || '').trim() === wantText && !/disabled/i.test(String(item.status || '')));
      const fuzzy = exact || items.find((item) => String(item.text || '').trim().includes(wantText) && !/disabled/i.test(String(item.status || '')));
      if (fuzzy) chosen = fuzzy;
    }
    if (!chosen) {
      return { result: 'invalid', error: `点击下拉框后没有在页面上找到选项「${wantText}」（可能没展开，或选项文字不一致）`, elementText: located.text };
    }
    const optionLocated = await this._executeInPage(locateElementForClick, [chosen.i]);
    if (!optionLocated || !optionLocated.ok) {
      return { result: 'stale', error: optionLocated?.reason || '下拉选项已经消失', elementText: chosen.text };
    }
    await this.session.click(optionLocated.x, optionLocated.y);
    await this._sleepUnlessStopped(this._settings.clickDelayMs || 300);
    return { result: 'ok', elementText: located.text, selectedValue: chosen.text, optionText: chosen.text };
  }

  async _hover(action, imageInfo, viewport) {
    let x = null;
    let y = null;
    let text = '';
    if (action.element != null) {
      const located = await this._executeInPage(locateElementForClick, [action.element]);
      if (!located || !located.ok) return { result: 'stale', error: located?.reason || '悬停目标已经不在页面上', elementText: '' };
      x = located.x;
      y = located.y;
      text = located.text;
    } else if (action.point) {
      const imgW = imageInfo?.width || viewport.w;
      const imgH = imageInfo?.height || viewport.h;
      x = Math.max(1, Math.min(viewport.w - 2, (Number(action.point[0]) / imgW) * viewport.w));
      y = Math.max(1, Math.min(viewport.h - 2, (Number(action.point[1]) / imgH) * viewport.h));
    }
    if (x == null || y == null) return { result: 'invalid', error: 'hover 需要 element 或 point' };
    if (!this._settings.dryRun) await this.session.hover(x, y);
    await this._sleepUnlessStopped(action.ms || 700);
    return { result: 'ok', point: [Math.round(x), Math.round(y)], elementText: text, hover: true };
  }

  async _drag(action, imageInfo, viewport) {
    const mapPoint = (point) => {
      const imgW = imageInfo?.width || viewport.w;
      const imgH = imageInfo?.height || viewport.h;
      return [
        Math.max(1, Math.min(viewport.w - 2, (Number(point[0]) / imgW) * viewport.w)),
        Math.max(1, Math.min(viewport.h - 2, (Number(point[1]) / imgH) * viewport.h)),
      ];
    };
    const resolve = async (elementId, point) => {
      if (elementId != null) {
        const located = await this._executeInPage(locateElementForClick, [elementId]);
        if (!located || !located.ok) return null;
        return [located.x, located.y, located.text];
      }
      if (point) {
        const [x, y] = mapPoint(point);
        return [x, y, ''];
      }
      return null;
    };
    const from = await resolve(action.fromElement, action.fromPoint);
    if (!from) return { result: 'invalid', error: 'drag 的起点无效（需要 fromElement 或 fromPoint）' };
    const to = await resolve(action.toElement, action.toPoint);
    if (!to) return { result: 'invalid', error: 'drag 的终点无效（需要 toElement 或 toPoint）' };
    if (!this._settings.dryRun) await this.session.drag(from[0], from[1], to[0], to[1], action.durationMs || 500);
    await this._sleepUnlessStopped(action.durationMs || 500);
    return {
      result: 'ok',
      point: [Math.round(from[0]), Math.round(from[1])],
      dragTo: [Math.round(to[0]), Math.round(to[1])],
      elementText: from[2] || '',
    };
  }


  async _executeAction(action, context) {
    const { imageInfo, viewport } = context;
    if (action.type === 'click') {
      return await this._clickByElement(action.element);
    }
    if (action.type === 'clickPoint') {
      return await this._clickByPoint(action.point, imageInfo, viewport);
    }
    if (action.type === 'scroll') {
      const delta = action.direction === 'up' ? -action.amount : action.amount;
      const info = await this._executeInPage(scrollPageBy, [delta]);
      return { result: 'ok', scroll: info };
    }
    if (action.type === 'wait') {
      await this._sleepUnlessStopped(action.ms);
      return { result: 'ok', waitMs: action.ms };
    }
    if (action.type === 'input') {
      return await this._typeIntoElement(action.element, action.text, { submit: action.submit });
    }
    if (action.type === 'selectOption') {
      return await this._selectOption(action.element, action.option);
    }
    if (action.type === 'hover') {
      return await this._hover(action, imageInfo, viewport);
    }
    if (action.type === 'drag') {
      return await this._drag(action, imageInfo, viewport);
    }
    if (action.type === 'pressKey') {
      if (this._settings.dryRun) return { result: 'ok', key: action.key, dryRun: true };
      await this.session.pressKey(action.key);
      return { result: 'ok', key: action.key };
    }
    if (action.type === 'back') {
      try {
        await chrome.tabs.goBack(this.tabId);
      } catch {
        try {
          await this.session.evaluate('history.back()');
        } catch {
          // ignore
        }
      }
      return { result: 'ok' };
    }
    return { result: 'ok' };
  }

  // ---------- 主流程 ----------

  async start({ task, tabId, settings: settingsOverride } = {}) {
    if (this._running) return this.runState;
    this._running = true;
    this._stopRequested = false;
    this._consecutiveErrors = 0;
    this._sameElementStreak = 0;
    this._lastClickElement = null;
    this._dialogCount = 0;
    this._pendingMessages = [];
    this._conversationFinalized = false;
    this._parseFailureStreak = 0;
    this._urlStreakUrl = '';
    this._urlStreakCount = 0;
    this._lastClickText = '';
    this._sameTextStreak = 0;
    this._prevInventoryItems = null;
    this._allDisabledStreak = 0;
    this._justSubmitted = false;
    try {
      this.conversation = await loadConversation();
    } catch {
      this.conversation = [];
    }
    this._priorConversation = this.conversation.slice(-12);

    let settings;
    try {
      settings = { ...(await loadSettings()), ...(settingsOverride || {}) };
      settings.maxSteps = Math.max(5, Math.min(300, Number(settings.maxSteps) || 120));
      settings.clickDelayMs = Math.max(0, Math.min(5000, Number(settings.clickDelayMs) || 0));
    } catch (error) {
      settings = { ...(settingsOverride || {}) };
    }
    this._settings = settings;
    const taskText = String(task || settings.taskPrompt || '').trim() || '先观察页面，按用户的指令完成操作；完成目标后返回 done。';

    this.runState = {
      id: newId(),
      status: 'running',
      task: taskText,
      step: 0,
      startedAt: now(),
      endedAt: null,
      tabId: null,
      summary: '',
      lastError: '',
      stats: { apiCalls: 0, promptTokens: 0, completionTokens: 0, clicks: 0, noChangeStreak: 0 },
      logs: [],
    };
    this._emit();
    await this._persist();
    await this._appendConversation({ role: 'user', text: taskText, kind: 'instruction' });

    try {
      const tab = await this._resolveStartTab(tabId);
      if (!tab || !tab.id) throw new Error('没有找到要操作的标签页，请先打开目标网页。');
      if (!/^https?:/i.test(tab.url || '')) {
        throw new Error(`当前标签页不是普通网页（${tab.url || '未知地址'}），请先切换到要操作的系统页面再开始。`);
      }
      if (!settings.apiKey && !settings.dryRun) {
        throw new Error('还没有填写 DeepSeek API Key，请点右上角「设置」填写后再开始。');
      }
      this._originTabId = tab.id;
      this._originUrl = tab.url || '';
      this._watchTabs();
      await this._switchTarget(tab.id);
      await this._loop(settings);
    } catch (error) {
      const message = errorText(error);
      this._log({ step: this.runState.step, at: now(), action: 'error', reason: message, result: 'error', pageChanged: false });
      this._finish('failed', { error: message });
    } finally {
      this._running = false;
      this._stopRequested = false;
      if (this.session) await this.session.detach();
      this.session = null;
      this._unwatchTabs();
      await this._persist();
    }
    return this.runState;
  }

  async _loop(settings) {
    for (let step = 1; step <= settings.maxSteps; step += 1) {
      if (this._stopRequested) {
        this._finish('stopped', { summary: '用户手动停止了运行' });
        return;
      }
      this._setState({ step });
      const continueRun = await this._runOneStep(step, settings);
      if (!continueRun) return;
      if (this.runState.status !== 'running') return;
    }
    this._finish('failed', { error: `达到步数上限（${settings.maxSteps} 步）仍未判定完成` });
  }

  async _runOneStep(step, settings) {
    try {
      await this._ensureTargetAlive();
      await this._waitPageStable(10000);
      const pageBefore = await this.session.pageInfo();
      const image = await this._captureImage(settings);
      const inventory = await this._executeInPage(collectInventory, [{ maxItems: 300 }]);
      if (!inventory || !Array.isArray(inventory.items)) throw new Error('没有拿到页面元素清单');

      const injections = this._pendingMessages.splice(0, this._pendingMessages.length);
      if (injections.length) {
        this._log({
          step,
          at: now(),
          action: 'notice',
          reason: `把用户补充指令交给模型：${injections.join('；')}`,
          result: 'ok',
          pageChanged: null,
        });
      }
      // 主动识别完成状态：页面出现完成标志，直接结束
      this._currentVisibleText = inventory.visibleText || '';
      const completionSignal = this._detectCompletionSignal(inventory.visibleText || '');
      if (completionSignal) {
        this._log({
          step,
          at: now(),
          action: 'notice',
          reason: `检测到页面完成标志：「${completionSignal}」，自动判定任务完成`,
          result: 'ok',
          pageChanged: true,
        });
        this._finish('done', { summary: `页面出现完成标志「${completionSignal}」，自动判定任务已完成` });
        return false;
      }

      // 兜底：所有按钮/链接都禁用，且连续两步如此，也判定完成
      const interactiveItems = (inventory.items || []).filter((item) => (
        ['button', 'a', 'input', 'select', 'textarea'].includes(item.tag)
        || ['button', 'link', 'menuitem', 'tab', 'option', 'checkbox', 'radio', 'switch', 'combobox'].includes(item.role)
      ));
      const enabledInteractive = interactiveItems.filter((item) => !/disabled/i.test(String(item.status || '')));
      let allDisabledHint = false;
      if (interactiveItems.length > 0 && enabledInteractive.length === 0) {
        this._allDisabledStreak += 1;
        if (this._allDisabledStreak >= 2) {
          this._log({ step, at: now(), action: 'notice', reason: '页面上的可操作元素都是禁用状态，自动判定任务完成', result: 'ok', pageChanged: true });
          this._finish('done', { summary: '页面上的按钮/链接均为禁用状态，没有可继续操作的目标，自动判定任务完成' });
          return false;
        }
        allDisabledHint = true;
      } else {
        this._allDisabledStreak = 0;
      }

      const pageChanges = this._diffInventory(this._prevInventoryItems, inventory.items);
      this._prevInventoryItems = (inventory.items || []).map((item) => ({
        text: item.text, row: item.row, fg: item.fg, bg: item.bg, status: item.status,
      }));
      const hints = this._buildHints(step, settings);
      if (allDisabledHint) {
        hints.push('页面上的按钮/链接都处于禁用状态，可能任务已经完成；如果确认目标都达成了，请直接返回 done，不要再点击。');
      }
      const messages = buildMessages({
        task: this.runState.task,
        inventory,
        logs: this.runState.logs.filter((entry) => entry.action !== 'notice' && entry.action !== 'error'),
        step,
        maxSteps: settings.maxSteps,
        stats: this.runState.stats,
        hints,
        imageDataUrl: image.dataUrl,
        imageInfo: image.info,
        prevSignature: this._prevSignature || null,
        conversation: this._priorConversation,
        injections,
        pageChanges,
      });

      const { action, raw, parseFailure, fallbackAttempts } = await this._callModel(settings, messages, {
        task: this.runState.task,
        inventory,
        logs: this.runState.logs,
        step,
        stats: this.runState.stats,
        hints,
        imageInfo: image.info,
        prevSignature: this._prevSignature || null,
        conversation: this._priorConversation,
        injections,
        pageChanges,
      });
      this._prevSignature = inventory.signature;
      this._consecutiveErrors = 0;

      const logEntry = {
        step,
        at: now(),
        action: action.type,
        element: action.element,
        point: action.point,
        reason: action.reason || '',
        memo: action.memo || '',
        result: 'ok',
        pageChanged: null,
        url: pageBefore.url,
        prevUrl: pageBefore.url,
        apiMs: raw.elapsedMs,
        tokens: raw.usage ? (raw.usage.prompt_tokens || 0) + (raw.usage.completion_tokens || 0) : 0,
        image: image.info,
      };
      if (parseFailure) {
        logEntry.parseFailure = parseFailure;
        logEntry.result = 'parse-error';
      }
      if (fallbackAttempts) logEntry.modelFallback = fallbackAttempts;
      if (action.type === 'input') {
        logEntry.inputText = action.text;
        logEntry.submit = !!action.submit;
      }
      if (action.type === 'pressKey') logEntry.key = action.key;
      if (action.type === 'selectOption') logEntry.optionText = action.option;
      if (action.type === 'hover') logEntry.hoverPoint = action.point || null;
      if (action.type === 'drag') {
        logEntry.drag = {
          fromElement: action.fromElement, toElement: action.toElement,
          fromPoint: action.fromPoint, toPoint: action.toPoint,
        };
      }

      if (parseFailure) {
        this._parseFailureStreak += 1;
        if (this._parseFailureStreak >= 3) {
          this._log({ ...logEntry, result: 'error', pageChanged: false, error: '模型连续 3 次返回的内容无法解析为 JSON' });
          this._finish('failed', {
            error: '模型连续 3 次返回的内容无法解析为 JSON。已在日志里记录每次的 finish_reason、内容长度和片段，可以切到「思考模式：关闭」或换模型再试。',
          });
          return false;
        }
      } else {
        this._parseFailureStreak = 0;
      }

      if (action.type === 'done') {
        this._log({ ...logEntry, result: 'ok', pageChanged: true });
        this._finish('done', { summary: action.summary || '任务完成' });
        return false;
      }
      if (action.type === 'fail') {
        this._log({ ...logEntry, result: 'error', error: action.reason, pageChanged: false });
        this._finish('failed', { error: action.reason || '模型判断无法继续' });
        return false;
      }

      const executed = await this._executeAction(action, { imageInfo: image.info, viewport: image.viewport });
      if (executed.elementText) logEntry.elementText = executed.elementText;
      if (executed.inputText) logEntry.inputText = executed.inputText;
      if (executed.typedValue !== undefined) logEntry.typedValue = executed.typedValue;
      if (executed.key) logEntry.key = executed.key;
      if (executed.selectedValue !== undefined) logEntry.selectedValue = executed.selectedValue;
      if (executed.optionText !== undefined) logEntry.optionText = executed.optionText;
      if (executed.chartPoint) logEntry.chartPoint = true;
      if (executed.dragTo) logEntry.dragTo = executed.dragTo;
      if (!logEntry.elementText && (action.type === 'click' || action.type === 'input') && action.element != null && inventory.items[action.element]) {
        const invItem = inventory.items[action.element];
        logEntry.elementText = (invItem.text || invItem.row || '').slice(0, 60);
      }
      if ((action.type === 'click' || action.type === 'clickPoint') && logEntry.elementText) {
        const clickText = String(logEntry.elementText).trim();
        if (clickText && clickText === this._lastClickText) this._sameTextStreak += 1;
        else {
          this._sameTextStreak = 1;
          this._lastClickText = clickText;
        }
      }
      if (executed.error) logEntry.error = executed.error;
      if (executed.covered) logEntry.covered = true;
      if (executed.disabled) logEntry.disabled = true;
      if (executed.snapped !== undefined) logEntry.snapped = executed.snapped;
      if (executed.dryRun) logEntry.dryRun = true;
      if (!parseFailure) logEntry.result = executed.result;

      let pageAfter = null;
      if (['click', 'clickPoint', 'input', 'pressKey', 'selectOption', 'hover', 'drag'].includes(action.type)) {
        if (['click', 'clickPoint', 'selectOption', 'drag'].includes(action.type)) this.runState.stats.clicks += 1;
        if (action.type === 'click') {
          if (this._lastClickElement === action.element) this._sameElementStreak += 1;
          else {
            this._sameElementStreak = 1;
            this._lastClickElement = action.element;
          }
        }
        if (!settings.dryRun) {
          await this._sleepUnlessStopped(settings.clickDelayMs);
          pageAfter = await this._waitPageStable(4000);
          let changed = pageAfter.url !== pageBefore.url || pageAfter.sig !== pageBefore.sig;
          // 当前标签页没有变化时，检查是不是点击打开了新标签页（有些系统"复制"会新开标签页）。
          if (!changed) {
            const followedTab = await this._maybeFollowNewTab();
            if (followedTab) {
              logEntry.followedTab = true;
              pageAfter = await this._waitPageStable(10000);
              changed = true;
            }
          }
          logEntry.pageChanged = changed;
          if (changed) {
            this.runState.stats.noChangeStreak = 0;
            this._sameElementStreak = 0;
            this._lastClickElement = null;
            if (logEntry.elementText && /确定|确认|提交|保存|完成|完成填报/.test(String(logEntry.elementText))) {
              this._justSubmitted = true;
            }
          } else {
            this.runState.stats.noChangeStreak += 1;
          }
        }
      } else {
        pageAfter = await this._waitPageStable(6000);
        logEntry.pageChanged = pageAfter.url !== pageBefore.url || pageAfter.sig !== pageBefore.sig;
        if (logEntry.pageChanged) {
          this.runState.stats.noChangeStreak = 0;
          this._sameElementStreak = 0;
          this._lastClickElement = null;
        }
      }

      if (pageAfter) {
        const endUrl = pageAfter.url || pageBefore.url;
        logEntry.url = endUrl;
        if (endUrl === this._urlStreakUrl) this._urlStreakCount += 1;
        else {
          this._urlStreakUrl = endUrl;
          this._urlStreakCount = 1;
          this._sameTextStreak = 0;
          this._lastClickText = '';
        }
      }

      if (settings.dryRun && step >= 12) {
        this._log(logEntry);
        this._finish('stopped', { summary: '试运行模式已执行 12 步（只看不点），已停止。' });
        return false;
      }

      this._log(logEntry);
      await this._persist();

      if (this._sameTextStreak >= 6) {
        this._finish('failed', {
          error: `已经连续 ${this._sameTextStreak} 次点击文字为「${this._lastClickText}」的元素，页面没有实质进展，判断为卡住并停止。如果这是日期/选项，它可能已经完成或不可点；请换一个目标，或先滚动/返回列表再试。`,
        });
        return false;
      }
      if (this.runState.stats.noChangeStreak >= 6) {
        this._finish('failed', { error: '连续 6 次点击后页面都没有变化，已停止，避免无效循环。请检查页面是否卡住或需要人工登录。' });
        return false;
      }
      if (this._urlStreakCount >= 18) {
        this._finish('failed', {
          error: `已经在同一个页面连续执行 ${this._urlStreakCount} 步、始终没有页面跳转，判断为卡住并停止。常见原因：反复点了已经完成/不可点的项（例如已填报的日期），或提交/确定按钮要滚动后才出现。建议换一条记录、先滚动或返回列表再试。`,
        });
        return false;
      }
      return true;
    } catch (error) {
      if (error instanceof DeepSeekError && [400, 401, 402, 403].includes(error.status)) {
        this._finish('failed', { error: error.message });
        return false;
      }
      this._consecutiveErrors += 1;
      const message = errorText(error);
      this._log({ step, at: now(), action: 'error', reason: message, result: 'error', pageChanged: null });
      if (this._consecutiveErrors >= 5) {
        this._finish('failed', { error: `连续 5 步执行失败，最后错误：${message}` });
        return false;
      }
      await this._sleepUnlessStopped(800);
      return true;
    }
  }

  // 从页面可见文字里识别“任务已完成”的强信号；识别到就直接结束，不再等模型判断
  _detectCompletionSignal(text) {
    const content = String(text || '').replace(/\s+/g, ' ');
    if (!content) return '';
    const patterns = [
      /(?<![未没不有])(?<!尚未)(?<!没有)全部(?:日期|记录|任务|项目|工时)?(?:已|都|均)?(?:填报|完成|提交|处理)/,
      /已全部(?:完成|填报|提交|处理)/,
      /(?:没有|无|暂无)(?:需要|待)(?:填报|填写|处理|完成|提交)/,
      /(?:所有|全部)(?:任务|记录|项目|日期|工时)?(?:都)?(?:已)?(?:完成|填报|提交)/,
      /all (?:tasks? )?(?:done|completed)/i,
      /no (?:more )?(?:pending|tasks? left)/i,
    ];
    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) return String(match[0]).slice(0, 40);
    }
    return '';
  }

  // 对比上一步和当前步的元素清单，找出颜色/状态/出现/消失的变化，帮助模型“重新规划”
  _diffInventory(prevItems, nextItems) {
    if (!prevItems || !prevItems.length) return [];
    const normalize = (item) => ({
      text: String(item.text || '').trim(),
      row: String(item.row || '').trim().slice(0, 40),
      fg: item.fg || '',
      bg: item.bg || '',
      status: item.status || '',
    });
    const keyOf = (item) => `${item.text}@@${item.row}`;
    const prevMap = new Map();
    for (const raw of prevItems) {
      const item = normalize(raw);
      if (!item.text || item.text.length > 24) continue;
      prevMap.set(keyOf(item), item);
    }
    const changes = [];
    const added = [];
    const removed = new Set(prevMap.keys());
    for (const raw of nextItems || []) {
      const item = normalize(raw);
      if (!item.text || item.text.length > 24) continue;
      const key = keyOf(item);
      const before = prevMap.get(key);
      if (before) {
        removed.delete(key);
        const diffs = [];
        if (before.fg !== item.fg) diffs.push(`字色 ${before.fg || '-'} → ${item.fg || '-'}`);
        if (before.bg !== item.bg) diffs.push(`底色 ${before.bg || '-'} → ${item.bg || '-'}`);
        if (before.status !== item.status) diffs.push(`状态 ${before.status || '-'} → ${item.status || '-'}`);
        if (diffs.length) changes.push(`「${item.text}」：${diffs.join('，')}`);
      } else if (added.length < 4) {
        added.push(`新增「${item.text}」`);
      }
    }
    const removedList = [...removed].map((key) => key.split('@@')[0]).filter(Boolean).slice(0, 4).map((text) => `消失「${text}」`);
    return [...changes.slice(0, 8), ...added, ...removedList].slice(0, 12);
  }

  _buildHints(step, settings) {
    const hints = [];
    const stats = this.runState.stats;
    if (stats.noChangeStreak >= 2) {
      hints.push(`注意：最近连续 ${stats.noChangeStreak} 次点击后页面几乎没有变化。很可能是元素没点对，或者点击后页面还在加载。请重新核对元素清单里的文字和位置，换一个元素；如果判断页面确实在加载，先 wait。`);
    }
    if (this._sameElementStreak >= 3) {
      hints.push(`你已经连续 ${this._sameElementStreak} 次点击同一个元素，但页面没有变化，不要再点它，换别的元素。`);
    }
    if (this.runState.logs.some((entry) => entry.action === 'error')) {
      hints.push('之前有步骤执行失败过；如果页面看起来正常，可以继续按任务目标操作。');
    }
    if (this.runState.logs.slice(-3).some((entry) => entry.result === 'invalid')) {
      hints.push('上一步想点的元素尺寸太大、文字很长，看起来是整块容器（例如整个日历/面板），不是具体按钮。请从元素清单里挑尺寸更小的那个元素。');
    }
    if (this._sameTextStreak >= 3) {
      hints.push(`你已经连续 ${this._sameTextStreak} 次点击文字为「${this._lastClickText}」的元素，如果它没有让页面出现下一步（比如提交按钮），说明它可能已经完成或不可点，不要继续点它，换一个目标。`);
    }
    if (this._urlStreakCount >= 8) {
      hints.push(`你已经连续 ${this._urlStreakCount} 步停留在同一个页面、没有发生跳转。请检查：1) 是否在反复点已经完成或不可点的项（例如已经填过的日期）；2) 提交/确定按钮是否需要先滚动才能看到；3) 是否需要返回上一页或换一条记录。建议先 scroll 或 back，不要重复点同类元素。`);
    }
    if (step > 1 && step % 5 === 0) {
      hints.push('重新规划：请先根据当前截图和元素清单，重新判断哪些已完成、哪些还可点、下一步该做什么；不要沿用上一步的记忆直接重复动作。');
    }
    if (this._justSubmitted) {
      hints.push('上一步已经成功点了「提交/确认/保存」类按钮。现在请先检查页面：如果用户要求的目标已经全部完成（例如所有待填日期都已填好、页面提示全部完成、或列表里没有待处理项），下一步必须返回 done，不要再重复点提交。');
      this._justSubmitted = false;
    }
    const visible = String(this._currentVisibleText || '');
    const successMatch = visible.match(/(?:提交|保存|操作|填报)(?:成功|完成)/);
    if (successMatch) {
      hints.push(`页面出现成功提示「${successMatch[0]}」。如果任务目标已经全部达成，请直接返回 done；如果还有未完成项，再继续。`);
    }
    if (step > settings.maxSteps * 0.7) {
      hints.push(`已经用掉 ${step - 1} 步（上限 ${settings.maxSteps} 步）。如果任务已经接近完成请尽快收尾；如果还没开始有效操作，请检查是不是页面/弹窗状态不对。`);
    }
    return hints;
  }

  dispose() {
    this._stopRequested = true;
    this._unwatchTabs();
    const session = this.session;
    this.session = null;
    if (session) {
      try {
        session.detach();
      } catch {
        // 页面正在卸载，忽略
      }
    }
    if (this.runState && this.runState.status === 'running') {
      this.runState = { ...this.runState, status: 'stopped', endedAt: now(), summary: '侧边栏已关闭，运行中断' };
      try {
        chrome.storage.local.set({ runState: this.runState });
      } catch {
        // ignore
      }
    }
  }

  stop() {
    this._stopRequested = true;
    if (this.runState && this.runState.status === 'running') {
      this._log({ step: this.runState.step, at: now(), action: 'notice', reason: '收到停止指令，将在当前步骤完成后停止', result: 'ok', pageChanged: null });
    }
  }
}
