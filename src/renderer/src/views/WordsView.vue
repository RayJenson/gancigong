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
import { formatDue, formatInterval } from '@shared/time'
import type { ImportResult, ListInfo, UnitInfo, WordInput, WordRow } from '@shared/types'

const message = useMessage()

const lists = ref<ListInfo[]>([])
const units = ref<UnitInfo[]>([])
const activeListId = ref<number | null>(null)
/** null = 整个词表，0 = 未分单元，>0 = 指定单元 */
const activeUnitId = ref<number | null>(null)
const keyword = ref('')
const needMeaningOnly = ref(false)
const sort = ref<'due' | 'term' | 'lapses' | 'created'>('due')
const page = ref(1)
const pageSize = ref(50)
const rows = ref<WordRow[]>([])
const total = ref(0)
const loading = ref(false)
const checked = ref<DataTableRowKey[]>([])

const activeList = computed(() => lists.value.find((l) => l.id === activeListId.value) ?? null)
const totalWords = computed(() => lists.value.reduce((sum, l) => sum + l.wordCount, 0))
const unassignedCount = computed(() => {
  if (!activeList.value) return 0
  return Math.max(0, activeList.value.wordCount - units.value.reduce((sum, u) => sum + u.wordCount, 0))
})
const scopeTitle = computed(() => {
  if (!activeList.value) return '全部词表 · 全部单词'
  if (activeUnitId.value === null) return `${activeList.value.name} · 全部单词`
  if (activeUnitId.value === 0) return `${activeList.value.name} · 未分单元`
  const unit = units.value.find((u) => u.id === activeUnitId.value)
  return `${activeList.value.name} · ${unit?.name ?? '单元'}`
})

const editor = reactive({
  open: false,
  id: 0,
  listId: 0,
  form: { term: '', phonetic: '', meaning: '', example: '', tags: '', unitId: 0 } as WordInput,
  fromDictionary: false,
})
const editorUnits = ref<UnitInfo[]>([])
const editorListOptions = computed(() => lists.value.map((l) => ({ label: l.name, value: l.id })))
const editorUnitOptions = computed(() => [
  { label: '未分单元', value: 0 },
  ...editorUnits.value.map((u) => ({ label: `${u.name}（${u.wordCount}）`, value: u.id })),
])

const nameDialog = reactive({
  open: false,
  title: '',
  value: '',
  action: '' as 'list-create' | 'list-rename' | 'unit-create' | 'unit-rename',
  id: 0,
})

const importConfig = reactive({
  open: false,
  listId: null as number | null,
  unitId: 0 as number | null,
})
const importUnits = ref<UnitInfo[]>([])
const importListOptions = computed(() => [
  { label: '按 CSV 的词表列（没有就进第一个词表）', value: null as unknown as number },
  ...lists.value.map((l) => ({ label: `${l.name}（${l.wordCount}）`, value: l.id })),
])
const importUnitOptions = computed(() => [
  { label: '跟随 CSV 的「单元」列（没有就留空）', value: 0 },
  ...importUnits.value.map((u) => ({ label: u.name, value: u.id })),
])

const importResult = ref<ImportResult | null>(null)
const showImport = computed({
  get: () => importResult.value !== null,
  set: (v: boolean) => {
    if (!v) importResult.value = null
  },
})

const move = reactive({ open: false, unitId: 0 as number | null })
const moveUnitOptions = computed(() => [
  { label: '未分单元', value: 0 },
  ...units.value.map((u) => ({ label: `${u.name}（${u.wordCount}）`, value: u.id })),
])

async function reloadLists(): Promise<void> {
  lists.value = await window.ganci.listsList()
}

async function reloadUnits(): Promise<void> {
  if (activeListId.value === null) {
    units.value = []
    return
  }
  units.value = await window.ganci.unitsList(activeListId.value)
}

