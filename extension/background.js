// 准星 - 后台脚本只负责把工具栏图标点击行为绑定为打开侧边栏。
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.debug('[准星] setPanelBehavior 失败：', error));
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.debug('[准星] setPanelBehavior 失败：', error));
});
