import { createRouter, createWebHashHistory } from 'vue-router'

const routes = [
  { path: '/', name: 'dashboard', component: () => import('@renderer/views/DashboardView.vue'), meta: { title: '复习台', nav: 'dashboard' } },
  { path: '/words', name: 'words', component: () => import('@renderer/views/WordsView.vue'), meta: { title: '词库', nav: 'words' } },
  { path: '/settings', name: 'settings', component: () => import('@renderer/views/SettingsView.vue'), meta: { title: '设置', nav: 'settings' } },
  { path: '/stats', name: 'stats', component: () => import('@renderer/views/StatsView.vue'), meta: { title: '统计', nav: 'stats' } },
  { path: '/practice', name: 'practice', component: () => import('@renderer/views/PracticeView.vue'), meta: { title: '练习', nav: 'dashboard' } },
  // 复习弹窗与副屏遮罩不带应用外壳
  { path: '/review', name: 'review', component: () => import('@renderer/views/ReviewView.vue'), meta: { bare: true } },
  { path: '/cover', name: 'cover', component: () => import('@renderer/views/CoverView.vue'), meta: { bare: true } },
  // 认不出的 hash 别停在空白页
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export default createRouter({
  history: createWebHashHistory(),
  routes,
})

export type NavKey = 'dashboard' | 'words' | 'settings' | 'stats'
