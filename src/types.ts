import type { App } from 'vue'
import type { Router, RouteRecordRaw } from 'vue-router'

interface AppContext<HasRouter extends boolean = true> {
  app: App<Element>
  router: HasRouter extends true ? Router : undefined
  routes: HasRouter extends true ? RouteRecordRaw[] : undefined
}

export type UserModule = (ctx: AppContext) => void | Promise<void>
