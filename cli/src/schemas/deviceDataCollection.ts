import { z } from 'zod'

export const deviceDataCollectionOptionsFields = {
  collectCountry: z.boolean().optional(),
  collectPlatform: z.boolean().optional(),
  collectOsVersion: z.boolean().optional(),
  collectPluginVersion: z.boolean().optional(),
  collectVersionBuild: z.boolean().optional(),
  collectIsEmulator: z.boolean().optional(),
  collectIsProd: z.boolean().optional(),
  collectInstallSource: z.boolean().optional(),
}

export const deviceDataCollectionOptionsSchema = z.object(deviceDataCollectionOptionsFields)
