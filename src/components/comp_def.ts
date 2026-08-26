import type { FunctionalComponent, Ref, ShallowRef, VNodeChild } from 'vue'
import type { ComposerTranslation } from 'vue-i18n'

/**
 * Default table row type stays permissive so existing unparameterized
 * `TableColumn[]` call sites keep working. Prefer `TableColumn<MyRow>` when
 * typing a specific table.
 */
export type TableRow = any

export interface Stat {
  label: string | ComposerTranslation
  value: string | Ref<string> | number | Ref<number> | undefined
  link?: string
  hoverLabel?: string
  informationIcon?: FunctionalComponent | ShallowRef<FunctionalComponent>
}
export interface TableSort {
  [key: string]: 'asc' | 'desc' | null
}

/**
 * Defines a single action button configuration.
 */
export interface TableAction<T = TableRow> {
  icon: FunctionalComponent | ShallowRef<FunctionalComponent>
  onClick: (item: T) => void
  visible?: (item: T) => boolean
  disabled?: (item: T) => boolean
  title?: string | ((item: T) => string)
  testId?: string | ((item: T) => string)
}

export interface TableColumn<T = TableRow> {
  label: string
  key: string
  mobile?: boolean
  sortable?: boolean | 'asc' | 'desc'
  head?: boolean
  icon?: FunctionalComponent | ShallowRef<FunctionalComponent>
  onClick?: (item: T) => void
  actions?: TableAction<T>[] // New property for multiple actions
  class?: string
  allowHtml?: boolean
  sanitizeHtml?: boolean
  displayFunction?: (item: T) => string | number
  // Preferred way to render complex cell content without v-html
  renderFunction?: (item: T) => VNodeChild
}

export interface Tab<T = TableRow> {
  label: string
  icon?: FunctionalComponent | ShallowRef<FunctionalComponent>
  key: string
  badge?: string
  onClick?: (elem: T | undefined) => void
  redirect?: boolean
  children?: Tab<T>[]
}
