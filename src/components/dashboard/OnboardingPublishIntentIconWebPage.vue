<script setup lang="ts">
</script>

<template>
  <span class="relative flex items-center justify-center">
    <svg class="w-full h-full absolute top-0 left-0" viewBox="0 0 24 24" aria-hidden="true">
      <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
        <rect width="20" height="16" x="2" y="4" rx="2"></rect>
          <path d="M10 4v4M2 8h20M6 4v4"></path>
      </g>
    </svg>
    <div style="top: calc(100% * (3/24))" class="absolute left-0 w-full h-[75%] flex justify-center">
      <div class="absolute w-full flex items-center justify-center" style="top: calc(100% * (8/24)); height: calc(100%*((13.5/24)));">
        <svg class="mark" style="width:80%;height:80%;" viewBox="0 0 24 24" aria-hidden="true">
          <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="4"></circle>
            <path d="M21.17 8H12M3.95 6.06L8.54 14m2.34 7.94L15.46 14"></path>
          </g>
        </svg>
      </div>
    </div>
  </span>
</template>
