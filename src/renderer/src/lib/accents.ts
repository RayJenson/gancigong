import type { ThemeAccent } from '@shared/types'

export interface AccentModeColors {
  /** 文字、图标、描边用的主色 */
  brand: string
  /** 实心按钮、滑杆、进度条等填充色 */
  fill: string
  /** 填充色悬停态 */
  hover: string
  /** 填充色按下态 */
  press: string
  /** 填充色上的文字 */
  onBrand: string
}

export interface AccentPreset {
  id: ThemeAccent
  name: string
  /** 设置页色点展示色（亮色模式主色） */
  swatch: string
  light: AccentModeColors
  dark: AccentModeColors
}

export const ACCENTS: AccentPreset[] = [
  {
    id: 'pine',
    name: '松柏绿',
    swatch: '#1d5b43',
    light: { brand: '#1d5b43', fill: '#1d5b43', hover: '#174a36', press: '#123a2a', onBrand: '#ffffff' },
    dark: { brand: '#83c9a7', fill: '#3f8f6c', hover: '#4c9f7a', press: '#35795b', onBrand: '#ffffff' },
  },
  {
    id: 'ocean',
    name: '海岛蓝',
    swatch: '#1c5b7d',
    light: { brand: '#1c5b7d', fill: '#1c5b7d', hover: '#164a67', press: '#11394f', onBrand: '#ffffff' },
    dark: { brand: '#8ec7e6', fill: '#2c6f94', hover: '#3581a9', press: '#245c7b', onBrand: '#f2fafe' },
  },
  {
    id: 'sakura',
    name: '樱花粉',
    swatch: '#a8446b',
    light: { brand: '#a8446b', fill: '#a8446b', hover: '#8f3659', press: '#752a48', onBrand: '#ffffff' },
    dark: { brand: '#f0a3c0', fill: '#a34c70', hover: '#b45a7f', press: '#8a3d5d', onBrand: '#fff6fa' },
  },
  {
    id: 'violet',
    name: '暮山紫',
    swatch: '#5e4c92',
    light: { brand: '#5e4c92', fill: '#5e4c92', hover: '#4e3e7a', press: '#3f3164', onBrand: '#ffffff' },
    dark: { brand: '#c5b1ee', fill: '#63519a', hover: '#7260aa', press: '#524283', onBrand: '#f8f4ff' },
  },
  {
    id: 'amber',
    name: '琥珀橙',
    swatch: '#9c5c12',
    light: { brand: '#9c5c12', fill: '#9c5c12', hover: '#814b0d', press: '#673c08', onBrand: '#ffffff' },
    dark: { brand: '#e8b06d', fill: '#9c611b', hover: '#ad6f24', press: '#835114', onBrand: '#fff8ee' },
  },
  {
    id: 'slate',
    name: '烟墨灰',
    swatch: '#45525d',
    light: { brand: '#45525d', fill: '#45525d', hover: '#37434d', press: '#2b353d', onBrand: '#ffffff' },
    dark: { brand: '#b3c1cc', fill: '#53616c', hover: '#5f6e7a', press: '#444f59', onBrand: '#f6fafc' },
  },
]

export const DEFAULT_ACCENT: ThemeAccent = 'pine'

function parseHex(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

/** 把主题色按比例混进中性底色，供 Naive UI 需要具体色值的配置使用 */
export function mixHex(tint: string, percent: number, base: string): string {
  const a = parseHex(tint)
  const b = parseHex(base)
  const k = percent / 100
  const channel = (i: number): string => Math.round(a[i] * k + b[i] * (1 - k)).toString(16).padStart(2, '0')
  return `#${channel(0)}${channel(1)}${channel(2)}`
}

export function isThemeAccent(value: unknown): value is ThemeAccent {
  return typeof value === 'string' && ACCENTS.some((a) => a.id === value)
}

export function accentPreset(id: ThemeAccent | string | null | undefined): AccentPreset {
  return ACCENTS.find((a) => a.id === id) ?? ACCENTS[0]
}
