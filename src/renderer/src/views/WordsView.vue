<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  NButton,
  NCheckbox,
  NDataTable,
  NDrawer,
  NDrawerContent,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NPopconfirm,
  NSelect,
  NSpace,
  useMessage,
  type DataTableColumns,
  type DataTableRowKey,
} from 'naive-ui'
import { formatDue } from '@shared/time'
import type { ImportResult, ListInfo, WordInput, WordRow } from '@shared/types'

const message = useMessage()

const lists = ref<ListInfo[]>([])
const activeListId = ref<number | null>(null)
const keyword = ref('')
const needMeaningOnly = ref(false)
const sort = ref<'due' | 'term' | 'lapses' | 'created'>('due')
const page = ref(1)
const pageSize = ref(50)
const rows = ref<WordRow[]>([])
const total = ref(0)
const loading = ref(false)
const checked = ref<DataTableRowKey[]>([])

const editor = reactive({
  open: false,
  id: 0,
  listId: 0,
  form: { term: '', phonetic: '', meaning: '', example: '', tags: '' } as WordInput,
  fromDictionary: false,
})

const importResult = ref<ImportResult | null>(null)
const showImport = computed({
  get: () => importResult.value !== null,
  set: (v: boolean) => {
    if (!v) importResult.value = null
  },
})

const listCreator = reactive({ open: false, name: '' })

const listOptions = computed(() => [
  { label: '全部词表', value: null as unknown as number },
  ...lists.value.map((l) => ({ label: `${l.name}（${l.wordCount}）`, value: l.id })),
])

async function reloadLists(): Promise<void> {
  lists.value = await window.ganci.listsList()
}

async function reloadRows(): Promise<void> {
  loading.value = true
  try {
    const result = await window.ganci.wordsList({
      listId: activeListId.value,
      query: keyword.value.trim(),
      needMeaningOnly: needMeaningOnly.value,
      sort: sort.value,
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
    })
    rows.value = result.rows
    total.value = result.total
  } catch (err) {
    message.error(err instanceof Error ? err.message : '读取词库失败')
  } finally {
    loading.value = false
  }
}

let unsubscribe: (() => void) | null = null
onMounted(async () => {
  await reloadLists()
  await reloadRows()
  unsubscribe = window.ganci.onDataChanged(() => void reloadRows())
})
onBeforeUnmount(() => unsubscribe?.())

watch([activeListId, needMeaningOnly, sort], () => {
  page.value = 1
  void reloadRows()
})
watch(keyword, () => {
  page.value = 1
  void reloadRows()
})

function openCreate(): void {
  editor.id = 0
  editor.listId = activeListId.value ?? lists.value[0]?.id ?? 0
  editor.form = { term: '', phonetic: '', meaning: '', example: '', tags: '' }
  editor.fromDictionary = false
  editor.open = true
}

function openEdit(row: WordRow): void {
  editor.id = row.id
  editor.listId = row.listId
  editor.form = { term: row.term, phonetic: row.phonetic, meaning: row.meaning, example: row.example, tags: row.tags }
  editor.fromDictionary = false
  editor.open = true
}

async function fillFromDictionary(): Promise<void> {
  const term = editor.form.term.trim()
  if (!term) return
  const hit = await window.ganci.dictLookup(term).catch(() => null)
  if (!hit) {
    editor.fromDictionary = false
    return
  }
  if (!editor.form.phonetic) editor.form.phonetic = hit.phonetic
  if (!editor.form.meaning) editor.form.meaning = hit.meaning
  if (!editor.form.tags) editor.form.tags = hit.tags.join(' ')
  editor.fromDictionary = true
}

async function saveWord(): Promise<void> {
  if (!editor.form.term.trim()) {
    message.warning('单词不能为空')
    return
  }
  try {
    // reactive 里的 form 是 Proxy，跨 contextBridge 无法序列化，先拷成普通对象
    const input: WordInput = { ...editor.form }
    if (editor.id) await window.ganci.wordsUpdate(editor.id, input)
    else await window.ganci.wordsCreate(editor.listId, input)
    editor.open = false
    await reloadLists()
    await reloadRows()
    message.success('已保存')
  } catch (err) {
    message.error(err instanceof Error ? err.message : '保存失败')
  }
}

async function removeRows(ids: number[]): Promise<void> {
  try {
    const n = await window.ganci.wordsDelete(ids)
    checked.value = []
    await reloadLists()
    await reloadRows()
    message.success(`已删除 ${n} 个单词`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : '删除失败')
  }
}

