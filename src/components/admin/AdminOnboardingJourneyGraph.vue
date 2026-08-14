<script setup lang="ts">
import type {
  AdminOnboardingJourneyEdge,
  AdminOnboardingJourneyGraphConfig,
  AdminOnboardingJourneyIcon,
  AdminOnboardingJourneyNode,
} from './adminOnboardingJourneyGraph'
import { computed } from 'vue'
import UploadIcon from '~icons/heroicons/arrow-up-tray'
import ImportIcon from '~icons/heroicons/building-storefront'
import SuccessIcon from '~icons/heroicons/check-circle'
import SetupIcon from '~icons/heroicons/command-line'
import IntentIcon from '~icons/heroicons/cursor-arrow-rays'
import AppIcon from '~icons/heroicons/device-phone-mobile'
import DetailsIcon from '~icons/heroicons/document-text'
import FailureIcon from '~icons/heroicons/exclamation-circle'
import FileIcon from '~icons/heroicons/folder-open'
import LinkIcon from '~icons/heroicons/link'
import ImageIcon from '~icons/heroicons/photo'
import OrganizationIcon from '~icons/heroicons/user-group'
import CloseIcon from '~icons/heroicons/x-mark'
import { formatNumberValue } from '~/services/formatLocale'

const props = defineProps<{
  config: AdminOnboardingJourneyGraphConfig
}>()

const iconComponents: Record<AdminOnboardingJourneyIcon, typeof AppIcon> = {
  app: AppIcon,
  close: CloseIcon,
  details: DetailsIcon,
  failure: FailureIcon,
  file: FileIcon,
  icon: ImageIcon,
  import: ImportIcon,
  intent: IntentIcon,
  link: LinkIcon,
  organization: OrganizationIcon,
  setup: SetupIcon,
  success: SuccessIcon,
  upload: UploadIcon,
}

const nodesById = computed(() => new Map(props.config.nodes.map(node => [node.id, node])))

function nodeWidth(node: AdminOnboardingJourneyNode) {
  return node.width ?? (node.kind === 'stage' ? 260 : 300)
}

function edgePath(edge: AdminOnboardingJourneyEdge) {
  const from = edge.from ? nodesById.value.get(edge.from) : undefined
  const to = edge.to ? nodesById.value.get(edge.to) : undefined
  const startX = edge.fromPoint?.x ?? (from ? from.x + nodeWidth(from) / 2 + 10 : undefined)
  const startY = edge.fromPoint?.y ?? from?.y
  const endX = edge.toPoint?.x ?? (to ? to.x - nodeWidth(to) / 2 - 12 : undefined)
  const endY = edge.toPoint?.y ?? to?.y
  if (startX === undefined || startY === undefined || endX === undefined || endY === undefined)
    return ''

  if (startX === endX)
    return `M ${startX} ${startY} V ${endY}`

  if (edge.style === 'branch') {
    const trunkX = startX + (endX - startX) / 2
    const radius = Math.min(10, Math.abs(endY - startY) / 2, Math.abs(endX - startX) / 4)
    const direction = endY >= startY ? 1 : -1
    return `M ${startX} ${startY} H ${trunkX - radius} Q ${trunkX} ${startY} ${trunkX} ${startY + direction * radius} V ${endY - direction * radius} Q ${trunkX} ${endY} ${trunkX + radius} ${endY} H ${endX}`
  }

  const distance = Math.max(32, (endX - startX) * 0.48)
  return `M ${startX} ${startY} C ${startX + distance} ${startY}, ${endX - distance} ${endY}, ${endX} ${endY}`
}

function nodeStyle(node: AdminOnboardingJourneyNode) {
  return {
    left: `${node.x}px`,
    top: `${node.y}px`,
    width: `${nodeWidth(node)}px`,
  }
}

function tooltipText(node: AdminOnboardingJourneyNode) {
  if (node.kind === 'event') {
    const level = props.config.formatters.levelPercent(node.levelPercent ?? 0, node.levelLabel ?? '')
    if (node.previousPercent === undefined)
      return level
    return `${level} · ${props.config.formatters.previousPercent(node.previousPercent)}`
  }

  const total = props.config.formatters.totalPercent(node.totalPercent ?? 0)
  if (node.parentPercent === undefined)
    return total
  return `${total} · ${props.config.formatters.parentPercent(node.parentPercent)}`
}
</script>