async function reloadRows(): Promise<void> {
  loading.value = true
  try {
    const result = await window.ganci.wordsList({
      listId: activeListId.value,
      unitId: activeUnitId.value,
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

async function reloadAll(): Promise<void> {
  await reloadLists()
  await reloadUnits()
  await reloadRows()
}

let unsubscribe: (() => void) | null = null
onMounted(async () => {
  await reloadLists()
  await reloadRows()
  unsubscribe = window.ganci.onDataChanged(() => void reloadAll())
})
onBeforeUnmount(() => unsubscribe?.())

function selectList(id: number | null): void {
  if (activeListId.value === id) return
  activeListId.value = id
  activeUnitId.value = null
}

watch(activeListId, async () => {
  await reloadUnits()
  page.value = 1
  void reloadRows()
})
watch(activeUnitId, () => {
  page.value = 1
  void reloadRows()
})
watch([needMeaningOnly, sort], () => {
  page.value = 1
  void reloadRows()
})
watch(keyword, () => {
  page.value = 1
  void reloadRows()
})

function openNameDialog(
  action: 'list-create' | 'list-rename' | 'unit-create' | 'unit-rename',
  id: number,
  title: string,
  value: string
): void {
  nameDialog.action = action
  nameDialog.id = id
  nameDialog.title = title
  nameDialog.value = value
  nameDialog.open = true
}

async function submitName(): Promise<void> {
  const name = nameDialog.value.trim()
  if (!name) {
    message.warning('名称不能为空')
    return
  }
  try {
    if (nameDialog.action === 'list-create') {
      const id = await window.ganci.listsCreate(name)
      nameDialog.open = false
      await reloadLists()
      activeListId.value = id
      message.success(`已新建词表「${name}」`)
      return
    }
    let createdUnitId: number | null = null
    if (nameDialog.action === 'list-rename') await window.ganci.listsRename(nameDialog.id, name)
    if (nameDialog.action === 'unit-create') createdUnitId = await window.ganci.unitsCreate(nameDialog.id, name)
    if (nameDialog.action === 'unit-rename') await window.ganci.unitsRename(nameDialog.id, name)
    nameDialog.open = false
    await reloadAll()
    if (createdUnitId !== null) activeUnitId.value = createdUnitId
    message.success('已保存')
  } catch (err) {
    message.error(err instanceof Error ? err.message : '保存失败')
  }
}

async function removeList(): Promise<void> {
  const list = activeList.value
  if (!list) return
  try {
    const n = await window.ganci.listsDelete(list.id)
    activeListId.value = null
    activeUnitId.value = null
    await reloadAll()
    message.success(`已删除词表「${list.name}」及其 ${n} 个单词`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : '删除词表失败')
  }
}

async function removeUnit(unit: UnitInfo): Promise<void> {
  try {
    const n = await window.ganci.unitsDelete(unit.id)
    if (activeUnitId.value === unit.id) activeUnitId.value = null
    await reloadAll()
    message.success(n ? `单元已删除，${n} 个单词回到未分单元` : '单元已删除')
  } catch (err) {
    message.error(err instanceof Error ? err.message : '删除单元失败')
  }
}

async function loadEditorUnits(): Promise<void> {
  editorUnits.value = editor.listId > 0 ? await window.ganci.unitsList(editor.listId) : []
}

async function onEditorListChange(listId: number): Promise<void> {
  editor.listId = listId
  editor.form.unitId = 0
  await loadEditorUnits()
}

async function openCreate(): Promise<void> {
  editor.id = 0
  editor.listId = activeListId.value ?? lists.value[0]?.id ?? 0
  if (!editor.listId) {
    message.warning('先新建一个词表')
    return
  }
  editor.form = {
    term: '',
    phonetic: '',
    meaning: '',
    example: '',
    tags: '',
    unitId: activeUnitId.value !== null && activeUnitId.value > 0 ? activeUnitId.value : 0,
  }
  editor.fromDictionary = false
  await loadEditorUnits()
  editor.open = true
}

async function openEdit(row: WordRow): Promise<void> {
  editor.id = row.id
  editor.listId = row.listId
  editor.form = {
    term: row.term,
    phonetic: row.phonetic,
    meaning: row.meaning,
    example: row.example,
    tags: row.tags,
    unitId: row.unitId ?? 0,
  }
  editor.fromDictionary = false
  await loadEditorUnits()
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
    const input: WordInput = { ...editor.form, unitId: editor.form.unitId || 0 }
    if (editor.id) await window.ganci.wordsUpdate(editor.id, input)
    else await window.ganci.wordsCreate(editor.listId, input)
    editor.open = false
    await reloadAll()
    message.success('已保存')
  } catch (err) {
    message.error(err instanceof Error ? err.message : '保存失败')
  }
}

async function removeRows(ids: number[]): Promise<void> {
  try {
    const n = await window.ganci.wordsDelete(ids)
    checked.value = []
    await reloadAll()
    message.success(`已删除 ${n} 个单词`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : '删除失败')
  }
}

function openImport(): void {
  importConfig.listId = activeListId.value ?? lists.value[0]?.id ?? null
  importConfig.unitId = activeUnitId.value !== null && activeUnitId.value > 0 ? activeUnitId.value : 0
  importConfig.open = true
  void loadImportUnits()
}

async function loadImportUnits(): Promise<void> {
  if (importConfig.listId === null) {
    importUnits.value = []
    importConfig.unitId = 0
    return
  }
  importUnits.value = await window.ganci.unitsList(importConfig.listId)
  if (!importUnits.value.some((u) => u.id === importConfig.unitId)) importConfig.unitId = 0
}

async function onImportListChange(listId: number | null): Promise<void> {
  importConfig.listId = listId
  importConfig.unitId = 0
  await loadImportUnits()
}

async function pickAndImport(): Promise<void> {
  try {
    const picked = await window.ganci.wordsPickCsv()
    if (!picked) return
    const unitId = importConfig.listId === null ? null : importConfig.unitId || null
    const result = await window.ganci.wordsImport(picked.path, importConfig.listId, unitId)
    importConfig.open = false
    importResult.value = result
    await reloadAll()
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

function openMove(): void {
  move.unitId = 0
  move.open = true
}

async function applyMove(): Promise<void> {
  const ids = checked.value.map(Number)
  try {
    const n = await window.ganci.wordsMove(ids, move.unitId || null)
    move.open = false
    checked.value = []
    await reloadAll()
    message.success(`已移动 ${n} 个单词`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : '移动失败')
  }
}

const columns = computed<DataTableColumns<WordRow>>(() => [
  {
    type: 'selection',
    fixed: 'left',
  },
  {
    title: '单词',
    key: 'term',
    width: 140,
    fixed: 'left',
    render: (row) =>
      h('div', { class: 'flex items-center gap-2' }, [
        row.needMeaning ? h('span', { class: 'inline-block h-3.5 w-[3px] rounded bg-accent' }) : null,
        h('span', { class: 'font-term text-[14px] font-semibold' }, row.term),
      ]),
  },
  { title: '音标', key: 'phonetic', width: 104, render: (row) => h('span', { class: 'num-display text-muted' }, row.phonetic ? `/${row.phonetic}/` : '') },
  {
    title: '单元',
    key: 'unitName',
    width: 96,
    ellipsis: { tooltip: true },
    render: (row) =>
      row.unitName
        ? h('span', { class: 'text-[12px]' }, row.unitName)
        : h('span', { class: 'text-[12px] text-muted' }, '未分单元'),
  },
  {
    title: '释义',
    key: 'meaning',
    ellipsis: { tooltip: true },
    render: (row) =>
      row.meaning
        ? h('span', { class: 'text-ink/85' }, row.meaning)
        : h('span', { class: 'text-accent' }, '待补充'),
  },
  { title: '标签', key: 'tags', width: 108, ellipsis: { tooltip: true }, render: (row) => h('span', { class: 'text-[12px] text-muted' }, row.tags) },
  {
    title: '下次到期',
    key: 'dueAt',
    width: 98,
    render: (row) => h('span', { class: 'num-display text-[12px]' }, formatDue(row.dueAt ?? null, Date.now())),
  },
  {
    title: '间隔',
    key: 'intervalMinutes',
    width: 76,
    render: (row) =>
      h(
        'span',
        { class: 'num-display text-[12px]' },
        formatInterval(row.intervalMinutes ?? (row.intervalDays ? row.intervalDays * 1_440 : 0))
      ),
  },
  {
    title: '复习/遗忘',
    key: 'reps',
    width: 86,
    render: (row) => h('span', { class: 'num-display text-[12px] text-muted' }, `${row.reps ?? 0} / ${row.lapses ?? 0}`),
  },
  {
    title: '操作',
    key: 'ops',
    width: 104,
    fixed: 'right',
    render: (row) =>
      h(NSpace, { size: 4, wrap: false }, {
        default: () => [
          h(NButton, { size: 'tiny', text: true, type: 'primary', onClick: () => void openEdit(row) }, { default: () => '编辑' }),
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
  <div class="mx-auto max-w-[1260px] px-8 py-7">
    <header class="flex items-center justify-between">
      <h1 class="text-[20px] font-semibold">词库</h1>
      <div class="num-display text-[12px] text-muted">共 {{ totalWords }} 个单词 · 数据只在本地</div>
    </header>

    <div class="mt-4 flex gap-4">
      <aside class="w-[228px] shrink-0">
        <div class="card-surface p-3">
          <div class="flex items-center justify-between">
            <span class="text-[13px] font-semibold">词库</span>
            <n-button size="tiny" text type="primary" @click="openNameDialog('list-create', 0, '新建词表', '')">
              + 新建
            </n-button>
          </div>

          <div class="mt-2">
            <button class="nav-row" :class="{ 'nav-row--active': activeListId === null }" @click="selectList(null)">
              <span class="truncate">全部词表</span>
              <span class="nav-count">{{ totalWords }}</span>
            </button>

            <div v-for="l in lists" :key="l.id">
              <button class="nav-row" :class="{ 'nav-row--active': activeListId === l.id }" @click="selectList(l.id)">
                <span class="truncate">{{ l.name }}</span>
                <span class="nav-count">{{ l.wordCount }}</span>
              </button>

              <div v-if="activeListId === l.id" class="ml-2 border-l border-line pl-2">
                <div class="flex items-center justify-between px-1 pt-1">
                  <span class="text-[11px] text-muted">单元</span>
                  <span class="flex items-center gap-1">
                    <n-button size="tiny" text type="primary" @click="openNameDialog('unit-create', l.id, '新建单元', '')">
                      新建
                    </n-button>
                    <n-button size="tiny" text @click="openNameDialog('list-rename', l.id, '重命名词表', l.name)">
                      改名
                    </n-button>
                    <n-popconfirm @positive-click="removeList">
                      <template #trigger>
                        <n-button size="tiny" text type="error">删除</n-button>
                      </template>
                      删除词表「{{ l.name }}」及其中 {{ l.wordCount }} 个单词？
                    </n-popconfirm>
                  </span>
                </div>

                <button
                  class="nav-row"
                  :class="{ 'nav-row--active': activeUnitId === null }"
                  @click="activeUnitId = null"
                >
                  <span class="truncate">全部单词</span>
                  <span class="nav-count">{{ l.wordCount }}</span>
                </button>

                <div v-for="u in units" :key="u.id" class="group flex items-center">
                  <button
                    class="nav-row min-w-0 flex-1"
                    :class="{ 'nav-row--active': activeUnitId === u.id }"
                    @click="activeUnitId = u.id"
                  >
                    <span class="truncate">{{ u.name }}</span>
                    <span class="nav-count">{{ u.wordCount }}</span>
                  </button>
                  <span class="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                    <n-button
                      size="tiny"
                      text
                      @click.stop="openNameDialog('unit-rename', u.id, '重命名单元', u.name)"
                    >
                      改
                    </n-button>
                    <n-popconfirm @positive-click="removeUnit(u)">
                      <template #trigger>
                        <n-button size="tiny" text type="error" @click.stop>删</n-button>
                      </template>
                      删除单元「{{ u.name }}」？其中 {{ u.wordCount }} 个单词会回到未分单元。
                    </n-popconfirm>
                  </span>
                </div>

                <button
                  class="nav-row"
                  :class="{ 'nav-row--active': activeUnitId === 0 }"
                  @click="activeUnitId = 0"
                >
                  <span class="truncate">未分单元</span>
                  <span class="nav-count">{{ unassignedCount }}</span>
                </button>
              </div>
            </div>

            <div v-if="!lists.length" class="px-2 py-3 text-[12px] text-muted">
              还没有词表，点右上角「新建」或直接导入 CSV。
            </div>
          </div>
        </div>
      </aside>

      <div class="min-w-0 flex-1">
        <div class="flex items-baseline justify-between">
          <h2 class="text-[14px] font-semibold">{{ scopeTitle }}</h2>
          <span class="num-display text-[12px] text-muted">当前 {{ total }} 条</span>
        </div>

        <div class="mt-3 flex flex-wrap items-center gap-2">
          <n-input v-model:value="keyword" size="small" placeholder="搜索单词或释义" style="width: 200px" clearable />
          <n-checkbox v-model:checked="needMeaningOnly" size="small">只看待补充释义</n-checkbox>
          <n-select
            v-model:value="sort"
            size="small"
            style="width: 128px"
            :options="[
              { label: '按到期时间', value: 'due' },
              { label: '按字母', value: 'term' },
              { label: '按遗忘次数', value: 'lapses' },
              { label: '按录入顺序', value: 'created' },
            ]"
          />
          <div class="ml-auto flex flex-wrap gap-2">
            <n-button v-if="activeListId !== null && checked.length" size="small" @click="openMove">
              移到单元 {{ checked.length }}
            </n-button>
            <n-popconfirm v-if="checked.length" @positive-click="removeRows(checked.map(Number))">
              <template #trigger>
                <n-button size="small" type="error">删除选中 {{ checked.length }}</n-button>
              </template>
              删除选中的 {{ checked.length }} 个单词及其复习记录？此操作不可撤销。
            </n-popconfirm>
            <n-button size="small" type="primary" @click="openCreate">新增单词</n-button>
            <n-button size="small" @click="openImport">导入 CSV</n-button>
            <n-button size="small" @click="exportCsv">导出 CSV</n-button>
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
          max-height="calc(100vh - 280px)"
        />
      </div>
    </div>

    <n-drawer v-model:show="editor.open" :width="460" placement="right">
      <n-drawer-content :title="editor.id ? '编辑单词' : '新增单词'" closable>
        <n-form label-placement="top" :show-feedback="false">
          <n-form-item label="所属词表">
            <n-select
              :value="editor.listId"
              :options="editorListOptions"
              :disabled="editor.id > 0"
              @update:value="onEditorListChange"
            />
          </n-form-item>
          <n-form-item label="所属单元">
            <n-select v-model:value="editor.form.unitId" :options="editorUnitOptions" />
          </n-form-item>
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

    <n-modal v-model:show="importConfig.open" preset="card" title="导入 CSV" style="width: 470px; max-width: calc(100vw - 40px)">
      <n-form label-placement="top" :show-feedback="false">
        <n-form-item label="导入到词表">
          <n-select :value="importConfig.listId" :options="importListOptions" @update:value="onImportListChange" />
        </n-form-item>
        <n-form-item label="导入到单元">
          <n-select v-model:value="importConfig.unitId" :options="importUnitOptions" :disabled="importConfig.listId === null" />
        </n-form-item>
      </n-form>
      <div class="mt-1 text-[12px] leading-5 text-muted">
        表头支持 单词 / 释义 / 音标 / 例句 / 标签 / 词表 / 单元。不指定单元时按 CSV 的「单元」列自动分组；没有该列就留在未分单元。
      </div>
      <template #footer>
        <div class="flex gap-2">
          <n-button class="flex-1" @click="importConfig.open = false">取消</n-button>
          <n-button class="flex-[2]" type="primary" @click="pickAndImport">选择文件并导入</n-button>
        </div>
      </template>
    </n-modal>

    <n-modal v-model:show="move.open" preset="card" title="移动到单元" style="width: 420px; max-width: calc(100vw - 40px)">
      <n-select v-model:value="move.unitId" :options="moveUnitOptions" />
      <div class="mt-2 text-[12px] text-muted">把选中的 {{ checked.length }} 个单词移动到该单元</div>
      <template #footer>
        <n-button type="primary" block @click="applyMove">确定</n-button>
      </template>
    </n-modal>

    <n-modal v-model:show="nameDialog.open" preset="card" :title="nameDialog.title" style="width: 400px; max-width: calc(100vw - 40px)">
      <n-input v-model:value="nameDialog.value" placeholder="名称" @keyup.enter="submitName" />
      <template #footer>
        <n-button type="primary" block @click="submitName">确定</n-button>
      </template>
    </n-modal>

    <n-modal v-model:show="showImport" preset="card" title="导入结果" style="width: 430px; max-width: calc(100vw - 40px)">
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

<style scoped>
:deep(.n-form-item) {
  margin-bottom: 14px;
}

.nav-row {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--color-ink);
  text-align: left;
  background: transparent;
  border: none;
  cursor: pointer;
}

.nav-row:hover {
  background: var(--color-canvas);
}

.nav-row--active {
  background: color-mix(in srgb, var(--color-brand) 12%, transparent);
  color: var(--color-brand);
  font-weight: 600;
}

.nav-count {
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  color: var(--color-muted);
  flex-shrink: 0;
}
</style>
