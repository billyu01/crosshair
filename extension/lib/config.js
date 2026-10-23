// 全局配置：常用指令模板、默认设置、storage 读写封装。

export const DEFAULT_TASK =
  '点击页面右上角的「新建」按钮，在弹出的表单里把标题填写为「测试任务」，然后点「保存」；看到列表里出现这条记录就算完成。';

export const DEFAULT_SETTINGS = {
  apiBase: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-flash',
  thinking: 'enabled',
  reasoningEffort: 'low',
  maxSteps: 120,
  clickDelayMs: 700,
  screenshotQuality: 72,
  maxImageWidth: 1200,
  dryRun: false,
  taskPrompt: '',
};

export const STORAGE_KEYS = {
  settings: 'settings',
  runState: 'runState',
  conversation: 'conversation',
};

export const MAX_CONVERSATION_MESSAGES = 40;

export async function loadSettings() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.settings] || {}) };
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
  return next;
}

export async function loadRunState() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.runState);
  return data[STORAGE_KEYS.runState] || null;
}

export async function saveRunState(runState) {
  await chrome.storage.local.set({ [STORAGE_KEYS.runState]: runState });
}

export async function loadConversation() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.conversation);
  const list = data[STORAGE_KEYS.conversation];
  return Array.isArray(list) ? list : [];
}

export async function saveConversation(list) {
  const trimmed = Array.isArray(list) ? list.slice(-MAX_CONVERSATION_MESSAGES) : [];
  await chrome.storage.local.set({ [STORAGE_KEYS.conversation]: trimmed });
  return trimmed;
}

export function newId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `run-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
