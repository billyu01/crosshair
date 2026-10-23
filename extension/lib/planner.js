// 规划提示词构造与模型输出解析。

export const ACTION_TYPES = ['click', 'clickPoint', 'input', 'pressKey', 'selectOption', 'hover', 'drag', 'scroll', 'wait', 'back', 'done', 'fail'];

export const SYSTEM_PROMPT = `你是一个浏览器自动化操作员。你每一步只能输出一个 JSON 动作，除此之外不要输出任何文字。

## 你的工作方式
- 每一步你会收到：当前页面截图、当前页面可见元素的清单（每项有编号、标签、角色、文字、位置、尺寸、底色、字色、所在表格行、状态）、最近的操作历史。
- 需要点击时，优先输出 {"action":"click","element":元素编号}，编号必须来自元素清单。
- 只有目标确实不在清单里时，才使用 {"action":"clickPoint","point":[x,y]}，坐标是截图上的像素坐标（左上角为原点）。
- 每次只做一个动作。动作执行后，你会收到新的截图和清单，页面可能已经变化。
- 元素清单只包含当前视口内的可见元素；看不到目标时用 scroll 滚动后再看。

## 输出格式（必须是合法 JSON）
{"action":"click","element":12,"reason":"点击第 1 行复制按钮","memo":"准备填报第 1 周"}
{"action":"clickPoint","point":[884,700],"reason":"目标不在清单里"}
{"action":"input","element":8,"text":"黄金价格","submit":true,"reason":"在搜索框输入关键词并回车"}
{"action":"pressKey","key":"Enter","reason":"按回车提交搜索"}
{"action":"selectOption","element":9,"option":"广东省","reason":"在下拉框里选择省份"}
{"action":"hover","element":20,"reason":"鼠标悬停到图表上查看提示"}
{"action":"clickPoint","point":[520,300],"reason":"点击图表里的这个数据点"}
{"action":"drag","fromElement":21,"toElement":22,"reason":"把滑块拖到目标位置"}
{"action":"scroll","direction":"down","amount":600,"reason":"向下滚动查看表格"}
{"action":"wait","ms":1200,"reason":"等待页面加载"}
{"action":"back","reason":"当前周没有待填日期，返回列表"}
{"action":"done","summary":"所有未填写日期都已填报完成"}
{"action":"fail","reason":"页面提示登录已失效，无法继续"}

## 判断规则
1. 优先用截图和元素清单里的文字、颜色来判断目标；颜色已经转成 #rrggbb，透明底色显示为 -。颜色/图标/标记的含义以用户在任务里写的为准（例如用户说红色代表待办，就按红色找）。
2. 页面有弹窗时要先处理弹窗，例如点「确定」「取消」「关闭」。
3. 如果历史里出现「页面无变化」的提示，说明上一次点击可能没点中或页面还没响应：请重新核对元素编号和文字，换一个元素，或者先用 wait / scroll。绝对不要连续重复点同一个位置。
4. 如果用户描述的是重复/循环流程，就按用户说的节奏一小步一小步做；每完成一轮把进度写进 memo（例如「已完成 3 条，还剩 2 条」），避免重复做同一件事。
5. 确认用户要求的目标全部达成后才返回 done；页面出现明确的完成标志（如「全部完成」「没有待处理项」）也可以作为完成依据。遇到无法继续的错误返回 fail 并说明原因。
6. reason 用一句中文写清楚为什么做这个动作，memo 写当前进度，两者都要简短。
7. 点击目标要挑元素清单里尺寸小、具体的那个元素。文字很长（被截断）或尺寸特别大的元素通常是容器（比如整个日历、整个面板），不要点。
8. 如果点了某个日期/选项后，页面没有出现"已选中"效果、也没出现下一步按钮，说明它可能已经完成、不可点或被遮挡：不要反复点同类元素，换一个元素、先 scroll 看全页，或者 back 返回。
9. 系统提示你在同一个页面停留过久时，按提示改变策略（滚动查看、返回上一页、换一条记录），不要重复之前的动作。
10. 每一步都必须以**当前截图和当前元素清单**为准重新判断；历史只说明做过什么，不要因为"上次点了这个"就再点一次。
11. 如果某个元素的颜色/状态相比上一步变了（例如红色变成绿色、按钮变成禁用），说明它的状态已经更新；不要重复点它，要根据新状态决定下一步。页面出现新的按钮（如「提交」「确定」）时要优先处理。
12. 页面可见文字里出现完成类提示（如「全部完成」「已全部填报」「没有待处理」「暂无待办」）时，必须立即返回 {"action":"done"}，不要再点击任何东西。
13. 提交/保存成功后如果页面已经回到列表、或出现成功提示，不要重复点提交；先确认用户要求的目标是否全部完成，完成就返回 done。
14. 需要输入文字时，必须用 input 动作，不要用 click 代替输入。输入框在元素清单里通常标签是 input / textarea，或状态里带 editable，文字会显示占位文案或「（输入框）」。
15. 搜索类任务：先对搜索框用 input（text=关键词，submit=true 表示输完按回车），或者输入后按 Enter / 点击「搜索」按钮；等结果页加载后，读取页面可见文字或点进结果链接继续。不要点新闻标题、导航链接来代替点搜索框。
16. input 之后如果页面没有反应，先确认目标确实是输入框；可以再点一次输入框、用 pressKey 按 Enter，或者点击页面上的「搜索」按钮。
17. 下拉框：原生 <select>（元素清单里状态带 select）用 selectOption 按选项文字选择；自定义下拉框也优先用 selectOption（插件会自动点开触发器再点选项），也可以拆成"click 触发器 → 清单里出现选项后 click 选项"两步。
18. 复选框/单选框/开关：直接 click；元素清单状态里会带 checked/selected，点完确认状态变化符合预期。
19. 图表/画布（canvas/svg/echarts）：不要用 click 点整个图表元素；用 clickPoint 给出截图上的具体坐标来点数据点。要看 tooltip 时用 hover（element=图表或 point 坐标），下一步截图里会带出提示内容。
20. 滑块、可拖拽卡片、范围选择：用 drag，写 fromElement/toElement 或 fromPoint/toPoint（point 是截图像素坐标）。`;

