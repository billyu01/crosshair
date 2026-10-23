// Chrome DevTools Protocol 封装：截图、真实鼠标点击、页面取值、原生弹窗处理。
// 依赖 chrome.debugger 权限。所有坐标都是"视口 CSS 像素"，原点在视口左上角。

export class CdpError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CdpError';
  }
}

export class DebuggerSession {
  constructor(tabId) {
    this.tabId = tabId;
    this.attached = false;
    this._eventListeners = new Set();
    this._onDebuggerEvent = (source, method, params) => {
      if (source.tabId !== this.tabId) return;
      for (const listener of this._eventListeners) {
        try {
          listener(method, params);
        } catch (error) {
          console.debug('[准星] 调试事件处理异常', error);
        }
      }
    };
  }

  async attach() {
    if (this.attached) return;
    try {
      await chrome.debugger.attach({ tabId: this.tabId }, '1.3');
    } catch (error) {
      const message = String(error?.message || error);
      if (message.includes('Another debugger is already attached')) {
        throw new CdpError('这个标签页已经被其他调试器（比如 DevTools）占用，请先关闭开发者工具再试。');
      }
      throw new CdpError(`无法连接浏览器调试接口：${message}`);
    }
    this.attached = true;
    chrome.debugger.onEvent.addListener(this._onDebuggerEvent);
    await this.send('Page.enable');
    await this.send('Runtime.enable');
  }

  async detach() {
    if (!this.attached) return;
    chrome.debugger.onEvent.removeListener(this._onDebuggerEvent);
    try {
      await chrome.debugger.detach({ tabId: this.tabId });
    } catch {
      // 标签页可能已经被关闭
    }
    this.attached = false;
  }

  onEvent(listener) {
    this._eventListeners.add(listener);
    return () => this._eventListeners.delete(listener);
  }

  async send(method, params = {}, timeoutMs = 20000) {
    let timer = null;
    try {
      const command = chrome.debugger.sendCommand({ tabId: this.tabId }, method, params);
      const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new CdpError(`${method} 超时（${Math.round(timeoutMs / 1000)} 秒没有响应）`)), timeoutMs);
      });
      return await Promise.race([command, timeout]);
    } catch (error) {
      throw error instanceof CdpError ? error : new CdpError(`${method} 失败：${error?.message || error}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result?.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text || '页面脚本执行异常';
      throw new CdpError(text);
    }
    return result?.result?.value;
  }

  // 截取当前视口，返回 { data: base64(jpeg), width, height }。
  // 注意：返回的像素尺寸可能等于视口 × devicePixelRatio。
  async captureScreenshot(quality = 72) {
    const shot = await this.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality,
      captureBeyondViewport: false,
      fromSurface: true,
    });
    if (!shot?.data) throw new CdpError('截图失败：没有拿到图片数据');
    const size = await this.evaluate(
      `(() => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 }))()`,
    );
    return {
      data: shot.data,
      cssWidth: size?.w || 0,
      cssHeight: size?.h || 0,
      dpr: size?.dpr || 1,
    };
  }

  // 真实鼠标点击（事件 isTrusted = true），坐标是视口 CSS 像素。
  async click(x, y) {
    const px = Math.round(x);
    const py = Math.round(y);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: px,
      y: py,
      button: 'none',
      pointerType: 'mouse',
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: px,
      y: py,
      button: 'left',
      buttons: 1,
      clickCount: 1,
      pointerType: 'mouse',
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: px,
      y: py,
      button: 'left',
      buttons: 0,
      clickCount: 1,
      pointerType: 'mouse',
    });
  }

  // 向当前聚焦的输入框插入文字（触发真实 input 事件，适配受控组件）。
  async insertText(text) {
    await this.send('Input.insertText', { text: String(text == null ? '' : text) });
  }

  // 发送按键（Enter/Escape/Tab 等）。
  async pressKey(key) {
    const map = {
      Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
      Escape: { key: 'Escape', code: 'Escape', keyCode: 27, text: '' },
      Tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
      ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, text: '' },
      ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, text: '' },
      Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8, text: '' },
    };
    const info = map[key] || map.Enter;
    await this.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.keyCode,
      nativeVirtualKeyCode: info.keyCode,
    });
    if (info.text) {
      await this.send('Input.dispatchKeyEvent', {
        type: 'char',
        key: info.key,
        code: info.code,
        text: info.text,
        windowsVirtualKeyCode: info.keyCode,
      });
    }
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.keyCode,
      nativeVirtualKeyCode: info.keyCode,
    });
  }

  // 鼠标悬停（不点击），用于让图表/菜单弹出 tooltip。
  async hover(x, y) {
    const px = Math.round(x);
    const py = Math.round(y);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px - 6, y: py - 6, button: 'none', pointerType: 'mouse' });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none', pointerType: 'mouse' });
  }

  // 拖拽：按下 → 分步移动 → 松开（用于滑块、范围选择、可拖动卡片等）。
  async drag(fromX, fromY, toX, toY, durationMs = 500) {
    const fx = Math.round(fromX);
    const fy = Math.round(fromY);
    const tx = Math.round(toX);
    const ty = Math.round(toY);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fx, y: fy, button: 'none', pointerType: 'mouse' });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fx, y: fy, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    const steps = Math.max(4, Math.min(24, Math.round((durationMs || 500) / 40)));
    for (let i = 1; i <= steps; i += 1) {
      const x = Math.round(fx + ((tx - fx) * i) / steps);
      const y = Math.round(fy + ((ty - fy) * i) / steps);
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1, pointerType: 'mouse' });
      await new Promise((resolve) => setTimeout(resolve, Math.max(8, Math.round((durationMs || 500) / steps))));
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  }

  // 读取页面基础状态，用于判断是否就绪。
  async pageInfo() {
    return await this.evaluate(`(() => {
      const body = document.body;
      const text = body ? body.innerText || '' : '';
      let hash = 2166136261;
      const sample = text.slice(0, 30000);
      for (let i = 0; i < sample.length; i += 1) {
        hash ^= sample.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      return {
        ready: document.readyState,
        url: location.href,
        title: document.title,
        scrollY: window.scrollY,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
        textLen: text.length,
        sig: hash.toString(16),
      };
    })()`);
  }
}
