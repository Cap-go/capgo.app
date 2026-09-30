<script setup lang="ts">
import { useId } from 'vue'

// Animated Capgo mark: a light traces the diamond while the inner mark breathes.
// Keep the markup in sync with the boot loader in index.html.
withDefaults(defineProps<{
  size?: string
}>(), {
  size: 'w-16 h-16',
})

// Unique per instance so several loaders on one page keep their own clip path.
const uid = `capgo-loader-${useId().replace(/[^\w-]/g, '')}`
</script>

<template>
  <svg
    :class="size"
    class="capgo-loader text-slate-900 dark:text-white"
    viewBox="0 0 1024 1024"
    aria-hidden="true"
    xmlns="http://www.w3.org/2000/svg"
  >
    <defs>
      <clipPath :id="`${uid}-ring`">
        <path d="M264.2 265.3 17 512.5 264.5 760 512 1007.5 759.5 760 1007 512.5 759.8 265.3C623.8 129.3 512.3 18 512 18c-.3 0-111.8 111.3-247.8 247.3zm438.5 55.9C807.4 425.9 893 511.9 893 512.5c0 .5-85.7 86.7-190.5 191.5L512 894.5l-191-191-191-191 190.7-190.7c105-105 191-190.8 191.3-190.8.3 0 86.1 85.6 190.7 190.2z" />
      </clipPath>
    </defs>
    <path
      class="capgo-loader-ring"
      fill="currentColor"
      d="M264.2 265.3 17 512.5 264.5 760 512 1007.5 759.5 760 1007 512.5 759.8 265.3C623.8 129.3 512.3 18 512 18c-.3 0-111.8 111.3-247.8 247.3zm438.5 55.9C807.4 425.9 893 511.9 893 512.5c0 .5-85.7 86.7-190.5 191.5L512 894.5l-191-191-191-191 190.7-190.7c105-105 191-190.8 191.3-190.8.3 0 86.1 85.6 190.7 190.2z"
    />
    <polygon
      class="capgo-loader-trace"
      :clip-path="`url(#${uid}-ring)`"
      points="512,74 950,512 512,950 74,512"
      pathLength="100"
      fill="none"
      stroke-width="120"
    />
    <g class="capgo-loader-mark" fill="currentColor">
      <path d="M440.8 347c-12.6 12.6-22.8 23.3-22.8 23.7 0 .5 53 53.7 117.8 118.4l117.7 117.7 23.2-23.3 23.1-23.2-47.4-47.4-47.4-47.4 47.5-47.5 47.5-47.5-23.3-23.3-23.2-23.2-47.5 47.5-47.5 47.5-47.5-47.4-47.5-47.5-22.7 22.9z" />
      <path d="M347 441.2 324.5 464l47.3 47.3 47.2 47.2-47.4 47.7-47.3 47.6 23 23 23 23 47.5-47.5 47.5-47.5 47.3 47.3c26 26 47.5 47.1 47.8 46.9 6.6-6.3 45.6-45.5 45.6-45.9 0-1.2-234.5-235.1-235.5-234.9-.6 0-11.1 10.4-23.5 23z" />
    </g>
  </svg>
</template>

<style scoped>
.capgo-loader-ring {
  opacity: 0.18;
}

.capgo-loader-trace {
  stroke: #119eff;
  stroke-dasharray: 30 70;
  animation: capgo-loader-trace 1.6s linear infinite;
}

.capgo-loader-mark {
  transform-box: fill-box;
  transform-origin: center;
  animation: capgo-loader-mark 1.6s ease-in-out infinite;
}

@keyframes capgo-loader-trace {
  to {
    stroke-dashoffset: -100;
  }
}

@keyframes capgo-loader-mark {
  0%,
  100% {
    opacity: 0.55;
    transform: scale(0.9);
  }
  50% {
    opacity: 1;
    transform: scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .capgo-loader-trace,
  .capgo-loader-mark {
    animation: none;
  }

  .capgo-loader-ring {
    opacity: 1;
  }

  .capgo-loader-trace {
    display: none;
  }
}
</style>
