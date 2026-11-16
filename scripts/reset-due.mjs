/**
 * 探针辅助：把全部学习记录的到期时间拉回「现在」，让复习探针可以反复跑。
 * 用 ELECTRON_RUN_AS_NODE 走 Electron 自带的 node:sqlite，不引入原生依赖。
 */
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dir = process.platform === 'win32' ? join(process.env.APPDATA, '赶词工') : join(homedir(), '.config', '赶词工')
const db = new DatabaseSync(join(dir, 'gancigong.db'))
db.exec('pragma busy_timeout = 5000')
const now = Date.now()
const r = db.prepare('update word_states set due_at = ? where due_at > ?').run(now, now)
db.close()
console.log(`已把 ${r.changes} 条记录的到期时间提前到现在`)
