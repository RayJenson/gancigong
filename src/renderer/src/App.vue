<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import {
  darkTheme,
  dateZhCN,
  NConfigProvider,
  NDialogProvider,
  NMessageProvider,
  zhCN,
  type GlobalThemeOverrides,
} from 'naive-ui'
import AppShell from './components/AppShell.vue'
import { mixHex, type AccentModeColors } from './lib/accents'
import { useAppStore } from './stores/app'

const store = useAppStore()
const route = useRoute()
/** 悬浮球/快捷菜单是透明窗口，不能铺自定义壁纸 */
const floatWindow = computed(() => route.meta.floatWindow === true)

onMounted(() => {
  void store.initTheme()
})

const fontFamily = "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif"

const activeColors = computed<AccentModeColors>(() =>
  store.resolvedTheme === 'dark' ? store.activeAccent.dark : store.activeAccent.light
)

const lightOverrides = computed<GlobalThemeOverrides>(() => {
  const c = activeColors.value
  return {
    common: {
      primaryColor: c.fill,
      primaryColorHover: c.hover,
      primaryColorPressed: c.press,
      primaryColorSuppl: c.fill,
      errorColor: '#B23A3A',
      warningColor: '#C2792C',
      successColor: '#1D5B43',
      infoColor: '#3B6E8F',
      borderRadius: '8px',
      fontFamily,
      textColorBase: '#1C241F',
      textColor1: '#1C241F',
      textColor2: '#39463F',
      textColor3: '#6E7A72',
      borderColor: '#E4DFD3',
      dividerColor: '#E4DFD3',
      bodyColor: '#F4F1E9',
      cardColor: '#FFFDF8',
      modalColor: '#FFFDF8',
      popoverColor: '#FFFDF8',
    },
    Card: { borderRadius: '14px' },
    DataTable: {
      thColor: '#FAF7EF',
      tdColor: '#FFFDF8',
      borderColor: '#E4DFD3',
      thFontWeight: '600',
    },
    Button: { fontWeight: '600', textColorTextPrimary: c.brand },
    Tag: { borderRadius: '4px' },
  }
})

const darkOverrides = computed<GlobalThemeOverrides>(() => {
  const c = activeColors.value
  const surface = mixHex(c.fill, 13, '#121716')
  const surface2 = mixHex(c.fill, 16, '#141a18')
  const line = mixHex(c.fill, 22, '#262b28')
  return {
    common: {
      primaryColor: c.fill,
      primaryColorHover: c.hover,
      primaryColorPressed: c.press,
      primaryColorSuppl: c.fill,
      errorColor: '#D97A7A',
      warningColor: '#D9A05C',
      successColor: '#57A984',
      infoColor: '#6AA5C4',
      borderRadius: '8px',
      fontFamily,
      textColorBase: '#E9EEE9',
      textColor1: '#E9EEE9',
      textColor2: '#C3CDC6',
      textColor3: '#94A59B',
      borderColor: line,
      dividerColor: line,
      bodyColor: mixHex(c.fill, 6, '#0b0e0d'),
      cardColor: surface,
      modalColor: surface,
      popoverColor: surface2,
    },
    Card: { borderRadius: '14px' },
    DataTable: {
      thColor: surface2,
      tdColor: surface,
      borderColor: line,
      thFontWeight: '600',
    },
    Button: {
      fontWeight: '600',
      textColorPrimary: c.onBrand,
      textColorHoverPrimary: c.onBrand,
      textColorPressedPrimary: c.onBrand,
      textColorFocusPrimary: c.onBrand,
      textColorTextPrimary: c.brand,
      textColorTextHoverPrimary: c.brand,
      textColorTextPressedPrimary: c.brand,
    },
    Tag: { borderRadius: '4px' },
  }
})
</script>

<template>
  <div v-if="store.themeBackgroundUrl && !floatWindow" class="skin-bg" aria-hidden="true">
    <!-- 用 img 承载大图：CSS 变量的值长度有上限，data URL 超过约 2MB 会被浏览器丢弃 -->
    <img class="skin-image" :src="store.themeBackgroundUrl" alt="" draggable="false" decoding="async" />
    <div class="skin-scrim" />
  </div>

  <n-config-provider
    :theme="store.resolvedTheme === 'dark' ? darkTheme : null"
    :theme-overrides="store.resolvedTheme === 'dark' ? darkOverrides : lightOverrides"
    :locale="zhCN"
    :date-locale="dateZhCN"
  >
    <n-message-provider>
      <n-dialog-provider>
        <AppShell />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<style scoped>
.skin-bg {
  position: fixed;
  inset: 0;
  /* 低于内容但高于 body 背景：#app 已建立层叠上下文 */
  z-index: -1;
  overflow: hidden;
  contain: strict;
  /* 固定背景单独成层，滚动时不再重绘整张壁纸 */
  will-change: transform;
  pointer-events: none;
}

.skin-image {
  position: absolute;
  inset: 0;
  height: 100%;
  width: 100%;
  object-fit: cover;
  object-position: center;
  user-select: none;
}

.skin-scrim {
  position: absolute;
  inset: 0;
  background: var(--canvas);
  opacity: calc(0.94 - var(--skin-strength) * 0.82);
  transition: opacity 200ms ease;
}
</style>