async function importCsv(): Promise<void> {
  try {
    const picked = await window.ganci.wordsPickCsv()
    if (!picked) return
    const result = await window.ganci.wordsImport(picked.path, activeListId.value)
    importResult.value = result
    await reloadLists()
    await reloadRows()
  } catch (err) {
    message.error(err instanceof Error ? err.message : '导入失败')
  }
}

async function exportCsv(): Promise<void> {
  try {
    const result = await window.ganci.wordsExport(activeListId.value)
    if (result) message.success(`已导出 ${result.count} 条到 ${result.path}`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : '导出失败')
  }
}

function openListCreator(): void {
  listCreator.name = ''
  listCreator.open = true
}

async function createList(): Promise<void> {
  const name = listCreator.name.trim()
  if (!name) {
    listCreator.open = false
    return
  }
  try {
    const id = await window.ganci.listsCreate(name)
    listCreator.open = false
    await reloadLists()
    activeListId.value = id
    message.success(`已新建词表「${name}」`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : '建表失败')
  }
}

const columns = computed<DataTableColumns<WordRow>>(() => [
  {
    type: 'selection',
  },
  {
    title: '单词',
    key: 'term',
    width: 150,
    render: (row) =>
      h('div', { class: 'flex items-center gap-2' }, [
        row.needMeaning ? h('span', { class: 'inline-block h-3.5 w-[3px] rounded bg-accent' }) : null,
        h('span', { class: 'font-term text-[14px] font-semibold' }, row.term),
      ]),
  },
  { title: '音标', key: 'phonetic', width: 120, render: (row) => h('span', { class: 'num-display text-muted' }, row.phonetic ? `/${row.phonetic}/` : '') },
  {
    title: '释义',
    key: 'meaning',
    ellipsis: { tooltip: true },
    render: (row) =>
      row.meaning
        ? h('span', { class: 'text-ink/85' }, row.meaning)
        : h('span', { class: 'text-accent' }, '待补充'),
  },
  { title: '标签', key: 'tags', width: 130, render: (row) => h('span', { class: 'text-[12px] text-muted' }, row.tags) },
  {
    title: '下次到期',
    key: 'dueAt',
    width: 110,
    render: (row) => h('span', { class: 'num-display text-[12px]' }, formatDue(row.dueAt ?? null, Date.now())),
  },
  { title: '间隔', key: 'intervalDays', width: 66, render: (row) => h('span', { class: 'num-display text-[12px]' }, row.intervalDays ? `${row.intervalDays}天` : '—') },
  {
    title: '复习/遗忘',
    key: 'reps',
    width: 96,
    render: (row) => h('span', { class: 'num-display text-[12px] text-muted' }, `${row.reps ?? 0} / ${row.lapses ?? 0}`),
  },
  {
    title: '操作',
    key: 'ops',
    width: 118,
    render: (row) =>
      h(NSpace, { size: 4, wrap: false }, {
        default: () => [
          h(NButton, { size: 'tiny', text: true, type: 'primary', onClick: () => openEdit(row) }, { default: () => '编辑' }),
          h(
            NPopconfirm,
            { onPositiveClick: () => removeRows([row.id]) },
            {
              default: () => '删除这个单词及其复习记录？',
              trigger: () => h(NButton, { size: 'tiny', text: true, type: 'error' }, { default: () => '删除' }),
            }
          ),
        ],
      }),
  },
])

const summaryLine = computed(() => {
  const r = importResult.value
  if (!r) return ''
  return `新增 ${r.created}，更新 ${r.updated}，跳过 ${r.skipped}`
})
</script>

