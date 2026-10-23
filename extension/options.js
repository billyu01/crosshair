// 设置页：读写 chrome.storage.local，支持测试 DeepSeek 连接。
import { DEFAULT_SETTINGS, DEFAULT_TASK, loadSettings, saveSettings } from './lib/config.js';
import { testConnection } from './lib/deepseek.js';

const $ = (id) => document.getElementById(id);
const fields = {
  apiKey: $('apiKey'),
  apiBase: $('apiBase'),
  model: $('model'),
  thinking: $('thinking'),
  reasoningEffort: $('reasoningEffort'),
  maxSteps: $('maxSteps'),
  clickDelayMs: $('clickDelayMs'),
  maxImageWidth: $('maxImageWidth'),
  dryRun: $('dryRun'),
  taskPrompt: $('taskPrompt'),
};

function showStatus(type, text) {
  const el = $('status');
  el.className = `status ${type}`;
  el.textContent = text;
}

function fillForm(settings) {
  fields.apiKey.value = settings.apiKey || '';
  fields.apiBase.value = settings.apiBase || DEFAULT_SETTINGS.apiBase;
  fields.model.value = settings.model || DEFAULT_SETTINGS.model || 'deepseek-flash';
  fields.thinking.value = settings.thinking || DEFAULT_SETTINGS.thinking;
  fields.reasoningEffort.value = settings.reasoningEffort || DEFAULT_SETTINGS.reasoningEffort;
  fields.maxSteps.value = settings.maxSteps ?? DEFAULT_SETTINGS.maxSteps;
  fields.clickDelayMs.value = settings.clickDelayMs ?? DEFAULT_SETTINGS.clickDelayMs;
  fields.maxImageWidth.value = settings.maxImageWidth ?? DEFAULT_SETTINGS.maxImageWidth;
  fields.dryRun.checked = !!settings.dryRun;
  fields.taskPrompt.value = settings.taskPrompt || DEFAULT_TASK;
}

function readForm() {
  return {
    apiKey: fields.apiKey.value.trim(),
    apiBase: fields.apiBase.value.trim() || DEFAULT_SETTINGS.apiBase,
    model: fields.model.value.trim() || DEFAULT_SETTINGS.model,
    thinking: fields.thinking.value,
    reasoningEffort: fields.reasoningEffort.value,
    maxSteps: Math.max(5, Math.min(300, Number(fields.maxSteps.value) || DEFAULT_SETTINGS.maxSteps)),
    clickDelayMs: Math.max(0, Math.min(5000, Number(fields.clickDelayMs.value) || 0)),
    maxImageWidth: Math.max(400, Math.min(2000, Number(fields.maxImageWidth.value) || DEFAULT_SETTINGS.maxImageWidth)),
    dryRun: fields.dryRun.checked,
    taskPrompt: fields.taskPrompt.value.trim() || DEFAULT_TASK,
  };
}

async function onSave() {
  const next = readForm();
  await saveSettings(next);
  fillForm(next);
  showStatus('ok', '设置已保存。回到侧边栏即可开始使用。');
}

async function onTest() {
  const next = readForm();
  if (!next.apiKey) {
    showStatus('err', '请先填写 API Key。');
    return;
  }
  await saveSettings(next);
  showStatus('info', '正在请求 DeepSeek…');
  $('btn-test').disabled = true;
  try {
    const result = await testConnection(next);
    showStatus('ok', `连接成功：模型 ${result.model || next.model}，耗时 ${result.elapsedMs} 毫秒，返回「${(result.text || '').slice(0, 40)}」。`);
  } catch (error) {
    showStatus('err', `连接失败：${error?.message || error}`);
  } finally {
    $('btn-test').disabled = false;
  }
}

async function onResetTask() {
  fields.taskPrompt.value = DEFAULT_TASK;
  showStatus('info', '已恢复内置示例，点「保存设置」后生效。');
}

async function init() {
  const settings = await loadSettings();
  fillForm(settings);
  $('btn-save').addEventListener('click', onSave);
  $('btn-test').addEventListener('click', onTest);
  $('btn-reset-task').addEventListener('click', onResetTask);
}

init().catch((error) => showStatus('err', `初始化失败：${error?.message || error}`));
