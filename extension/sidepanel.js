// 侧边栏：指令式输入 + 多轮对话 + 运行状态与日志 + 测试钩子。
// 交互参考常见自动化工具的 Playground：上面是对话/执行过程，下面是"要做什么"的指令输入框。
import { RunEngine } from './lib/engine.js';
import {
  DEFAULT_TASK,
  STORAGE_KEYS,
  loadConversation,
  loadRunState,
  loadSettings,
} from './lib/config.js';

const $ = (id) => document.getElementById(id);
const els = {
  task: $('task-input'),
  send: $('btn-send'),
  stop: $('btn-stop'),
  defaultTask: $('btn-default-task'),
  clear: $('btn-clear'),
  export: $('btn-export'),
  settings: $('btn-settings'),
  badge: $('status-badge'),
  detail: $('status-detail'),
  stats: $('stats'),
  warning: $('config-warning'),
  chatList: $('chat-list'),
  logList: $('log-list'),
  logCount: $('log-count'),
  logLatest: $('log-latest'),
  logPanel: $('log-panel'),
  toast: $('toast'),
};

const STATUS_TEXT = { idle: '空闲', running: '运行中', done: '已完成', failed: '已失败', stopped: '已停止' };
const STATUS_SHORT = { done: '已完成', failed: '已失败', stopped: '已停止' };
const ACTION_TEXT = {
  click: '点击元素',
  clickPoint: '坐标点击',
  input: '输入文字',
  pressKey: '按键',
  selectOption: '选择下拉',
  hover: '鼠标悬停',
  drag: '拖拽',
  scroll: '滚动页面',
  wait: '等待',
  back: '返回上一页',
  done: '任务完成',
  fail: '任务失败',
  notice: '提示',
  error: '错误',
};

let engine = null;
let settings = null;
let currentState = null;
let conversation = [];
let isTestMode = false;
let busy = false;
let toastTimer = null;

