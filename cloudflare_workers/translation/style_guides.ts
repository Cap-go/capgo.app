// Locale style guides for the console translation prompt.
// Small models translate developer jargon into formal or literal words nobody uses
// ("chaîne" for channel, "magasin" for store, "mise en cloud" for cloud build).
// Each guide lists the English terms native developers keep and the house style.
// Add a guide per locale when its translations need tuning; French is the reference.

const GENERIC_STYLE_GUIDE = [
  'Write the way a native developer in the target market talks and reads product UI today, not administrative or textbook language.',
  'Keep the English developer terms that native developers really use (build, bundle, webhook, dashboard, token, prompt, logs, pipeline, framework, onboarding) instead of inventing local equivalents.',
  'Never translate names: Capgo, Capacitor, Capgo Live Updates, Native Build, Observe, Capgo CLI, MCP, Ionic, Appflow, App Store, Play Store, Xcode, GitHub, Cloudflare, plugin names, third-party product names, package names, commands and code.',
  'upload and download are different actions: never translate upload with the local word for download.',
].join('\n')

const FRENCH_STYLE_GUIDE = `French (France) style guide:
- Audience: mobile and web developers, tech leads and founders in France. Not Québec French.
- Address the user with "vous". Use sentence case (capitalise only the first word and proper nouns), never English Title Case.
- Buttons, menu items and actions use the infinitive ("Supprimer le canal", "Ajouter un webhook").
- Get gender and agreement right (cette application, cet appareil, ce montant, des canaux). Use natural word order ("les 12 derniers mois", not "Derniers 12 mois").
- Typography: space before : ; ? ! ; decimal comma (4,2 Mo); prices as "0,05 $"; GB -> Go, GiB -> Gio, MB -> Mo.
Glossary (English -> French, mandatory):
- AI -> IA (agents IA); AI agent -> agent IA
- bundle -> bundle (le bundle, les bundles)
- build (noun) -> build (le build); cloud build -> build cloud; native build (generic) -> build natif; Native Build (Capgo product name) stays Native Build; build time -> temps de build; to build an app -> compiler
- channel -> canal (pl. canaux). Never "chaîne".
- release (noun) -> release or version; never "mise à jour" when it means a version
- live update(s) -> live update(s) or "mise à jour OTA". Never "mise à jour en direct".
- update (generic) -> mise à jour
- rollout / staged rollout -> déploiement progressif; roll back / rollback -> rollback, revenir à la version précédente
- ship / deploy -> déployer, livrer, publier. Never "expédier".
- upload -> upload (noun) / envoyer (verb). Never "télécharger" or "téléverser". download -> télécharger.
- store / App Store / Play Store -> store, App Store, Play Store (les stores). Never "magasin" or "boutique".
- dashboard -> dashboard; onboarding -> onboarding; webhook -> webhook; checksum -> checksum; token -> token; prompt -> prompt; logs -> logs
- device -> appareil; organization -> organisation; plan (billing) -> plan; API key -> clé API; email -> e-mail; push notification -> notification push
- provisioning profile -> profil de provisionnement; signing -> signature; overwrite -> écraser
- MAU / monthly active users -> utilisateurs actifs mensuels (MAU)`

const LOCALE_STYLE_GUIDES: Record<string, string> = {
  fr: FRENCH_STYLE_GUIDE,
}

export function translationStyleGuide(targetLanguage: string) {
  const localeGuide = LOCALE_STYLE_GUIDES[targetLanguage]
  return localeGuide ? `${GENERIC_STYLE_GUIDE}\n${localeGuide}` : GENERIC_STYLE_GUIDE
}
