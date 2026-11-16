<script setup lang="ts">
import { NConfigProvider, NDialogProvider, NMessageProvider, type GlobalThemeOverrides } from 'naive-ui'
import AppShell from './components/AppShell.vue'

const overrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#1F7A5C',
    primaryColorHover: '#175F48',
    primaryColorPressed: '#134E3B',
    primaryColorSuppl: '#1F7A5C',
    errorColor: '#C93B3B',
    warningColor: '#E86A2C',
    successColor: '#1F7A5C',
    infoColor: '#3B6E8F',
    borderRadius: '6px',
    fontFamily: "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
    textColorBase: '#15201C',
    textColor1: '#15201C',
    textColor2: '#39463F',
    textColor3: '#6B7A74',
    borderColor: '#DFE5E1',
    dividerColor: '#DFE5E1',
    bodyColor: '#F4F6F4',
  },
  Card: { borderRadius: '10px' },
  DataTable: {
    thColor: '#FAFBFA',
    tdColor: '#FFFFFF',
    borderColor: '#DFE5E1',
    thFontWeight: '600',
  },
  Button: { fontWeight: '600' },
  Tag: { borderRadius: '4px' },
}
</script>

<template>
  <n-config-provider :theme-overrides="overrides">
    <n-message-provider>
      <n-dialog-provider>
        <AppShell />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>
