import type { GanciApi } from '@shared/types'

declare global {
  interface Window {
    ganci: GanciApi
  }
}

export {}
