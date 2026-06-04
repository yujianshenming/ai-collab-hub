# Personal Workbench

一个面向 Windows 的 Electron 个人工作台。它把常用网页以常驻 `webview` 标签承载，切换时不会重新加载页面，并提供可拖拽高度的本地 PowerShell 终端。

## 启动

```powershell
cd personal-workbench
npm install
npm start
```

## 功能

- 默认打开评估网站，可添加、编辑和持久化更多网页标签。
- 标签切换只控制显示状态，保留登录、表单输入与滚动位置。
- 地址栏支持后退、前进、停止/刷新与直接导航。
- 底部 PowerShell 面板支持展开、收起和拖动调整高度。
- 扩展设置支持填写 Chrome 扩展 ID，或直接填写已解压扩展目录。

Chrome 扩展配置保存在 Electron 的用户数据目录下，不会把本机路径或隐私配置提交到仓库。首次保存扩展配置后会立即尝试加载；少数扩展可能需要重启应用或不兼容 Electron。

## 安全说明

工作台使用 `contextIsolation` 和受限的 preload IPC，不向网页暴露 Node.js。网页弹出的新窗口会交给系统默认浏览器打开。
