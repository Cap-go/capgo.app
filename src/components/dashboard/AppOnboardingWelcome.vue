<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import IconArrowRight from '~icons/lucide/arrow-right'

const emit = defineEmits<{
  continue: []
}>()

const { t } = useI18n()
</script>

<template>
  <section
    class="onboarding-welcome relative grid h-full min-h-[34rem] place-items-center overflow-hidden px-6 pb-16 text-slate-950 sm:px-10 dark:text-white"
    aria-labelledby="onboarding-welcome-title"
    data-test="onboarding-welcome"
  >
    <div class="fixed left-6 top-5 z-30 inline-flex items-center gap-3 text-xl font-bold tracking-[-0.02em] text-slate-950 lg:left-10 dark:text-white" data-test="onboarding-welcome-brand">
      <img src="/favicon.svg" alt="" class="h-8 w-8 drop-shadow-[0_0.3125rem_0.625rem_rgba(37,99,235,0.16)]" aria-hidden="true">
      <span>Capgo</span>
    </div>

    <div class="onboarding-welcome-content relative z-10 mx-auto w-full max-w-3xl text-center">
      <div class="onboarding-welcome-mark mx-auto mb-8 grid h-[4.875rem] w-[4.875rem] place-items-center rounded-3xl border border-primary-500/15 bg-white/90 shadow-[0_1.25rem_3.5rem_rgba(37,99,235,0.14)] backdrop-blur dark:border-white/15 dark:bg-slate-900/90">
        <img src="/favicon.svg" alt="" class="h-12 w-12" aria-hidden="true">
      </div>

      <p class="onboarding-welcome-eyebrow mb-4 inline-flex items-center gap-2 text-xs font-extrabold tracking-[0.13em] text-primary-600 uppercase dark:text-primary-300">
        <span class="onboarding-welcome-status-dot h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
        {{ t('onboarding-welcome-eyebrow') }}
      </p>

      <h1 id="onboarding-welcome-title" class="onboarding-welcome-title m-0 text-5xl font-bold leading-none tracking-[-0.055em] text-balance lg:text-6xl">
        {{ t('onboarding-welcome-title') }}
      </h1>

      <p class="onboarding-welcome-description mx-auto mt-6 max-w-2xl text-xl leading-8 font-medium tracking-[-0.018em] text-slate-600 text-balance dark:text-slate-300">
        {{ t('onboarding-welcome-description') }}
      </p>

      <div class="onboarding-welcome-action mt-9 flex justify-center">
        <div class="onboarding-welcome-glow-shell">
          <button
            type="button"
            class="d-btn d-btn-primary onboarding-welcome-primary group relative z-[1] min-h-[3.375rem] gap-3 overflow-hidden rounded-[0.875rem] border-blue-700/90 bg-gradient-to-br from-blue-500 via-blue-600 to-blue-700 px-[1.5625rem] text-[0.9375rem] font-[750] text-white shadow-[0_0.5rem_1.25rem_rgba(37,99,235,0.16),inset_0_1px_0_rgba(255,255,255,0.28)] transition duration-150 ease-out hover:-translate-y-px hover:brightness-105 focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-blue-500/35 motion-reduce:transition-none"
            data-test="onboarding-welcome-continue"
            @click="emit('continue')"
          >
            <span>{{ t('onboarding-welcome-cta') }}</span>
            <IconArrowRight class="h-5 w-5 transition-transform duration-150 group-hover:translate-x-[3px] motion-reduce:transition-none" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.onboarding-welcome {
  isolation: isolate;
  background:
    radial-gradient(circle at 50% 40%, rgb(59 130 246 / 12%), transparent 29rem),
    linear-gradient(180deg, #fff 0%, #f8fafc 58%, #f1f5f9 100%);
}

.onboarding-welcome::before,
.onboarding-welcome::after {
  position: absolute;
  z-index: -1;
  width: 25rem;
  height: 25rem;
  border-radius: 9999px;
  content: '';
  pointer-events: none;
}

.onboarding-welcome::before {
  top: -18rem;
  left: -8rem;
  border: 1px solid rgb(59 130 246 / 18%);
  box-shadow:
    0 0 0 4rem rgb(59 130 246 / 2.5%),
    0 0 0 8rem rgb(59 130 246 / 1.8%);
}

.onboarding-welcome::after {
  right: -12rem;
  bottom: -19rem;
  border: 1px solid rgb(16 185 129 / 14%);
  box-shadow:
    0 0 0 4rem rgb(16 185 129 / 2.2%),
    0 0 0 8rem rgb(16 185 129 / 1.5%);
}

.onboarding-welcome-mark {
  animation: onboarding-welcome-settle 700ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

.onboarding-welcome-eyebrow {
  animation: onboarding-welcome-rise 550ms 90ms ease-out both;
}

.onboarding-welcome-title {
  animation: onboarding-welcome-rise 600ms 140ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

.onboarding-welcome-description {
  animation: onboarding-welcome-rise 600ms 210ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

.onboarding-welcome-action {
  animation: onboarding-welcome-rise 600ms 290ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

.onboarding-welcome-status-dot {
  box-shadow: 0 0 0 0 rgb(34 197 94 / 34%);
  animation: onboarding-status-pulse 2.2s ease-out infinite;
}

.onboarding-welcome-glow-shell {
  position: relative;
  display: inline-flex;
  border-radius: 0.9375rem;
}

.onboarding-welcome-glow-shell::before,
.onboarding-welcome-glow-shell::after {
  position: absolute;
  z-index: 0;
  border-radius: 1.5rem;
  background: linear-gradient(
    90deg,
    rgb(34 211 238 / 86%),
    rgb(59 130 246 / 80%),
    rgb(139 92 246 / 78%),
    rgb(236 72 153 / 66%),
    rgb(251 146 60 / 58%),
    rgb(34 197 94 / 72%),
    rgb(34 211 238 / 86%)
  );
  background-size: 220% 100%;
  content: '';
  pointer-events: none;
  animation: onboarding-glow-drift 6s ease-in-out infinite alternate;
}

.onboarding-welcome-glow-shell::before {
  inset: -0.5625rem;
  filter: blur(0.8125rem) saturate(1.35);
  opacity: 0.5;
}

.onboarding-welcome-glow-shell::after {
  inset: -1.0625rem;
  filter: blur(1.5625rem) saturate(1.2);
  opacity: 0.2;
}

.onboarding-welcome-primary {
  isolation: isolate;
}

.onboarding-welcome-primary::before {
  position: absolute;
  top: -60%;
  left: -45%;
  width: 35%;
  height: 220%;
  background: linear-gradient(90deg, transparent, rgb(255 255 255 / 27%), transparent);
  content: '';
  transform: rotate(18deg);
  animation: onboarding-button-sheen 4.2s 1.3s ease-in-out infinite;
}

.onboarding-welcome-primary > * {
  position: relative;
  z-index: 1;
}

:global(.dark) .onboarding-welcome {
  background:
    radial-gradient(circle at 50% 40%, rgb(59 130 246 / 18%), transparent 29rem),
    linear-gradient(180deg, #020617 0%, #0f172a 58%, #111827 100%);
}

@keyframes onboarding-status-pulse {
  0%,
  34% {
    box-shadow: 0 0 0 0 rgb(34 197 94 / 34%);
  }
  72%,
  100% {
    box-shadow: 0 0 0 0.5rem rgb(34 197 94 / 0%);
  }
}

@keyframes onboarding-glow-drift {
  from {
    background-position: 0% 50%;
  }
  to {
    background-position: 100% 50%;
  }
}

@keyframes onboarding-button-sheen {
  0%,
  63% {
    left: -45%;
    opacity: 0;
  }
  70% {
    opacity: 0.75;
  }
  84%,
  100% {
    left: 115%;
    opacity: 0;
  }
}

@keyframes onboarding-welcome-settle {
  from {
    opacity: 0;
    transform: translateY(0.625rem) scale(0.9);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes onboarding-welcome-rise {
  from {
    opacity: 0;
    transform: translateY(0.625rem);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .onboarding-welcome-mark,
  .onboarding-welcome-eyebrow,
  .onboarding-welcome-title,
  .onboarding-welcome-description,
  .onboarding-welcome-action,
  .onboarding-welcome-status-dot,
  .onboarding-welcome-glow-shell::before,
  .onboarding-welcome-glow-shell::after,
  .onboarding-welcome-primary::before {
    animation: none;
  }
}
</style>