function sanitize(value, max) {
  const text = String(value == null ? '' : value).replace(/\|/g, '/').replace(/"/g, "'").replace(/\s+/g, ' ').trim();
  return max && text.length > max ? text.slice(0, max) + '…' : text;
}

/**
 * 元素清单文本格式（假模型服务按 | 分隔解析，改动需要同步 DESIGN.md）：
 * [编号] 标签|角色|文字|x,y|w,h|底色|字色|表格行|状态
 */
export function formatInventory(inventory) {
  const lines = inventory.items.map((item) => {
    const pos = `${item.x},${item.y}`;
    const size = `${item.w},${item.h}`;
    const text = item.text ? `"${sanitize(item.text, 60)}"` : '-';
    return `[${item.i}] ${item.tag}|${item.role || '-'}|${text}|${pos}|${size}|${item.bg || '-'}|${item.fg || '-'}|${sanitize(item.row, 70) || '-'}|${item.status || '-'}`;
  });
  return lines.join('\n');
}

export function formatHistory(logs, maxCount = 10) {
  if (!logs.length) return '（这是第一步，还没有操作历史）';
  const recent = logs.slice(-maxCount);
  const describe = (entry) => {
    const text = (value, max) => sanitize(value, max);
    switch (entry.action) {
      case 'click':
        return `点击[${entry.element}]"${text(entry.elementText, 30)}"`;
      case 'clickPoint':
        return `点击坐标(${(entry.point || []).join(',')})${entry.chartPoint ? '（图表）' : ''}`;
      case 'input':
        return `在[${entry.element}]"${text(entry.elementText, 20)}"输入"${text(entry.inputText, 30)}"${entry.submit ? '并回车' : ''}`;
      case 'pressKey':
        return `按键 ${entry.key || 'Enter'}`;
      case 'selectOption':
        return `在[${entry.element}]"${text(entry.elementText, 20)}"选择「${text(entry.optionText || entry.selectedValue, 20)}」`;
      case 'hover':
        return entry.element != null
          ? `悬停[${entry.element}]"${text(entry.elementText, 20)}"`
          : `悬停坐标(${String(entry.hoverPoint || '').replace(/[\[\]]/g, '')})`;
      case 'drag':
        return '拖拽元素';
      case 'scroll':
        return '滚动页面';
      case 'wait':
        return `等待 ${entry.waitMs || 0} 毫秒`;
      case 'back':
        return '返回上一页';
      default:
        return entry.action || '动作';
    }
  };
  return recent
    .map((entry) => {
      const changed = entry.pageChanged === true ? '页面有变化' : entry.pageChanged === false ? '页面无变化' : '';
      const result = entry.result === 'ok' ? '成功' : entry.result === 'stale' ? '元素已失效' : entry.result === 'error' ? `失败：${sanitize(entry.error, 80)}` : '已执行';
      const urlPart = entry.url && entry.url !== entry.prevUrl ? `，URL 变为 ${sanitize(entry.url, 120)}` : '';
      const memoPart = entry.memo ? `，备忘：${sanitize(entry.memo, 80)}` : '';
      return `第${entry.step}步：${describe(entry)} → ${result}${changed ? `，${changed}` : ''}${urlPart}${memoPart}`;
    })
    .join('\n');
}

function formatConversation(conversation, maxCount = 10) {
  if (!conversation || !conversation.length) return '';
  const recent = conversation.slice(-maxCount);
  return recent
    .map((entry) => {
      const role = entry.role === 'user' ? '用户' : '助手';
      const kind = entry.kind === 'result' && entry.status
        ? `（${entry.status === 'done' ? '已完成' : entry.status === 'failed' ? '失败' : '已停止'}）`
        : '';
      return `${role}${kind}：${sanitize(entry.text, 240)}`;
    })
    .join('\n');
}

export function buildUserText({
  task,
  inventory,
  logs,
  step,
  maxSteps,
  stats,
  hints,
  imageInfo,
  prevSignature,
  conversation,
  injections,
  pageChanges,
}) {
  const dialogs = inventory.dialogs && inventory.dialogs.length
    ? inventory.dialogs.map((text, index) => `弹窗${index + 1}: ${sanitize(text, 200)}`).join('\n')
    : '无';
  const signatureChanged = prevSignature == null
    ? '（这是第一步）'
    : inventory.signature === prevSignature
      ? '没变'
      : '变了';
  const hintsText = hints && hints.length ? `\n## 系统提示\n${hints.map((hint) => `- ${hint}`).join('\n')}` : '';
  const scrollText = inventory.viewport ? `，滚动位置 y=${Math.round(inventory.viewport.scrollY || 0)}` : '';

  let clock = '';
  try {
    clock = new Date().toLocaleString('zh-CN', { hour12: false });
  } catch {
    clock = '';
  }

  const conversationText = formatConversation(conversation);
  const conversationSection = conversationText
    ? `\n## 多轮对话上下文（本次任务之前的对话，供理解上下文）\n${conversationText}\n`
    : '';
  const injectionsText = injections && injections.length
    ? `\n## 用户在本轮运行中补充的指令（优先级最高，必须优先遵守）\n${injections.map((text) => `- ${sanitize(text, 240)}`).join('\n')}\n`
    : '';
  const changesText = pageChanges && pageChanges.length
    ? `\n## 与上一步相比的页面变化（很重要：请据此重新判断，不要重复上一步的动作）\n${pageChanges.map((line) => `- ${sanitize(line, 200)}`).join('\n')}\n`
    : '';

  return `## 任务
${task}
${conversationSection}${injectionsText}${changesText}
## 当前状态
- 当前时间: ${clock}
- 第 ${step} 步 / 最多 ${maxSteps} 步；已点击 ${stats.clicks} 次；连续「页面无变化」${stats.noChangeStreak || 0} 次。
- 页面: ${sanitize(inventory.url, 300)}
- 标题: ${sanitize(inventory.title, 120)}
- 视口: ${inventory.viewport?.w || 0}x${inventory.viewport?.h || 0} CSS 像素${scrollText}
- 页面签名: ${sanitize(inventory.signature, 120)}（与上一步相比：${signatureChanged}）
- 截图尺寸: ${imageInfo?.width || 0}x${imageInfo?.height || 0} 像素（clickPoint 请使用这个坐标系）
- 弹窗: ${dialogs}${hintsText}

## 页面可见文字（节选，注意里面的完成提示、报错、提示语）
${sanitize(inventory.visibleText, 900) || '（无）'}

## 最近操作
${formatHistory(logs)}

## 可用元素清单（格式：[编号] 标签|角色|文字|x,y|尺寸w,h|底色|字色|表格行|状态）
${formatInventory(inventory) || '（当前视口内没有识别到可操作元素，可以 scroll 或 wait）'}

请根据截图和上面的元素清单，返回下一步动作 JSON。`;
}

export function buildMessages({ task, inventory, logs, step, maxSteps, stats, hints, imageDataUrl, imageInfo, prevSignature, conversation, injections, pageChanges }) {
  const system = SYSTEM_PROMPT;
  const userText = buildUserText({ task, inventory, logs, step, maxSteps, stats, hints, imageInfo, prevSignature, conversation, injections, pageChanges });
  const userContent = [{ type: 'text', text: userText }];
  if (imageDataUrl) {
    userContent.push({ type: 'image_url', image_url: { url: imageDataUrl } });
  }
  return [
    { role: 'system', content: system },
    { role: 'user', content: userContent },
  ];
}

export function extractJson(text) {
  const raw = String(text || '').trim();
  const withoutFence = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('回复里没有 JSON 对象');
  const candidate = withoutFence.slice(start, end + 1);
  return JSON.parse(candidate);
}

/**
 * 解析模型输出。返回 { ok:true, action } 或 { ok:false, error }。
 */
export function parseAction(text, { itemCount = 0 } = {}) {
  let data;
  try {
    data = extractJson(text);
  } catch (error) {
    return { ok: false, error: `输出不是合法 JSON：${error.message}` };
  }
  if (!data || typeof data !== 'object') return { ok: false, error: '输出不是 JSON 对象' };
  const action = String(data.action || '').trim();
  if (!ACTION_TYPES.includes(action)) return { ok: false, error: `不支持的动作：${action || '(空)'}` };
  const reason = String(data.reason || '').slice(0, 500);
  const memo = String(data.memo || '').slice(0, 300);

  if (action === 'click') {
    const element = Number(data.element);
    if (!Number.isInteger(element) || element < 0) return { ok: false, error: `element 必须是元素编号（非负整数），收到：${data.element}` };
    if (itemCount && element >= itemCount) return { ok: false, error: `element 编号 ${element} 超出清单范围（0~${itemCount - 1}）` };
    return { ok: true, action: { type: 'click', element, reason, memo } };
  }
  if (action === 'clickPoint') {
    const point = Array.isArray(data.point) ? data.point.map(Number) : [];
    if (point.length !== 2 || !point.every((value) => Number.isFinite(value))) {
      return { ok: false, error: `point 必须是 [x, y] 两个数字，收到：${JSON.stringify(data.point)}` };
    }
    return { ok: true, action: { type: 'clickPoint', point, reason, memo } };
  }
  if (action === 'input') {
    const element = Number(data.element);
    if (!Number.isInteger(element) || element < 0) return { ok: false, error: `input 的 element 必须是元素编号，收到：${data.element}` };
    if (itemCount && element >= itemCount) return { ok: false, error: `element 编号 ${element} 超出清单范围（0~${itemCount - 1}）` };
    const text = String(data.text == null ? '' : data.text).slice(0, 2000);
    if (!text) return { ok: false, error: 'input 动作必须提供 text（要输入的文字）' };
    return { ok: true, action: { type: 'input', element, text, submit: data.submit === true, reason, memo } };
  }
  if (action === 'pressKey') {
    const key = String(data.key || 'Enter');
    const allowed = ['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'Backspace'];
    if (!allowed.includes(key)) return { ok: false, error: `pressKey 只支持 ${allowed.join('/')}，收到：${key}` };
    return { ok: true, action: { type: 'pressKey', key, reason, memo } };
  }
  if (action === 'selectOption') {
    const element = Number(data.element);
    if (!Number.isInteger(element) || element < 0) return { ok: false, error: `selectOption 的 element 必须是元素编号，收到：${data.element}` };
    if (itemCount && element >= itemCount) return { ok: false, error: `element 编号 ${element} 超出清单范围（0~${itemCount - 1}）` };
    const option = String(data.option == null ? '' : data.option).trim().slice(0, 200);
    if (!option) return { ok: false, error: 'selectOption 必须提供要选择的文字 option' };
    return { ok: true, action: { type: 'selectOption', element, option, reason, memo } };
  }
  if (action === 'hover') {
    const element = data.element == null ? null : Number(data.element);
    const point = Array.isArray(data.point) ? data.point.map(Number) : null;
    if ((element == null || !Number.isInteger(element)) && !(point && point.length === 2 && point.every((v) => Number.isFinite(v)))) {
      return { ok: false, error: 'hover 需要 element 或 point [x,y]' };
    }
    if (element != null && itemCount && element >= itemCount) return { ok: false, error: `element 编号 ${element} 超出清单范围（0~${itemCount - 1}）` };
    const ms = Math.max(100, Math.min(5000, Number(data.ms) || 700));
    return { ok: true, action: { type: 'hover', element: element != null ? element : null, point, ms, reason, memo } };
  }
  if (action === 'drag') {
    const fromElement = data.fromElement == null ? null : Number(data.fromElement);
    const toElement = data.toElement == null ? null : Number(data.toElement);
    const fromPoint = Array.isArray(data.fromPoint) ? data.fromPoint.map(Number) : null;
    const toPoint = Array.isArray(data.toPoint) ? data.toPoint.map(Number) : null;
    const validPoint = (p) => p && p.length === 2 && p.every((v) => Number.isFinite(v));
    const fromOk = (Number.isInteger(fromElement) && fromElement >= 0) || validPoint(fromPoint);
    const toOk = (Number.isInteger(toElement) && toElement >= 0) || validPoint(toPoint);
    if (!fromOk || !toOk) return { ok: false, error: 'drag 需要 fromElement/toElement 或 fromPoint/toPoint' };
    if (itemCount) {
      if (fromElement != null && fromElement >= itemCount) return { ok: false, error: `fromElement 编号超出清单范围（0~${itemCount - 1}）` };
      if (toElement != null && toElement >= itemCount) return { ok: false, error: `toElement 编号超出清单范围（0~${itemCount - 1}）` };
    }
    const durationMs = Math.max(100, Math.min(3000, Number(data.durationMs) || 500));
    return { ok: true, action: { type: 'drag', fromElement, toElement, fromPoint, toPoint, durationMs, reason, memo } };
  }
  if (action === 'scroll') {
    const direction = data.direction === 'up' ? 'up' : 'down';
    const amount = Math.max(100, Math.min(3000, Number(data.amount) || 600));
    return { ok: true, action: { type: 'scroll', direction, amount, reason, memo } };
  }
  if (action === 'wait') {
    const ms = Math.max(100, Math.min(15000, Number(data.ms) || 1000));
    return { ok: true, action: { type: 'wait', ms, reason, memo } };
  }
  if (action === 'back') return { ok: true, action: { type: 'back', reason, memo } };
  if (action === 'done') return { ok: true, action: { type: 'done', reason, memo, summary: String(data.summary || reason || '任务完成').slice(0, 500) } };
  return { ok: true, action: { type: 'fail', reason, memo } };
}
