import { defineComponent } from 'vue'

export const RenderCell = defineComponent<{
  renderer?: (item: any) => any
  item: any
}>({
  name: 'RenderCell',
  props: {
    renderer: Function as unknown as () => ((item: any) => any) | undefined,
    item: { type: Object as any, required: true },
  },
  setup(props) {
    return () => (props.renderer ? (props.renderer as any)(props.item) : null)
  },
})