<template>
  <div class="mx-auto max-w-[1180px] px-8 py-7">
    <header class="flex items-center justify-between">
      <h1 class="text-[20px] font-semibold">词库</h1>
      <div class="text-[12px] text-muted">共 {{ total }} 条 · 数据只在本地</div>
    </header>

    <div class="mt-4 flex flex-wrap items-center gap-2">
      <n-select v-model:value="activeListId" :options="listOptions" class="w-[210px]" size="small" />
      <template v-if="listCreator.open">
        <n-input
          v-model:value="listCreator.name"
          size="small"
          class="w-[150px]"
          placeholder="词表名称"
          @keyup.enter="createList"
          @keyup.esc="listCreator.open = false"
        />
        <n-button size="small" type="primary" @click="createList">确定</n-button>
        <n-button size="small" @click="listCreator.open = false">取消</n-button>
      </template>
      <n-button v-else size="small" @click="openListCreator">新建词表</n-button>
      <n-input v-model:value="keyword" size="small" placeholder="搜索单词或释义" class="w-[220px]" clearable />
      <n-checkbox v-model:checked="needMeaningOnly" size="small">只看待补充释义</n-checkbox>
      <n-select
        v-model:value="sort"
        size="small"
        class="w-[130px]"
        :options="[
          { label: '按到期时间', value: 'due' },
          { label: '按字母', value: 'term' },
          { label: '按遗忘次数', value: 'lapses' },
          { label: '按录入顺序', value: 'created' },
        ]"
      />
      <div class="ml-auto flex gap-2">
        <n-button size="small" type="primary" @click="openCreate">新增单词</n-button>
        <n-button size="small" @click="importCsv">导入 CSV</n-button>
        <n-button size="small" @click="exportCsv">导出 CSV</n-button>
        <n-button v-if="checked.length" size="small" type="error" @click="removeRows(checked.map(Number))">
          删除选中 {{ checked.length }}
        </n-button>
      </div>
    </div>

    <n-data-table
      class="mt-3"
      remote
      :columns="columns"
      :data="rows"
      :loading="loading"
      :row-key="(row: WordRow) => row.id"
      v-model:checked-row-keys="checked"
      :pagination="{ page, pageSize, itemCount: total, showSizePicker: false, onChange: (p: number) => { page = p; void reloadRows() } }"
      size="small"
      max-height="calc(100vh - 250px)"
    />

    <n-drawer v-model:show="editor.open" :width="440" placement="right">
      <n-drawer-content :title="editor.id ? '编辑单词' : '新增单词'" closable>
        <n-form label-placement="top" :show-feedback="false">
          <n-form-item label="单词">
            <n-input v-model:value="editor.form.term" placeholder="abandon" @blur="fillFromDictionary" />
          </n-form-item>
          <n-form-item label="音标">
            <n-input v-model:value="editor.form.phonetic" placeholder="ə'bændən" />
          </n-form-item>
          <n-form-item label="释义">
            <n-input v-model:value="editor.form.meaning" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" placeholder="vt. 放弃；n. 放任" />
          </n-form-item>
          <n-form-item label="例句（可选）">
            <n-input v-model:value="editor.form.example" type="textarea" :autosize="{ minRows: 1, maxRows: 3 }" />
          </n-form-item>
          <n-form-item label="标签（可选）">
            <n-input v-model:value="editor.form.tags" placeholder="四级, 考研" />
          </n-form-item>
          <div v-if="editor.fromDictionary" class="mt-1 text-[12px] text-brand">音标与释义已用离线词典补全</div>
        </n-form>
        <template #footer>
          <n-button type="primary" block @click="saveWord">保存</n-button>
        </template>
      </n-drawer-content>
    </n-drawer>

    <n-modal v-model:show="showImport" preset="card" title="导入结果" class="w-[430px]">
      <div v-if="importResult" class="text-[13px] leading-7">
        <div>{{ importResult.fileName }} · 共解析 {{ importResult.totalRows }} 行</div>
        <div class="mt-2 grid grid-cols-2 gap-2">
          <div class="card-surface px-3 py-2">新增 <b class="num-display">{{ importResult.created }}</b></div>
          <div class="card-surface px-3 py-2">更新 <b class="num-display">{{ importResult.updated }}</b></div>
          <div class="card-surface px-3 py-2">词典补释义 <b class="num-display text-brand">{{ importResult.filledFromDict }}</b></div>
          <div class="card-surface px-3 py-2">仍缺释义 <b class="num-display text-accent">{{ importResult.missingMeaning }}</b></div>
        </div>
        <div v-if="importResult.skipped" class="mt-2 text-muted">跳过重复/无效 {{ importResult.skipped }} 行</div>
        <ul v-if="importResult.errors.length" class="mt-2 list-disc pl-5 text-[12px] text-danger">
          <li v-for="(e, i) in importResult.errors.slice(0, 6)" :key="i">{{ e }}</li>
        </ul>
        <div class="mt-3 text-[12px] text-muted">{{ summaryLine }}</div>
      </div>
      <template #footer>
        <n-button block @click="importResult = null">知道了</n-button>
      </template>
    </n-modal>
  </div>
</template>
