import { createPinia } from 'pinia'
import { createApp, defineComponent, h } from 'vue'
import { createI18n } from 'vue-i18n'
import { createRouter, createWebHistory } from 'vue-router'
import DialogV2 from '../../src/components/DialogV2.vue'
import { useDialogV2Store } from '../../src/stores/dialogv2'
import '../../src/styles/style.css'

const events: string[] = []
const app = createApp(defineComponent({ setup() {
  const dialog = useDialogV2Store()
  return () => h('main', [h('button', {
    id: 'open-message',
    onClick: () => dialog.openDialog({
      id: 'fixture-inbox',
      embed: { url: `https://sb.capgo.app/__messages/${'v'.repeat(43)}`, title: 'Message', preferred_width: 720, preferred_height: 520 },
      onClose: reason => events.push(reason),
      onEmbedReady: () => events.push('shown'),
    }),
  }, 'Open message'), h(DialogV2)])
} }))
app.use(createPinia())
app.use(createI18n({ legacy: false, locale: 'en', messages: { en: { 'close-dialog': 'Close dialog' } } }))
const router = createRouter({ history: createWebHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { render: () => null } }] })
app.use(router)
void router.isReady().then(() => app.mount('#app'))
Object.assign(window, { inboxDialogFixture: { events } })
