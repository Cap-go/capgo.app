<script setup lang="ts">
import { useId } from 'vue'

// Animated Capgo mark: the diamond turns in quarter snaps while the two
// capacitor plates pulse apart between turns ("charging").
// Keep the markup in sync with the boot loader in index.html.
withDefaults(defineProps<{
  size?: string
  // When set, the loader announces itself as a status region with this text.
  label?: string
}>(), {
  size: 'w-16 h-16',
  label: '',
})

// Unique per instance so several loaders on one page keep their own mask.
const uid = `capgo-loader-${useId().replace(/[^\w-]/g, '')}`
</script>

<template>
  <span class="inline-flex" :role="label ? 'status' : undefined">
    <svg
      :class="size"
      class="capgo-loader text-slate-900 dark:text-white"
      viewBox="0 0 1024 1024"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <mask :id="uid" maskUnits="userSpaceOnUse" x="-512" y="-512" width="1024" height="1024">
          <rect x="-512" y="-512" width="1024" height="1024" fill="#fff" />
          <g fill="#000">
            <path class="capgo-loader-plate-left" d="M-160-145A45 45 0 0 1-70-145V145A45 45 0 0 1-160 145V50H-195A45 45 0 0 1-240 5V-5A45 45 0 0 1-195-50H-160Z" />
            <path class="capgo-loader-plate-right" d="M160-145A45 45 0 0 0 70-145V145A45 45 0 0 0 160 145V50H195A45 45 0 0 0 240 5V-5A45 45 0 0 0 195-50H160Z" />
          </g>
        </mask>
      </defs>
      <g class="capgo-loader-spin">
        <g transform="translate(512 512) rotate(-45)">
          <path
            fill="currentColor"
            :mask="`url(#${uid})`"
            d="M-190-340H190A150 150 0 0 1 340-190V190A150 150 0 0 1 190 340H-190A150 150 0 0 1-340 190V-190A150 150 0 0 1-190-340Z"
          />
        </g>
      </g>
    </svg>
    <span v-if="label" class="sr-only">{{ label }}</span>
  </span>
</template>

<style scoped>
.capgo-loader-spin {
  transform-box: view-box;
  transform-origin: 50% 50%;
  animation: capgo-loader-spin 2s cubic-bezier(0.7, 0, 0.3, 1) infinite;
}

.capgo-loader-plate-left {
  animation: capgo-loader-plate-left 2s ease-in-out infinite;
}

.capgo-loader-plate-right {
  animation: capgo-loader-plate-right 2s ease-in-out infinite;
}

/* The mark is point-symmetric, so two quarter turns loop seamlessly. */
@keyframes capgo-loader-spin {
  0%,
  20% {
    transform: rotate(0deg);
  }
  50%,
  70% {
    transform: rotate(90deg);
  }
  100% {
    transform: rotate(180deg);
  }
}

@keyframes capgo-loader-plate-left {
  0%,
  20%,
  50%,
  70%,
  100% {
    transform: translateX(0);
  }
  10%,
  60% {
    transform: translateX(-40px);
  }
}

@keyframes capgo-loader-plate-right {
  0%,
  20%,
  50%,
  70%,
  100% {
    transform: translateX(0);
  }
  10%,
  60% {
    transform: translateX(40px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .capgo-loader-spin,
  .capgo-loader-plate-left,
  .capgo-loader-plate-right {
    animation: none;
  }
}
</style>
