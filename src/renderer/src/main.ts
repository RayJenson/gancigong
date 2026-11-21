import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { applyCachedTheme } from './lib/theme'
import './assets/main.css'

applyCachedTheme()

// 桌面端不需要浏览器默认右键菜单（刷新/另存为/检查等）
window.addEventListener('contextmenu', (e) => e.preventDefault(), { capture: true })

async function start(): Promise<void> {
  if (!window.ganci) {
    if ('__TAURI_INTERNALS__' in window) await import('./tauri-api')
    else await import('./tauri-mock')
  }
  const app = createApp(App)
  app.use(createPinia())
  app.use(router)
  // 等初始路由解析完再挂载：否则悬浮球/复习窗口首帧会按非 bare 路由跑一遍 AppShell，
  // 注册上全局事件监听，被主窗口的导航事件带着跳页
  await router.isReady()
  app.mount('#app')
}

void start()
