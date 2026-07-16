import { NativeEventEmitter, NativeModules, Platform } from 'react-native'
import type {
  CapgoRNUpdater,
  CapgoRNUpdaterEvent,
  DownloadEvent,
  DownloadOptions,
} from './definitions'
import { PLUGIN_VERSION } from './version'

const LINKING_ERROR =
  `The package '@capgo/react-native-updater' doesn't seem to be linked. Make sure: \n\n` +
  Platform.select({ ios: "- you have run 'pod install'\n", default: '' }) +
  '- you rebuilt the app after installing the package\n' +
  '- you are not using Expo Go\n'

const NativeUpdater = NativeModules.CapgoUpdater
  ? NativeModules.CapgoUpdater
  : new Proxy(
      {},
      {
        get() {
          throw new Error(LINKING_ERROR)
        },
      },
    )

const emitter = NativeModules.CapgoUpdater
  ? new NativeEventEmitter(NativeModules.CapgoUpdater)
  : null

export const CapgoUpdater: CapgoRNUpdater = {
  notifyAppReady() {
    return NativeUpdater.notifyAppReady()
  },
  getLatest(options) {
    return NativeUpdater.getLatest(options ?? {})
  },
  download(options: DownloadOptions) {
    return NativeUpdater.download(options)
  },
  set(options) {
    return NativeUpdater.set(options)
  },
  next(options) {
    return NativeUpdater.next(options)
  },
  reset(options) {
    return NativeUpdater.reset(options ?? {})
  },
  current() {
    return NativeUpdater.current()
  },
  list() {
    return NativeUpdater.list()
  },
  getDeviceId() {
    return NativeUpdater.getDeviceId()
  },
  getPluginVersion() {
    return NativeUpdater.getPluginVersion().catch(() => ({ version: PLUGIN_VERSION }))
  },
  setChannel(options) {
    return NativeUpdater.setChannel(options)
  },
  getChannel() {
    return NativeUpdater.getChannel()
  },
  addListener(eventName: CapgoRNUpdaterEvent, listener) {
    if (!emitter) {
      return { remove() {} }
    }
    const sub = emitter.addListener(eventName, listener as (event: DownloadEvent) => void)
    return { remove: () => sub.remove() }
  },
}

export * from './definitions'
export { PLUGIN_VERSION }