function resizeComposer() {
  if (!els.task) return;
  const max = Math.max(140, Math.round(window.innerHeight * 0.42));
  els.task.style.height = 'auto';
  const next = Math.min(els.task.scrollHeight, max);
  els.task.style.height = `${next}px`;
  els.task.style.overflowY = els.task.scrollHeight > max ? 'auto' : 'hidden';
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function maskKey(key) {
  if (!key) return '未配置';
  if (key.length <= 8) return '已配置';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function timeText(at) {
  if (!at) return '';
  const date = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function showToast(text, ms = 2600) {
  els.toast.textContent = text;
  els.toast.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), ms);
}

// ---------------- 状态条 ----------------

function renderStatus() {
  const state = currentState;
  const status = state?.status || 'idle';
  const running = status === 'running';

  els.badge.className = `badge ${status}`;
  els.badge.textContent = STATUS_TEXT[status] || status;
  els.stop.disabled = !running;
  els.send.classList.toggle('supplement', running);
  els.send.title = running ? '发送补充指令（Enter）' : '执行（Enter）；运行中发送补充指令';
  els.send.setAttribute('aria-label', running ? '发送补充指令' : '执行');

  if (!state) {
    els.detail.textContent = '输入指令开始，或点左下角书签图标填入常用指令';
  } else if (running) {
    els.detail.textContent = `第 ${state.step || 0} 步正在执行…`;
  } else if (status === 'done') {
    els.detail.textContent = state.summary || '全部完成';
  } else if (status === 'failed') {
    els.detail.textContent = state.lastError || '执行失败';
  } else if (status === 'stopped') {
    els.detail.textContent = state.summary || '已停止';
  }

  const stats = state?.stats || {};
  const parts = [
    `步数 <b>${state?.step || 0}</b>`,
    `点击 <b>${stats.clicks || 0}</b>`,
    `模型 <b>${stats.apiCalls || 0}</b>`,
    `tokens <b>${(stats.promptTokens || 0) + (stats.completionTokens || 0)}</b>`,
  ];
  if (state?.endedAt && !running) parts.push(`用时 <b>${Math.max(0, Math.round((state.endedAt - state.startedAt) / 1000))}s</b>`);
  els.stats.innerHTML = parts.join(' · ');
}

// ---------------- 对话区 ----------------

function lastLogText() {
  const logs = currentState?.logs || [];
  const last = [...logs].reverse().find((entry) => entry.action !== 'notice');
  if (!last) return '';
  const action = ACTION_TEXT[last.action] || last.action || '步骤';
  const target = last.element != null ? `[${last.element}] ${last.elementText || ''}` : '';
  const changed = last.pageChanged === true ? '，页面有变化' : last.pageChanged === false ? '，页面无变化' : '';
  return `第 ${last.step || 0} 步：${action}${target ? ` ${target}` : ''}${changed}`;
}

function renderChat() {
  const parts = [];

  if (!conversation.length && !(currentState?.status === 'running')) {
    parts.push(`<div class="chat-empty">
      <h2>给准星一句指令</h2>
      <p>它会看页面截图和元素清单，一步一步点，并在每一步之后检查页面是否真的变了。</p>
      <ul>
        <li>常用流程：把固定说法存到设置页的「常用指令模板」，点左下角书签图标即可填入。</li>
        <li>运行中：在输入框继续打字发送补充指令，例如「先处理第一条」「如果有弹窗先点确定」。</li>
        <li>任务结束后：直接发下一句，比如「再检查一遍还有没有没处理的项目」。</li>
      </ul>
    </div>`);
  }

  for (const entry of conversation) {
    const time = timeText(entry.at);
    if (entry.role === 'user') {
      const mark = entry.kind === 'injection' ? '<div class="msg-title">运行中补充</div>' : '';
      parts.push(`<div class="msg user">${mark}<div class="bubble">${escapeHtml(entry.text)}</div><span class="msg-time">${time}</span></div>`);
      continue;
    }
    const cls = entry.status === 'done' ? 'done' : entry.status === 'failed' ? 'failed' : entry.status === 'stopped' ? 'stopped' : '';
    const badge = entry.status ? `<span class="badge ${entry.status}">${STATUS_SHORT[entry.status] || entry.status}</span>` : '';
    parts.push(`<div class="msg assistant">
      <div class="bubble ${cls}">
        <div class="msg-title">助手${badge}</div>
        <div>${escapeHtml(entry.text)}</div>
      </div>
      <span class="msg-time">${time}</span>
    </div>`);
  }

  if (currentState?.status === 'running') {
    const hint = lastLogText();
    parts.push(`<div class="msg progress">
      <div class="bubble">
        <span class="progress-dot"></span>
        <div class="progress-text">
          <div>正在执行第 ${currentState.step || 0} 步…</div>
          ${hint ? `<div class="line-2">${escapeHtml(hint)}</div>` : ''}
        </div>
      </div>
    </div>`);
  }

  els.chatList.innerHTML = parts.join('');
  if (currentState?.status === 'running' && els.chatList.parentElement) {
    els.chatList.parentElement.scrollTop = els.chatList.parentElement.scrollHeight;
  }
}

// ---------------- 日志面板 ----------------

function renderLogs() {
  const logs = currentState?.logs || [];
  els.logCount.textContent = `${logs.length} 条`;
  const last = logs.length ? logs[logs.length - 1] : null;
  els.logLatest.textContent = last
    ? `${ACTION_TEXT[last.action] || last.action || ''}${last.pageChanged === false ? ' · 页面无变化' : ''}`
    : '';
  if (!logs.length) {
    els.logList.innerHTML = '<li class="empty">还没有执行记录</li>';
    return;
  }
  const recent = logs.slice(-120).reverse();
  els.logList.innerHTML = recent
    .map((entry) => {
      const noChange = entry.pageChanged === false;
      const failed = entry.result === 'error' || entry.action === 'error';
      const notice = entry.action === 'notice';
      const cls = ['log-item'];
      if (noChange) cls.push('no-change');
      if (failed) cls.push('err');
      if (notice) cls.push('notice');

      const target = entry.summary
        ? escapeHtml(entry.summary)
        : entry.element != null
          ? `[${entry.element}] ${escapeHtml(entry.elementText || '')}${entry.action === 'input' ? ` ← ${escapeHtml(entry.inputText || '')}` : ''}${entry.action === 'selectOption' ? ` ← ${escapeHtml(entry.optionText || entry.selectedValue || '')}` : ''}`
          : entry.point
            ? `(${entry.point.map((n) => Math.round(n)).join(', ')})`
            : '';
      const flags = [];
      if (noChange) flags.push('<span class="log-flag">页面无变化</span>');
      else if (entry.pageChanged === true) flags.push('<span class="log-flag good">页面已变化</span>');
      if (entry.covered) flags.push('<span class="log-flag">被遮挡</span>');
      if (entry.disabled) flags.push('<span class="log-flag">元素禁用</span>');
      if (entry.result === 'stale') flags.push('<span class="log-flag">元素失效</span>');
      if (entry.parseFailure) flags.push('<span class="log-flag">模型输出异常</span>');
      if (entry.modelFallback) flags.push('<span class="log-flag">模型降级重试</span>');
      if (entry.dryRun) flags.push('<span class="log-flag">试运行</span>');

      const detailParts = [];
      if (entry.action === 'input' && entry.typedValue !== undefined) detailParts.push(`输入框当前值：${escapeHtml(entry.typedValue || '(空)')}`);
      if (entry.action === 'input' && entry.submit) detailParts.push('已按回车提交');
      if (entry.action === 'selectOption' && entry.selectedValue) detailParts.push(`选中值：${escapeHtml(entry.selectedValue)}`);
      if (entry.action === 'hover' && entry.point) detailParts.push(`悬停坐标：${entry.point.map((n) => Math.round(n)).join(', ')}`);
      if (entry.action === 'drag' && entry.dragTo) detailParts.push(`拖到：${entry.dragTo.map((n) => Math.round(n)).join(', ')}`);
      if (entry.action === 'pressKey') detailParts.push(`按键：${escapeHtml(entry.key || 'Enter')}`);
      if (entry.apiMs) detailParts.push(`模型 ${Math.round(entry.apiMs)}ms`);
      if (entry.tokens) detailParts.push(`${entry.tokens} tokens`);
      if (entry.followedTab) detailParts.push('已跟随新标签页');
      if (entry.error) detailParts.push(`错误：${escapeHtml(entry.error)}`);
      if (entry.modelFallback) detailParts.push(`第 ${entry.modelFallback + 1} 次请求才拿到合法 JSON（已自动降级重试）`);
      if (entry.parseFailure) {
        const lastFail = entry.parseFailure[entry.parseFailure.length - 1] || {};
        const finish = lastFail.finishReason ? `finish_reason=${lastFail.finishReason}` : '无 finish_reason';
        const lens = `content=${lastFail.contentLength ?? 0}字 reasoning=${lastFail.reasoningLength ?? 0}字`;
        detailParts.push(`JSON 重试 ${entry.parseFailure.length} 次（${finish}，${lens}）`);
      }

      return `<li class="${cls.join(' ')}">
        <div class="log-head">
          <span class="log-step">#${entry.step || 0}</span>
          <span class="log-action">${escapeHtml(ACTION_TEXT[entry.action] || entry.action || '步骤')}</span>
          ${target ? `<span class="log-target" title="${escapeHtml(entry.elementText || '')}">${target}</span>` : ''}
          ${flags.join('')}
        </div>
        ${entry.reason ? `<p class="log-reason">${escapeHtml(entry.reason)}</p>` : ''}
        ${detailParts.length ? `<p class="log-detail">${detailParts.join(' · ')}</p>` : ''}
      </li>`;
    })
    .join('');
}

function renderAll() {
  renderStatus();
  renderChat();
  renderLogs();
}

// ---------------- 配置提示 ----------------

async function refreshConfigWarning() {
  if (!settings) return;
  if (!settings.apiKey) {
    els.warning.innerHTML = '还没有配置 DeepSeek API Key。请点右上角「设置」填写后再开始（Key 只保存在本机浏览器里）。';
    els.warning.classList.remove('hidden');
  } else if (!settings.dryRun && !/^https?:\/\//i.test(settings.apiBase || '')) {
    els.warning.textContent = `API 地址看起来不正确：${settings.apiBase}`;
    els.warning.classList.remove('hidden');
  } else {
    els.warning.classList.add('hidden');
  }
}

// ---------------- 发送 / 停止 ----------------

async function onSend() {
  if (busy) return;
  const text = els.task.value.trim();
  if (!text) {
    showToast('先输入一条指令，或点左下角书签图标填入常用指令');
    els.task.focus();
    return;
  }
  if (engine.running) {
    const result = engine.injectMessage(text);
    if (result.ok) {
      els.task.value = '';
      resizeComposer();
      showToast('补充指令已排入下一步');
    } else {
      showToast(result.error || '补充指令发送失败');
    }
    return;
  }
  if (!settings) settings = await loadSettings();
  if (!settings.apiKey && !settings.dryRun) {
    await refreshConfigWarning();
    showToast('还没有配置 DeepSeek API Key，请先在设置页填写');
    return;
  }
  busy = true;
  els.task.value = '';
  resizeComposer();
  els.send.disabled = true;
  showToast('开始执行…', 1200);
  try {
    await engine.start({ task: text });
  } catch (error) {
    showToast(`启动失败：${error?.message || error}`);
  } finally {
    busy = false;
    els.send.disabled = false;
    currentState = await loadRunState();
    renderAll();
  }
}

function onStop() {
  engine.stop();
  showToast('已请求停止，当前步骤结束后停下');
}

async function onClear() {
  await chrome.storage.local.remove([STORAGE_KEYS.runState, STORAGE_KEYS.conversation]);
  currentState = null;
  conversation = [];
  renderAll();
  showToast('对话和日志已清空');
}

function onExport() {
  const payload = {
    exportedAt: new Date().toISOString(),
    settings: { ...settings, apiKey: maskKey(settings?.apiKey) },
    conversation,
    runState: currentState,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  link.href = url;
  link.download = `准星-运行记录-${stamp}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

async function onFillDefaultTask() {
  if (!settings) settings = await loadSettings();
  els.task.value = settings.taskPrompt || DEFAULT_TASK;
  resizeComposer();
  els.task.focus();
  showToast('已填入常用指令，点右下角发送按钮开始');
}

// ---------------- 初始化 ----------------

async function init() {
  document.body.classList.add('sidepanel');
  settings = await loadSettings();
  currentState = await loadRunState();
  conversation = await loadConversation();
  // 上次运行可能因为刷新扩展/关闭侧边栏而中断，打开面板时把残留的 running 状态收尾，避免误以为还在跑
  if (currentState && currentState.status === 'running') {
    currentState = {
      ...currentState,
      status: 'stopped',
      endedAt: Date.now(),
      summary: currentState.summary || '上次运行已中断（扩展刷新或侧边栏关闭）',
    };
    try {
      await chrome.storage.local.set({ runState: currentState });
    } catch (error) {
      console.debug('[准星] 修正中断状态失败', error);
    }
  }
  renderAll();
  resizeComposer();
  await refreshConfigWarning();

  engine = new RunEngine();
  engine.onUpdate = (state) => {
    currentState = state;
    renderAll();
  };
  engine.onConversationChange = (list) => {
    conversation = list;
    renderChat();
  };
  window.__engine = engine;

  els.send.addEventListener('click', onSend);
  els.stop.addEventListener('click', onStop);
  els.clear.addEventListener('click', onClear);
  els.export.addEventListener('click', onExport);
  els.defaultTask.addEventListener('click', onFillDefaultTask);
  els.settings.addEventListener('click', () => chrome.runtime.openOptionsPage());
  els.task.addEventListener('input', resizeComposer);
  window.addEventListener('resize', resizeComposer);

  els.task.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      onSend();
    }
  });

  window.addEventListener('pagehide', () => {
    try {
      engine.dispose();
    } catch (error) {
      console.debug('[准星] 清理失败', error);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_KEYS.runState]) {
      currentState = changes[STORAGE_KEYS.runState].newValue || null;
      renderAll();
    }
    if (changes[STORAGE_KEYS.conversation]) {
      conversation = changes[STORAGE_KEYS.conversation].newValue || [];
      renderChat();
    }
    if (changes[STORAGE_KEYS.settings]) {
      settings = { ...settings, ...(changes[STORAGE_KEYS.settings].newValue || {}) };
      refreshConfigWarning();
    }
  });

  // 测试模式：URL 带 ?autostart=1 时挂载测试钩子（自动化测试用）
  const params = new URLSearchParams(location.search);
  if (params.get('autostart') === '1') {
    isTestMode = true;
    window.__testMode = true;
    window.__runFinished = false;
    window.__runResult = null;
    window.startRunForTest = async ({ task, tabId, settings: override } = {}) => {
      const merged = { ...(await loadSettings()), ...(override || {}) };
      settings = merged;
      const taskText = task || els.task.value.trim() || DEFAULT_TASK;
      window.__runFinished = false;
      window.__runResult = null;
      const result = await engine.start({ task: taskText, tabId, settings: merged });
      window.__runResult = result;
      window.__runFinished = true;
      currentState = result;
      conversation = await loadConversation();
      renderAll();
      return result;
    };
    window.stopRunForTest = () => engine.stop();
    window.injectMessageForTest = (text) => engine.injectMessage(text);
    window.getConversationForTest = async () => JSON.stringify(await loadConversation());
    console.log('[准星] 测试模式已启用（多轮对话：window.injectMessageForTest）');
  }
}

init().catch((error) => {
  console.error('[准星] 初始化失败', error);
  document.body.innerHTML = `<pre style="padding:16px;color:#b42318">准星初始化失败：${escapeHtml(error?.message || error)}</pre>`;
});