<template>
  <div class="journey-scrollbar overflow-x-auto pb-2">
    <div
      class="journey-canvas relative overflow-hidden rounded-2xl border border-slate-200/80 bg-slate-50/50 dark:border-slate-700/70 dark:bg-slate-950/25"
      :style="{ width: `${config.width}px`, height: `${config.height}px` }"
    >
      <div class="pointer-events-none absolute inset-0 journey-grid" />

      <svg
        class="pointer-events-none absolute inset-0 h-full w-full"
        :viewBox="`0 0 ${config.width} ${config.height}`"
        aria-hidden="true"
      >
        <defs>
          <marker id="journey-arrow-primary" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" class="fill-sky-400 dark:fill-sky-500" />
          </marker>
          <marker id="journey-arrow-muted" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" class="fill-slate-400 dark:fill-slate-500" />
          </marker>
        </defs>

        <line
          v-for="level in config.levels.filter(level => level.divider !== undefined)"
          :key="`divider-${level.label}`"
          :x1="level.divider"
          y1="38"
          :x2="level.divider"
          :y2="config.height - 58"
          class="stroke-slate-300 dark:stroke-slate-600"
          stroke-width="1.5"
          stroke-dasharray="4 7"
        />

        <path
          v-for="edge in config.edges"
          :key="`${edge.from ?? edge.fromPoint?.x}-${edge.to ?? edge.toPoint?.x}`"
          :d="edgePath(edge)"
          fill="none"
          :class="{
            'stroke-sky-300 dark:stroke-sky-700': edge.style === 'primary',
            'stroke-slate-400 dark:stroke-slate-500': edge.style !== 'primary',
          }"
          :stroke-width="edge.style === 'primary' ? 4 : 1.6"
          :stroke-dasharray="edge.style === 'dotted' ? '3 6' : undefined"
          :opacity="edge.style === 'dotted' ? 0.82 : 1"
          :marker-end="edge.arrow === false ? undefined : edge.style === 'primary' ? 'url(#journey-arrow-primary)' : edge.style === 'dotted' ? 'url(#journey-arrow-muted)' : undefined"
        />
      </svg>

      <div
        v-for="node in config.nodes"
        :key="node.id"
        class="journey-node group absolute z-10 -translate-x-1/2 -translate-y-1/2 outline-none"
        :class="[`journey-node--${node.kind}`, `journey-node--${node.tone ?? 'default'}`]"
        :style="nodeStyle(node)"
        role="group"
        tabindex="0"
        :aria-label="`${node.label}: ${formatNumberValue(node.count)}, ${tooltipText(node)}`"
      >
        <div class="journey-node__body">
          <span class="journey-node__icon" aria-hidden="true">
            <component :is="iconComponents[node.icon]" />
          </span>
          <span class="min-w-0">
            <span class="journey-node__label">{{ node.label }}</span>
            <span class="journey-node__value">{{ formatNumberValue(node.count) }}</span>
            <span v-if="node.kind === 'event'" class="journey-node__metrics">
              <span class="journey-node__metric journey-node__metric--level">
                {{ config.formatters.levelPercent(node.levelPercent ?? 0, node.levelLabel ?? '') }}
              </span>
              <span v-if="node.previousPercent !== undefined" class="journey-node__metric">
                {{ config.formatters.previousPercent(node.previousPercent) }}
              </span>
            </span>
            <span v-else class="journey-node__value">
              {{ config.formatters.totalPercent(node.totalPercent ?? 0) }}
            </span>
          </span>
        </div>
        <span class="journey-tooltip" role="tooltip">{{ tooltipText(node) }}</span>
      </div>

      <div
        v-for="level in config.levels"
        :key="`level-${level.label}`"
        class="pointer-events-none absolute bottom-4 text-center text-3xl font-bold text-sky-600 dark:text-sky-400"
        :style="{ left: `${level.start}px`, width: `${level.end - level.start}px` }"
      >
        {{ level.label }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.journey-grid {
  background-image: radial-gradient(circle, rgb(148 163 184 / 0.2) 0.8px, transparent 0.8px);
  background-size: 18px 18px;
  mask-image: linear-gradient(to bottom, transparent, black 12%, black 82%, transparent);
}

.journey-node__body {
  display: flex;
  min-height: 52px;
  align-items: center;
  gap: 0.65rem;
  border: 1.5px solid rgb(14 165 233 / 0.78);
  border-radius: 0.85rem;
  background: rgb(255 255 255 / 0.96);
  padding: 0.55rem 0.7rem;
  box-shadow: 0 10px 26px -18px rgb(15 23 42 / 0.48);
  transition:
    border-color 150ms ease,
    box-shadow 150ms ease,
    transform 150ms ease;
}

.journey-node:hover .journey-node__body,
.journey-node:focus-visible .journey-node__body {
  transform: translateY(-2px);
  border-color: rgb(2 132 199);
  box-shadow: 0 14px 32px -18px rgb(2 132 199 / 0.55);
}

.journey-node--stage .journey-node__body {
  min-height: 88px;
  border-width: 2px;
  border-radius: 1.15rem;
  padding: 0.8rem;
}

.journey-node__icon {
  display: grid;
  height: 2rem;
  width: 2rem;
  flex: none;
  place-items: center;
  border-radius: 0.65rem;
  background: rgb(224 242 254);
  color: rgb(2 132 199);
}

.journey-node--stage .journey-node__icon {
  height: 2.75rem;
  width: 2.75rem;
  border-radius: 999px;
}

.journey-node__icon :deep(svg) {
  height: 1.05rem;
  width: 1.05rem;
}

.journey-node--stage .journey-node__icon :deep(svg) {
  height: 1.45rem;
  width: 1.45rem;
}

.journey-node__value {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.journey-node__metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 0.2rem;
  margin-top: 0.16rem;
}

.journey-node__metric {
  display: inline-flex;
  border-radius: 999px;
  background: rgb(241 245 249);
  color: rgb(71 85 105);
  font-size: 0.58rem;
  font-weight: 650;
  line-height: 1rem;
  padding: 0 0.35rem;
  white-space: nowrap;
}

.journey-node__metric--level {
  background: rgb(224 242 254);
  color: rgb(3 105 161);
}

.journey-node__label {
  display: block;
  overflow-wrap: anywhere;
  white-space: normal;
}

.journey-node__label {
  color: rgb(15 23 42);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1.15rem;
}

.journey-node--stage .journey-node__label {
  font-size: 0.95rem;
  line-height: 1.35rem;
}

.journey-node__value {
  color: rgb(100 116 139);
  font-size: 0.68rem;
  font-variant-numeric: tabular-nums;
  line-height: 1rem;
}

.journey-node--success .journey-node__icon {
  background: rgb(209 250 229);
  color: rgb(5 150 105);
}

.journey-node--danger .journey-node__icon {
  background: rgb(255 228 230);
  color: rgb(225 29 72);
}

.journey-node--muted .journey-node__icon {
  background: rgb(241 245 249);
  color: rgb(100 116 139);
}

.journey-tooltip {
  pointer-events: none;
  position: absolute;
  bottom: calc(100% + 0.55rem);
  left: 50%;
  z-index: 30;
  width: max-content;
  max-width: 15rem;
  transform: translate(-50%, 0.25rem);
  border: 1px solid rgb(51 65 85);
  border-radius: 0.55rem;
  background: rgb(15 23 42 / 0.96);
  color: white;
  font-size: 0.72rem;
  font-weight: 600;
  opacity: 0;
  padding: 0.4rem 0.55rem;
  transition:
    opacity 120ms ease,
    transform 120ms ease;
}

.journey-node:hover .journey-tooltip,
.journey-node:focus-visible .journey-tooltip {
  transform: translate(-50%, 0);
  opacity: 1;
}

.journey-scrollbar {
  scrollbar-color: rgb(148 163 184 / 0.55) transparent;
  scrollbar-width: thin;
}

:global(.dark) .journey-node__body {
  border-color: rgb(56 189 248 / 0.7);
  background: rgb(15 23 42 / 0.96);
  box-shadow: 0 14px 30px -20px rgb(2 6 23 / 0.95);
}

:global(.dark) .journey-node__label {
  color: rgb(248 250 252);
}

:global(.dark) .journey-node__value {
  color: rgb(148 163 184);
}

:global(.dark) .journey-node__metric {
  background: rgb(51 65 85 / 0.9);
  color: rgb(203 213 225);
}

:global(.dark) .journey-node__metric--level {
  background: rgb(12 74 110 / 0.7);
  color: rgb(186 230 253);
}

:global(.dark) .journey-node__icon {
  background: rgb(12 74 110 / 0.6);
  color: rgb(125 211 252);
}

:global(.dark) .journey-node--success .journey-node__icon {
  background: rgb(6 78 59 / 0.65);
  color: rgb(110 231 183);
}

:global(.dark) .journey-node--danger .journey-node__icon {
  background: rgb(136 19 55 / 0.55);
  color: rgb(253 164 175);
}

:global(.dark) .journey-node--muted .journey-node__icon {
  background: rgb(51 65 85 / 0.78);
  color: rgb(203 213 225);
}
</style>
