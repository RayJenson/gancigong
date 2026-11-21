import { createRouter, createWebHashHistory } from 'vue-router'

const routes = [
  { path: '/', name: 'dashboard', component: () => import('@renderer/views/DashboardView.vue'), meta: { title: '主页', nav: 'dashboard' } },
  { path: '/words', name: 'words', component: () => import('@renderer/views/WordsView.vue'), meta: { title: '词库', nav: 'words' } },
  { path: '/settings', name: 'settings', component: () => import('@renderer/views/SettingsView.vue'), meta: { title: '设置', nav: 'settings' } },
  { path: '/stats', name: 'stats', component: () => import('@renderer/views/StatsView.vue'), meta: { title: '统计', nav: 'stats' } },
  { path: '/practice', name: 'practice', component: () => import('@renderer/views/PracticeView.vue'), meta: { title: '练习', nav: 'dashboard' } },
  { path: '/learn', name: 'learn', component: () => import('@renderer/views/LearnView.vue'), meta: { title: '背单词', immersive: true } },
  { path: '/wrongs', name: 'wrongs', component: () => import('@renderer/views/WrongsView.vue'), meta: { title: '错词本', nav: 'wrongs' } },
  // 复习弹窗、副屏遮罩与桌面悬浮球都是独立窗口，不带应用外壳
  { path: '/review', name: 'review', component: () => import('@renderer/views/ReviewView.vue'), meta: { bare: true } },
  { path: '/cover', name: 'cover', component: () => import('@renderer/views/CoverView.vue'), meta: { bare: true } },
  { path: '/float', name: 'float', component: () => import('@renderer/views/FloatBallView.vue'), meta: { title: '悬浮球', bare: true, floatWindow: true } },
  { path: '/float-menu', name: 'float-menu', component: () => import('@renderer/views/FloatMenuView.vue'), meta: { title: '快捷菜单', bare: true, floatWindow: true } },
  // 认不出的 hash 别停在空白页
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export default createRouter({
  history: createWebHashHistory(),
  routes,
})

export type NavKey = 'dashboard' | 'words' | 'wrongs' | 'settings' | 'stats'
