import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'

const dbPath = path.join(process.env.APPDATA, '赶词工', 'gancigong.db')
const db = new DatabaseSync(dbPath)
const rounds = db.prepare('select id, planned_at, mode, planned_count, rated_count, status from rounds order by id').all()
const words = db.prepare('select count(*) n from words').get().n
console.log(JSON.stringify({ words, rounds }))
db.close()
