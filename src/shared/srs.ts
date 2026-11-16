import type { Rating } from './types'

/** 认识后的间隔阶梯（天）；超出取最后一个 */
export const INTERVAL_LADDER = [1, 2, 4, 8, 16, 30]
export const FORGET_INTERVAL = 1

/**
 * 标记「认识」后的新间隔：0（新词）→ 1，其后按阶梯翻倍，30 天封顶。
 * 阶梯位置由当前间隔在 ladder 中的索引决定，间隔被外力改大也不会跳档。
 */
export function intervalAfterKnow(currentDays: number): number {
  const idx = INTERVAL_LADDER.findIndex((v) => v > currentDays)
  return idx === -1 ? INTERVAL_LADDER[INTERVAL_LADDER.length - 1] : INTERVAL_LADDER[idx]
}

export function intervalAfterForget(): number {
  return FORGET_INTERVAL
}

export function applyRating(currentDays: number, rating: Rating): number {
  return rating === 1 ? intervalAfterKnow(currentDays) : intervalAfterForget()
}

/** 掌握度：间隔爬到 8 天以上算已掌握 */
export const MASTERED_FROM_DAYS = 8

export function isMastered(intervalDays: number | undefined): boolean {
  return (intervalDays ?? 0) >= MASTERED_FROM_DAYS
}
