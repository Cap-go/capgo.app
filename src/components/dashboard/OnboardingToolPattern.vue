<script setup lang="ts">
const COLS = 5
const ROWS = 7

const props = defineProps<{
  icons: string[]
  muted?: boolean
}>()

const tiles = computed(() => {
  const icons = props.icons
  if (!icons.length)
    return []

  const placed: string[] = []
  return Array.from({ length: COLS * ROWS }, (_, index) => {
    const row = Math.floor(index / COLS)
    const col = index % COLS
    const left = col > 0 ? placed[index - 1] : undefined
    const up = row > 0 ? placed[index - COLS] : undefined
    const upLeft = row > 0 && col > 0 ? placed[index - COLS - 1] : undefined
    const upRight = row > 0 && col < COLS - 1 ? placed[index - COLS + 1] : undefined
    const start = (row * 11 + col * 7 + row * col * 5) % icons.length
    let src = icons[start]!
    for (let step = 0; step < icons.length; step++) {
      const candidate = icons[(start + step * 3) % icons.length]!
      if (candidate !== left && candidate !== up && candidate !== upLeft && candidate !== upRight) {
        src = candidate
        break
      }
    }
    placed.push(src)
    return {
      src,
      shift: row % 2 === 1,
    }
  })
})
</script>

<template>
  <div class="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
    <div
      class="absolute -inset-10 grid grid-cols-5 gap-x-5 gap-y-6 rotate-[-22deg]"
      :class="muted ? 'opacity-[0.14] dark:opacity-[0.2]' : 'opacity-[0.14] dark:opacity-[0.18]'"
    >
      <img
        v-for="(tile, index) in tiles"
        :key="index"
        :src="tile.src"
        alt=""
        class="h-8 w-8 object-contain sm:h-9 sm:w-9"
        :class="[tile.shift ? 'translate-x-6' : '', muted ? 'dark:brightness-0 dark:invert' : '']"
      >
    </div>
    <div class="absolute inset-0 bg-gradient-to-t from-white via-white/50 to-transparent dark:from-slate-900 dark:via-slate-900/50" />
  </div>
</template>
