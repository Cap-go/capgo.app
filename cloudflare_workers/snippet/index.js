// Rules to match requests this Snippet will handle
// Expression
// (http.host eq "plugin.usecapgo.com")
// or (http.host eq "plugin.capgo.app")
// or (http.host eq "updater.capgo.com.cn")
// or (http.host eq "updater.spencer.co")
// or (http.request.full_uri wildcard "*api.capgo.app/updates*")
// or (http.request.full_uri wildcard "*api.capgo.app/plugin/*")
// or (http.request.full_uri wildcard "*api.capgo.app/stats")
// or (http.request.full_uri wildcard "*api.capgo.app/channel_self")
// Circuit breaker configuration
const TIMEOUT_MS = 3000 // 3 seconds - matches plugin timeout
const CIRCUIT_RESET_MS = 5 * 60 * 1000 // 5 minutes before retrying unhealthy worker

// On-prem and plan-upgrade caching rely on worker-provided Cache-Control headers

// Helper to build cache keys using actual hostname to avoid DNS lookups on fake .internal domains
function getCircuitBreakerCacheKey(hostname, colo, workerUrl) {
  return `https://${hostname}/__internal__/circuit-breaker/${colo}/${encodeURIComponent(workerUrl)}`
}

function getOnPremCacheKey(hostname, appId, endpoint, method) {
  return `https://${hostname}/__internal__/onprem-cache-v2/${encodeURIComponent(appId)}/${endpoint}/${method}`
}

function getPlanUpgradeCacheKey(hostname, appId, endpoint, method) {
  return `https://${hostname}/__internal__/plan-upgrade-cache-v2/${encodeURIComponent(appId)}/${endpoint}/${method}`
}

// Endpoints that should be checked for on-prem caching
const ONPREM_CACHEABLE_ENDPOINTS = ['/updates', '/stats', '/channel_self']

// Cache helper functions for circuit breaker
async function markUnhealthy(hostname, colo, workerUrl) {
  try {
    const cache = caches.default
    const key = getCircuitBreakerCacheKey(hostname, colo, workerUrl)
    const response = new Response(JSON.stringify({ unhealthyAt: Date.now() }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `max-age=${Math.floor(CIRCUIT_RESET_MS / 1000)}`,
      },
    })
    await cache.put(key, response)
    console.log(`Circuit OPEN for ${colo} → ${workerUrl}`)
  }
  catch (e) {
    console.log(`Failed to mark unhealthy: ${e.message}`)
  }
}

async function markHealthy(hostname, colo, workerUrl) {
  try {
    const cache = caches.default
    const key = getCircuitBreakerCacheKey(hostname, colo, workerUrl)
    // Only delete when a breaker entry exists — avoid Cache API write on every success.
    const cached = await cache.match(key)
    if (cached)
      await cache.delete(key)
  }
  catch {
    // Ignore errors - cache miss is fine
  }
}

async function isHealthy(hostname, colo, workerUrl) {
  try {
    const cache = caches.default
    const key = getCircuitBreakerCacheKey(hostname, colo, workerUrl)
    const cached = await cache.match(key)
    if (!cached)
      return true // No cache entry = healthy

    const data = await cached.json()
    const elapsed = Date.now() - data.unhealthyAt
    // Circuit resets after CIRCUIT_RESET_MS (handled by Cache-Control, but double-check)
    return elapsed >= CIRCUIT_RESET_MS
  }
  catch {
    return true // On error, assume healthy
  }
}

// On-prem caching helper functions
function matchesEndpoint(pathname, endpoint) {
  // More precise matching to avoid false positives (e.g., '/api/updates_history' matching '/updates')
  // Note: pathname never includes query strings (those are in url.search), so we only check exact match and path prefix
  return pathname === endpoint || pathname.startsWith(`${endpoint}/`)
}

function getEndpointName(pathname) {
  if (matchesEndpoint(pathname, '/updates'))
    return 'updates'
  if (matchesEndpoint(pathname, '/stats'))
    return 'stats'
  if (matchesEndpoint(pathname, '/channel_self'))
    return 'channel_self'
  return 'unknown'
}

function isCacheableEndpoint(pathname) {
  return ONPREM_CACHEABLE_ENDPOINTS.some(ep => matchesEndpoint(pathname, ep))
}

async function getOnPremCache(hostname, appId, endpoint, method) {
  try {
    const cache = caches.default
    const key = getOnPremCacheKey(hostname, appId, endpoint, method)
    const cached = await cache.match(key)
    if (cached) {
      const currentTtl = Number.parseInt(cached.headers.get('X-Onprem-Ttl') || '0', 10)
      const ttlLog = Number.isFinite(currentTtl) && currentTtl > 0 ? ` (TTL ${currentTtl}s)` : ''
      console.log(`On-prem cache HIT for ${appId}/${endpoint}/${method}${ttlLog}`)
      return cached.clone()
    }
    return null
  }
  catch {
    return null
  }
}

async function getPlanUpgradeCache(hostname, appId, endpoint, method) {
  try {
    const cache = caches.default
    const key = getPlanUpgradeCacheKey(hostname, appId, endpoint, method)
    const cached = await cache.match(key)
    if (cached) {
      console.log(`Plan-upgrade cache HIT for ${appId}/${endpoint}/${method}`)
      return cached.clone()
    }
    return null
  }
  catch {
    return null
  }
}

function getCacheTtlSeconds(headers) {
  const cacheControl = headers.get('Cache-Control') || headers.get('cache-control')
  if (!cacheControl)
    return null

  const directives = cacheControl.split(',').map(part => part.trim().toLowerCase())
  if (directives.includes('no-store'))
    return null

  const sMaxAge = directives.find(part => part.startsWith('s-maxage='))
  if (sMaxAge) {
    const seconds = Number.parseInt(sMaxAge.split('=')[1] || '', 10)
    if (Number.isFinite(seconds) && seconds > 0)
      return seconds
  }

  const maxAge = directives.find(part => part.startsWith('max-age='))
  if (maxAge) {
    const seconds = Number.parseInt(maxAge.split('=')[1] || '', 10)
    if (Number.isFinite(seconds) && seconds > 0)
      return seconds
  }

  return null
}

async function setOnPremCache(hostname, appId, endpoint, method, responseBody, status, responseHeaders) {
  try {
    const cacheTtl = getCacheTtlSeconds(responseHeaders)
    if (!cacheTtl) {
      console.log(`On-prem cache SKIP for ${appId}/${endpoint}/${method} (missing cache TTL)`)
      return
    }

    const cache = caches.default
    const cacheTags = `app-onprem-v2:${appId}`
    const headers = new Headers(responseHeaders)
    headers.set('Content-Type', 'application/json')
    headers.set('Cache-Tag', cacheTags)
    headers.set('X-Onprem-Cached', 'true')
    headers.set('X-Onprem-App-Id', appId)
    headers.set('X-Onprem-Ttl', String(cacheTtl))

    // Store the response cache
    const key = getOnPremCacheKey(hostname, appId, endpoint, method)
    const response = new Response(JSON.stringify(responseBody), {
      status,
      headers,
    })
    await cache.put(key, response)
    console.log(`On-prem cache SET for ${appId}/${endpoint}/${method} (${cacheTtl}s TTL)`)
  }
  catch (e) {
    console.log(`Failed to cache on-prem response: ${e.message}`)
  }
}

function isOnPremResponse(status, responseBody) {
  // Check for 429 with on_premise_app error (from /updates)
  if (status === 429 && responseBody && responseBody.error === 'on_premise_app')
    return true
  // Check for isOnprem: true (from /stats)
  if (responseBody && responseBody.isOnprem === true)
    return true
  return false
}

function isPlanUpgradeResponse(status, responseBody) {
  return status === 429 && responseBody && responseBody.error === 'need_plan_upgrade'
}

async function buildOnPremResponse(hostname, appId, endpoint, method, responseBody, status, responseHeaders) {
  // Cache only after every configured fallback agrees this is an on-prem app.
  await setOnPremCache(hostname, appId, endpoint, method, responseBody, status, responseHeaders)

  const newHeaders = new Headers(responseHeaders)
  newHeaders.set('Content-Type', 'application/json')
  newHeaders.set('X-Onprem-Cached', 'false')
  newHeaders.set('X-Onprem-App-Id', appId)

  return new Response(JSON.stringify(responseBody), {
    status,
    headers: newHeaders,
  })
}

async function setPlanUpgradeCache(hostname, appId, endpoint, method, responseBody, status, responseHeaders) {
  try {
    const cacheTtl = getCacheTtlSeconds(responseHeaders)
    if (!cacheTtl) {
      console.log(`Plan-upgrade cache SKIP for ${appId}/${endpoint}/${method} (missing cache TTL)`)
      return
    }

    const cache = caches.default
    const cacheTags = `app-plan-v2:${appId}`
    const key = getPlanUpgradeCacheKey(hostname, appId, endpoint, method)
    const headers = new Headers(responseHeaders)
    headers.set('Content-Type', 'application/json')
    headers.set('Cache-Tag', cacheTags)
    headers.set('X-Plan-Upgrade-Cached', 'true')
    headers.set('X-Plan-Upgrade-App-Id', appId)
    headers.set('X-Plan-Upgrade-Ttl', String(cacheTtl))
    const response = new Response(JSON.stringify(responseBody), {
      status,
      headers,
    })
    await cache.put(key, response)
    console.log(`Plan-upgrade cache SET for ${appId}/${endpoint}/${method} (${cacheTtl}s TTL)`)
  }
  catch (e) {
    console.log(`Failed to cache plan-upgrade response: ${e.message}`)
  }
}

function extractAppIdFromBodyBytes(requestBody) {
  if (!requestBody)
    return null
  try {
    const body = JSON.parse(new TextDecoder().decode(requestBody))
    return body.app_id ?? null
  }
  catch {
    return null
  }
}

function extractAppIdFromRequest(request, url, requestBody) {
  const method = request.method
  // For GET and DELETE on /channel_self, app_id is in query params
  if ((method === 'DELETE' || method === 'GET') && matchesEndpoint(url.pathname, '/channel_self')) {
    return url.searchParams.get('app_id')
  }
  // For POST and PUT methods, app_id is in the body (already buffered once).
  if (method === 'POST' || method === 'PUT')
    return extractAppIdFromBodyBytes(requestBody)
  // For other HTTP methods (PATCH, OPTIONS, HEAD, etc.), on-prem caching is
  // intentionally skipped as these endpoints don't use those methods
  return null
}

export default {
  async fetch(request) {
    const url = new URL(request.url)
    const method = request.method
    const hostname = url.hostname

    // Buffer POST/PUT body once — reused for app_id parse and regional fallbacks.
    const requestBody = method === 'POST' || method === 'PUT'
      ? await request.arrayBuffer()
      : undefined

    // Check on-prem cache for cacheable endpoints BEFORE routing to workers
    let appId = null
    let endpoint = null
    if (isCacheableEndpoint(url.pathname)) {
      endpoint = getEndpointName(url.pathname)
      appId = extractAppIdFromRequest(request, url, requestBody)

      if (appId) {
        const cachedPlanUpgrade = await getPlanUpgradeCache(hostname, appId, endpoint, method)
        if (cachedPlanUpgrade) {
          return cachedPlanUpgrade
        }
        const cachedResponse = await getOnPremCache(hostname, appId, endpoint, method)
        if (cachedResponse) {
          return cachedResponse
        }
      }
    }

    // Regional worker URLs - each worker is co-located with its database replica
    const WORKER_URL = {
      ASIA: 'https://plugin.as.capgo.app', // AS_INDIA DB (Mumbai)
      EUROPE: 'https://plugin.eu.capgo.app', // EU DB
      NORTH_AMERICA: 'https://plugin.na.capgo.app', // NA DB
      SOUTH_AMERICA: 'https://plugin.sa.capgo.app', // SA DB
      OCEANIA: 'https://plugin.oc.capgo.app', // OC DB
      AFRICA: 'https://plugin.af.capgo.app', // Google AF DB (africa-south1)
      MIDDLE_EAST: 'https://plugin.me.capgo.app', // Google ME DB (me-central1)
      HONG_KONG: 'https://plugin.hk.capgo.app', // Google HK DB (asia-east2)
      JAPAN: 'https://plugin.jp.capgo.app', // AS_JAPAN DB (Tokyo)
    }

    // Zone codes used for routing decisions
    const ZONE = {
      ASIA: 'AS',
      EUROPE: 'EU',
      NORTH_AMERICA: 'NA',
      SOUTH_AMERICA: 'SA',
      OCEANIA: 'OC',
      AFRICA: 'AF',
      MIDDLE_EAST: 'ME',
      HONG_KONG: 'HK',
      JAPAN: 'JP',
    }

    // Maps Cloudflare colo (data center) codes to zones
    // Full list: https://github.com/Netrvin/cloudflare-colo-list/blob/main/DC-Colos.json
    const coloToZone = {
      AAE: ZONE.AFRICA, // Annaba, Algeria
      ABJ: ZONE.AFRICA, // Abidjan, Ivory Coast
      ABQ: ZONE.NORTH_AMERICA, // Albuquerque, USA
      ACC: ZONE.AFRICA, // Accra, Ghana
      ADB: ZONE.EUROPE, // Izmir, Turkey
      ADD: ZONE.AFRICA, // Addis Ababa, Ethiopia
      ADL: ZONE.OCEANIA, // Adelaide, Australia
      AKL: ZONE.OCEANIA, // Auckland, New Zealand
      AKX: ZONE.ASIA, // Aktobe, Kazakhstan
      ALA: ZONE.ASIA, // Almaty, Kazakhstan
      ALG: ZONE.AFRICA, // Algiers, Algeria
      AMD: ZONE.ASIA, // Ahmedabad, India
      AMM: ZONE.MIDDLE_EAST, // Amman, Jordan
      AMS: ZONE.EUROPE, // Amsterdam, Netherlands
      ANC: ZONE.NORTH_AMERICA, // Anchorage, USA
      ARI: ZONE.SOUTH_AMERICA, // Arica, Chile
      ARN: ZONE.EUROPE, // Stockholm, Sweden
      ARU: ZONE.SOUTH_AMERICA, // Aracatuba, Brazil
      ASK: ZONE.AFRICA, // Yamoussoukro, Ivory Coast
      ASU: ZONE.SOUTH_AMERICA, // Asunción, Paraguay
      ATH: ZONE.EUROPE, // Athens, Greece
      ATL: ZONE.NORTH_AMERICA, // Atlanta, USA
      AUS: ZONE.NORTH_AMERICA, // Austin, USA
      BAH: ZONE.MIDDLE_EAST, // Manama, Bahrain
      BAQ: ZONE.SOUTH_AMERICA, // Barranquilla, Colombia
      BCN: ZONE.EUROPE, // Barcelona, Spain
      BEG: ZONE.EUROPE, // Belgrade, Serbia
      BEL: ZONE.SOUTH_AMERICA, // Belém, Brazil
      BGI: ZONE.NORTH_AMERICA, // Bridgetown, Barbados
      BGR: ZONE.NORTH_AMERICA, // Bangor, USA
      BGW: ZONE.MIDDLE_EAST, // Baghdad, Iraq
      BHY: ZONE.HONG_KONG, // Beihai, China
      BKK: ZONE.HONG_KONG, // Bangkok, Thailand
      BLR: ZONE.ASIA, // Bangalore, India
      BNA: ZONE.NORTH_AMERICA, // Nashville, USA
      BNE: ZONE.OCEANIA, // Brisbane, Australia
      BNU: ZONE.SOUTH_AMERICA, // Blumenau, Brazil
      BOD: ZONE.EUROPE, // Bordeaux, France
      BOG: ZONE.SOUTH_AMERICA, // Bogota, Colombia
      BOM: ZONE.ASIA, // Mumbai, India
      BOS: ZONE.NORTH_AMERICA, // Boston, USA
      BRU: ZONE.EUROPE, // Brussels, Belgium
      BSB: ZONE.SOUTH_AMERICA, // Brasilia, Brazil
      BSR: ZONE.MIDDLE_EAST, // Basra, Iraq
      BTS: ZONE.EUROPE, // Bratislava, Slovakia
      BUD: ZONE.EUROPE, // Budapest, Hungary
      BUF: ZONE.NORTH_AMERICA, // Buffalo, USA
      BWN: ZONE.HONG_KONG, // Bandar Seri Begawan, Brunei
      CAI: ZONE.AFRICA, // Cairo, Egypt
      CAN: ZONE.HONG_KONG, // Guangzhou, China
      CAW: ZONE.SOUTH_AMERICA, // Campos dos Goytacazes, Brazil
      CBR: ZONE.OCEANIA, // Canberra, Australia
      CCP: ZONE.SOUTH_AMERICA, // Concepción, Chile
      CCU: ZONE.ASIA, // Kolkata, India
      CDG: ZONE.EUROPE, // Paris, France
      CEB: ZONE.HONG_KONG, // Cebu, Philippines
      CFC: ZONE.SOUTH_AMERICA, // Cacador, Brazil
      CGB: ZONE.SOUTH_AMERICA, // Cuiaba, Brazil
      CGD: ZONE.HONG_KONG, // Changde, China
      CGK: ZONE.HONG_KONG, // Jakarta, Indonesia
      CGO: ZONE.HONG_KONG, // Zhengzhou, China
      CGP: ZONE.ASIA, // Chittagong, Bangladesh
      CGY: ZONE.HONG_KONG, // Cagayan de Oro, Philippines
      CHC: ZONE.OCEANIA, // Christchurch, New Zealand
      CKG: ZONE.HONG_KONG, // Chongqing, China
      CLE: ZONE.NORTH_AMERICA, // Cleveland, USA
      CLO: ZONE.SOUTH_AMERICA, // Cali, Colombia
      CLT: ZONE.NORTH_AMERICA, // Charlotte, USA
      CMB: ZONE.ASIA, // Colombo, Sri Lanka
      CMH: ZONE.NORTH_AMERICA, // Columbus, USA
      CNF: ZONE.SOUTH_AMERICA, // Belo Horizonte, Brazil
      CNN: ZONE.ASIA, // Kannur, India
      CNX: ZONE.HONG_KONG, // Chiang Mai, Thailand
      COK: ZONE.ASIA, // Kochi, India
      COR: ZONE.SOUTH_AMERICA, // Córdoba, Argentina
      CPH: ZONE.EUROPE, // Copenhagen, Denmark
      CPT: ZONE.AFRICA, // Cape Town, South Africa
      CRK: ZONE.HONG_KONG, // Tarlac City (Clark), Philippines
      CSX: ZONE.HONG_KONG, // Changsha, China
      CWB: ZONE.SOUTH_AMERICA, // Curitiba, Brazil
      CZL: ZONE.AFRICA, // Constantine, Algeria
      CZX: ZONE.HONG_KONG, // Changzhou, China
      DAC: ZONE.ASIA, // Dhaka, Bangladesh
      DAD: ZONE.HONG_KONG, // Da Nang, Vietnam
      DAR: ZONE.AFRICA, // Dar es Salaam, Tanzania
      DEL: ZONE.ASIA, // New Delhi, India
      DEN: ZONE.NORTH_AMERICA, // Denver, USA
      DFW: ZONE.NORTH_AMERICA, // Dallas, USA
      DKR: ZONE.AFRICA, // Dakar, Senegal
      DLC: ZONE.HONG_KONG, // Dalian, China
      DME: ZONE.EUROPE, // Moscow, Russia
      DMM: ZONE.MIDDLE_EAST, // Dammam, Saudi Arabia
      DOH: ZONE.MIDDLE_EAST, // Doha, Qatar
      DPS: ZONE.HONG_KONG, // Denpasar (Bali), Indonesia
      DTW: ZONE.NORTH_AMERICA, // Detroit, USA
      DUB: ZONE.EUROPE, // Dublin, Ireland
      DUR: ZONE.AFRICA, // Durban, South Africa
      DUS: ZONE.EUROPE, // Düsseldorf, Germany
      DXB: ZONE.MIDDLE_EAST, // Dubai, UAE
      EBB: ZONE.AFRICA, // Kampala, Uganda
      EBL: ZONE.MIDDLE_EAST, // Erbil, Iraq
      EVN: ZONE.ASIA, // Yerevan, Armenia
      EWR: ZONE.NORTH_AMERICA, // Newark, USA
      EZE: ZONE.SOUTH_AMERICA, // Buenos Aires, Argentina
      FCO: ZONE.EUROPE, // Rome, Italy
      FIH: ZONE.AFRICA, // Kinshasa, DR Congo
      FLN: ZONE.SOUTH_AMERICA, // Florianopolis, Brazil
      FOC: ZONE.HONG_KONG, // Fuzhou, China
      FOR: ZONE.SOUTH_AMERICA, // Fortaleza, Brazil
      FRA: ZONE.EUROPE, // Frankfurt, Germany
      FRU: ZONE.ASIA, // Bishkek, Kyrgyzstan
      FSD: ZONE.NORTH_AMERICA, // Sioux Falls, USA
      FUK: ZONE.JAPAN, // Fukuoka, Japan
      CTS: ZONE.JAPAN, // Sapporo, Japan
      NGO: ZONE.JAPAN, // Nagoya, Japan
      SDJ: ZONE.JAPAN, // Sendai, Japan
      KOJ: ZONE.JAPAN, // Kagoshima, Japan
      FUO: ZONE.HONG_KONG, // Foshan, China
      GBE: ZONE.AFRICA, // Gaborone, Botswana
      GDL: ZONE.NORTH_AMERICA, // Guadalajara, Mexico
      GEO: ZONE.SOUTH_AMERICA, // Georgetown, Guyana
      GIG: ZONE.SOUTH_AMERICA, // Rio de Janeiro, Brazil
      GND: ZONE.SOUTH_AMERICA, // St. George's, Grenada
      GOT: ZONE.EUROPE, // Gothenburg, Sweden
      GRU: ZONE.SOUTH_AMERICA, // São Paulo, Brazil
      GUA: ZONE.NORTH_AMERICA, // Guatemala City, Guatemala
      GUM: ZONE.ASIA, // Hagatna, Guam
      GVA: ZONE.EUROPE, // Geneva, Switzerland
      GYD: ZONE.ASIA, // Baku, Azerbaijan
      GYE: ZONE.SOUTH_AMERICA, // Guayaquil, Ecuador
      GYN: ZONE.SOUTH_AMERICA, // Goiania, Brazil
      HAK: ZONE.HONG_KONG, // Chengmai (Haikou), China
      HAM: ZONE.EUROPE, // Hamburg, Germany
      HAN: ZONE.HONG_KONG, // Hanoi, Vietnam
      HBA: ZONE.OCEANIA, // Hobart, Australia
      HEL: ZONE.EUROPE, // Helsinki, Finland
      HFA: ZONE.MIDDLE_EAST, // Haifa, Israel
      HGH: ZONE.HONG_KONG, // Shaoxing (Hangzhou), China
      HKG: ZONE.HONG_KONG, // Hong Kong
      HNL: ZONE.NORTH_AMERICA, // Honolulu, USA
      HRE: ZONE.AFRICA, // Harare, Zimbabwe
      HYD: ZONE.ASIA, // Hyderabad, India
      HYN: ZONE.HONG_KONG, // Taizhou, China
      IAD: ZONE.NORTH_AMERICA, // Ashburn (Washington DC), USA
      IAH: ZONE.NORTH_AMERICA, // Houston, USA
      ICN: ZONE.JAPAN, // Seoul, South Korea (North Asia -> Japan)
      IND: ZONE.NORTH_AMERICA, // Indianapolis, USA
      ISB: ZONE.ASIA, // Islamabad, Pakistan
      IST: ZONE.EUROPE, // Istanbul, Turkey
      ISU: ZONE.MIDDLE_EAST, // Sulaymaniyah, Iraq
      ITJ: ZONE.SOUTH_AMERICA, // Itajai, Brazil
      IXC: ZONE.ASIA, // Chandigarh, India
      JAX: ZONE.NORTH_AMERICA, // Jacksonville, USA
      JDO: ZONE.SOUTH_AMERICA, // Juazeiro do Norte, Brazil
      JED: ZONE.MIDDLE_EAST, // Jeddah, Saudi Arabia
      JHB: ZONE.HONG_KONG, // Johor Bahru, Malaysia
      JIB: ZONE.AFRICA, // Djibouti
      JNB: ZONE.AFRICA, // Johannesburg, South Africa
      JOG: ZONE.HONG_KONG, // Yogyakarta, Indonesia
      JOI: ZONE.SOUTH_AMERICA, // Joinville, Brazil
      JXG: ZONE.HONG_KONG, // Jiaxing, China
      KBP: ZONE.EUROPE, // Kyiv, Ukraine
      KCH: ZONE.HONG_KONG, // Kuching, Malaysia
      KEF: ZONE.EUROPE, // Reykjavík, Iceland
      KGL: ZONE.AFRICA, // Kigali, Rwanda
      KHH: ZONE.JAPAN, // Kaohsiung City, Taiwan (North Asia -> Japan)
      KHI: ZONE.ASIA, // Karachi, Pakistan
      KHN: ZONE.HONG_KONG, // Nanchang, China
      KIN: ZONE.NORTH_AMERICA, // Kingston, Jamaica
      KIV: ZONE.EUROPE, // Chișinău, Moldova
      KIX: ZONE.JAPAN, // Osaka, Japan
      KJA: ZONE.ASIA, // Krasnoyarsk, Russia
      KMG: ZONE.HONG_KONG, // Kunming, China
      KNU: ZONE.ASIA, // Kanpur, India
      KTM: ZONE.ASIA, // Kathmandu, Nepal
      KUL: ZONE.HONG_KONG, // Kuala Lumpur, Malaysia
      KWE: ZONE.HONG_KONG, // Guiyang, China
      KWI: ZONE.MIDDLE_EAST, // Kuwait City, Kuwait
      LAD: ZONE.AFRICA, // Luanda, Angola
      LAS: ZONE.NORTH_AMERICA, // Las Vegas, USA
      LAX: ZONE.NORTH_AMERICA, // Los Angeles, USA
      LCA: ZONE.EUROPE, // Nicosia, Cyprus
      LED: ZONE.EUROPE, // Saint Petersburg, Russia
      LHR: ZONE.EUROPE, // London, UK
      LIM: ZONE.SOUTH_AMERICA, // Lima, Peru
      LIS: ZONE.EUROPE, // Lisbon, Portugal
      LLK: ZONE.ASIA, // Astara, Azerbaijan
      LLW: ZONE.AFRICA, // Lilongwe, Malawi
      LOS: ZONE.AFRICA, // Lagos, Nigeria
      LPB: ZONE.SOUTH_AMERICA, // La Paz, Bolivia
      LUN: ZONE.AFRICA, // Lusaka, Zambia
      LUX: ZONE.EUROPE, // Luxembourg City, Luxembourg
      LYS: ZONE.EUROPE, // Lyon, France
      MAA: ZONE.ASIA, // Chennai, India
      MAD: ZONE.EUROPE, // Madrid, Spain
      MAN: ZONE.EUROPE, // Manchester, UK
      MAO: ZONE.SOUTH_AMERICA, // Manaus, Brazil
      MBA: ZONE.AFRICA, // Mombasa, Kenya
      MCI: ZONE.NORTH_AMERICA, // Kansas City, USA
      MCT: ZONE.MIDDLE_EAST, // Muscat, Oman
      MDE: ZONE.SOUTH_AMERICA, // Medellín, Colombia
      MEL: ZONE.OCEANIA, // Melbourne, Australia
      MEM: ZONE.NORTH_AMERICA, // Memphis, USA
      MEX: ZONE.NORTH_AMERICA, // Mexico City, Mexico
      MFM: ZONE.HONG_KONG, // Macau
      MIA: ZONE.NORTH_AMERICA, // Miami, USA
      MLE: ZONE.ASIA, // Male, Maldives
      MNL: ZONE.HONG_KONG, // Manila, Philippines
      MPM: ZONE.AFRICA, // Maputo, Mozambique
      MRS: ZONE.EUROPE, // Marseille, France
      MRU: ZONE.AFRICA, // Port Louis, Mauritius
      MSP: ZONE.NORTH_AMERICA, // Minneapolis, USA
      MSQ: ZONE.EUROPE, // Minsk, Belarus
      MUC: ZONE.EUROPE, // Munich, Germany
      MXP: ZONE.EUROPE, // Milan, Italy
      NAG: ZONE.ASIA, // Nagpur, India
      NBO: ZONE.AFRICA, // Nairobi, Kenya
      NJF: ZONE.MIDDLE_EAST, // Najaf, Iraq
      NNG: ZONE.HONG_KONG, // Nanning, China
      NOU: ZONE.OCEANIA, // Noumea, New Caledonia
      NQN: ZONE.SOUTH_AMERICA, // Neuquen, Argentina
      NQZ: ZONE.ASIA, // Astana, Kazakhstan
      NRT: ZONE.JAPAN, // Tokyo Narita, Japan
      NVT: ZONE.SOUTH_AMERICA, // Timbo (Navegantes), Brazil
      OKA: ZONE.JAPAN, // Naha (Okinawa), Japan
      OKC: ZONE.NORTH_AMERICA, // Oklahoma City, USA
      OMA: ZONE.NORTH_AMERICA, // Omaha, USA
      ORD: ZONE.NORTH_AMERICA, // Chicago, USA
      ORF: ZONE.NORTH_AMERICA, // Norfolk, USA
      ORN: ZONE.AFRICA, // Oran, Algeria
      OSL: ZONE.EUROPE, // Oslo, Norway
      OTP: ZONE.EUROPE, // Bucharest, Romania
      OUA: ZONE.AFRICA, // Ouagadougou, Burkina Faso
      PAT: ZONE.ASIA, // Patna, India
      PBH: ZONE.ASIA, // Thimphu, Bhutan
      PBM: ZONE.SOUTH_AMERICA, // Paramaribo, Suriname
      PDX: ZONE.NORTH_AMERICA, // Portland, USA
      PER: ZONE.OCEANIA, // Perth, Australia
      PHL: ZONE.NORTH_AMERICA, // Philadelphia, USA
      PHX: ZONE.NORTH_AMERICA, // Phoenix, USA
      PIT: ZONE.NORTH_AMERICA, // Pittsburgh, USA
      PKX: ZONE.HONG_KONG, // Langfang (Beijing), China
      PMO: ZONE.EUROPE, // Palermo, Italy
      PMW: ZONE.SOUTH_AMERICA, // Palmas, Brazil
      PNH: ZONE.HONG_KONG, // Phnom Penh, Cambodia
      POA: ZONE.SOUTH_AMERICA, // Porto Alegre, Brazil
      POS: ZONE.SOUTH_AMERICA, // Port of Spain, Trinidad
      PPT: ZONE.OCEANIA, // Tahiti, French Polynesia
      PRG: ZONE.EUROPE, // Prague, Czech Republic
      PTY: ZONE.SOUTH_AMERICA, // Panama City, Panama
      QRO: ZONE.NORTH_AMERICA, // Queretaro, Mexico
      QWJ: ZONE.SOUTH_AMERICA, // Americana, Brazil
      RAO: ZONE.SOUTH_AMERICA, // Ribeirao Preto, Brazil
      RDU: ZONE.NORTH_AMERICA, // Durham (Raleigh), USA
      REC: ZONE.SOUTH_AMERICA, // Recife, Brazil
      RIC: ZONE.NORTH_AMERICA, // Richmond, USA
      RIX: ZONE.EUROPE, // Riga, Latvia
      RUH: ZONE.MIDDLE_EAST, // Riyadh, Saudi Arabia
      RUN: ZONE.AFRICA, // Saint-Denis, Réunion
      SAN: ZONE.NORTH_AMERICA, // San Diego, USA
      SAP: ZONE.SOUTH_AMERICA, // San Pedro Sula, Honduras
      SAT: ZONE.NORTH_AMERICA, // San Antonio, USA
      SCL: ZONE.SOUTH_AMERICA, // Santiago, Chile
      SDQ: ZONE.NORTH_AMERICA, // Santo Domingo, Dominican Republic
      SEA: ZONE.NORTH_AMERICA, // Seattle, USA
      SFO: ZONE.NORTH_AMERICA, // San Francisco, USA
      SGN: ZONE.HONG_KONG, // Ho Chi Minh City, Vietnam
      SHA: ZONE.HONG_KONG, // Shanghai, China
      SIN: ZONE.HONG_KONG, // Singapore
      SJC: ZONE.NORTH_AMERICA, // San Jose, USA
      SJK: ZONE.SOUTH_AMERICA, // São José dos Campos, Brazil
      SJO: ZONE.SOUTH_AMERICA, // San José, Costa Rica
      SJP: ZONE.SOUTH_AMERICA, // São José do Rio Preto, Brazil
      SJU: ZONE.NORTH_AMERICA, // San Juan, Puerto Rico
      SJW: ZONE.HONG_KONG, // Shijiazhuang, China
      SKG: ZONE.EUROPE, // Thessaloniki, Greece
      SKP: ZONE.EUROPE, // Skopje, North Macedonia
      SLC: ZONE.NORTH_AMERICA, // Salt Lake City, USA
      SMF: ZONE.NORTH_AMERICA, // Sacramento, USA
      SOD: ZONE.SOUTH_AMERICA, // Sorocaba, Brazil
      SOF: ZONE.EUROPE, // Sofia, Bulgaria
      SSA: ZONE.SOUTH_AMERICA, // Salvador, Brazil
      STI: ZONE.NORTH_AMERICA, // Santiago de los Caballeros, Dominican Republic
      STL: ZONE.NORTH_AMERICA, // St. Louis, USA
      STR: ZONE.EUROPE, // Stuttgart, Germany
      SUV: ZONE.OCEANIA, // Suva, Fiji
      SYD: ZONE.OCEANIA, // Sydney, Australia
      SZX: ZONE.HONG_KONG, // Shenzhen, China
      TAO: ZONE.HONG_KONG, // Qingdao, China
      TBS: ZONE.EUROPE, // Tbilisi, Georgia
      TEN: ZONE.HONG_KONG, // Tongren, China
      TGU: ZONE.SOUTH_AMERICA, // Tegucigalpa, Honduras
      TIA: ZONE.EUROPE, // Tirana, Albania
      TLH: ZONE.NORTH_AMERICA, // Tallahassee, USA
      TLL: ZONE.EUROPE, // Tallinn, Estonia
      TLV: ZONE.MIDDLE_EAST, // Tel Aviv, Israel
      TNA: ZONE.HONG_KONG, // Zibo (Jinan), China
      TNR: ZONE.AFRICA, // Antananarivo, Madagascar
      TPA: ZONE.NORTH_AMERICA, // Tampa, USA
      TPE: ZONE.JAPAN, // Taipei, Taiwan (North Asia -> Japan)
      TUN: ZONE.AFRICA, // Tunis, Tunisia
      TXL: ZONE.EUROPE, // Berlin, Germany
      TYN: ZONE.HONG_KONG, // Yangquan (Taiyuan), China
      UDI: ZONE.SOUTH_AMERICA, // Uberlandia, Brazil
      UIO: ZONE.SOUTH_AMERICA, // Quito, Ecuador
      ULN: ZONE.JAPAN, // Ulaanbaatar, Mongolia (North Asia -> Japan)
      URT: ZONE.HONG_KONG, // Surat Thani, Thailand
      VCP: ZONE.SOUTH_AMERICA, // Campinas, Brazil
      VIE: ZONE.EUROPE, // Vienna, Austria
      VIX: ZONE.SOUTH_AMERICA, // Vitoria, Brazil
      VNO: ZONE.EUROPE, // Vilnius, Lithuania
      VTE: ZONE.HONG_KONG, // Vientiane, Laos
      WAW: ZONE.EUROPE, // Warsaw, Poland
      WDH: ZONE.AFRICA, // Windhoek, Namibia
      XAP: ZONE.SOUTH_AMERICA, // Chapeco, Brazil
      XFN: ZONE.HONG_KONG, // Xiangyang, China
      XIY: ZONE.HONG_KONG, // Baoji (Xi'an), China
      XNH: ZONE.MIDDLE_EAST, // Nasiriyah, Iraq
      XNN: ZONE.HONG_KONG, // Xining, China
      YHZ: ZONE.NORTH_AMERICA, // Halifax, Canada
      YOW: ZONE.NORTH_AMERICA, // Ottawa, Canada
      YUL: ZONE.NORTH_AMERICA, // Montréal, Canada
      YVR: ZONE.NORTH_AMERICA, // Vancouver, Canada
      YWG: ZONE.NORTH_AMERICA, // Winnipeg, Canada
      YXE: ZONE.NORTH_AMERICA, // Saskatoon, Canada
      YYC: ZONE.NORTH_AMERICA, // Calgary, Canada
      YYZ: ZONE.NORTH_AMERICA, // Toronto, Canada
      ZAG: ZONE.EUROPE, // Zagreb, Croatia
      ZDM: ZONE.MIDDLE_EAST, // Ramallah, Palestine
      ZRH: ZONE.EUROPE, // Zurich, Switzerland
    }

    // Fallback order for each zone
    const zoneFallbackUrls = {
      [ZONE.HONG_KONG]: [WORKER_URL.HONG_KONG, WORKER_URL.JAPAN, WORKER_URL.ASIA],
      [ZONE.JAPAN]: [WORKER_URL.JAPAN, WORKER_URL.HONG_KONG, WORKER_URL.ASIA],
      [ZONE.ASIA]: [WORKER_URL.ASIA, WORKER_URL.HONG_KONG, WORKER_URL.EUROPE],
      [ZONE.AFRICA]: [WORKER_URL.AFRICA, WORKER_URL.ASIA, WORKER_URL.EUROPE],
      [ZONE.MIDDLE_EAST]: [WORKER_URL.MIDDLE_EAST, WORKER_URL.ASIA, WORKER_URL.EUROPE],
      [ZONE.EUROPE]: [WORKER_URL.EUROPE, WORKER_URL.NORTH_AMERICA],
      [ZONE.NORTH_AMERICA]: [WORKER_URL.NORTH_AMERICA, WORKER_URL.EUROPE],
      [ZONE.SOUTH_AMERICA]: [WORKER_URL.SOUTH_AMERICA, WORKER_URL.NORTH_AMERICA, WORKER_URL.EUROPE],
      [ZONE.OCEANIA]: [WORKER_URL.OCEANIA, WORKER_URL.HONG_KONG, WORKER_URL.ASIA],
    }

    // Use the cf object to obtain the colo of the request
    // colo: The three-letter IATA airport code of the data center that the request hit, for example, "DFW".
    // more on the cf object: https://developers.cloudflare.com/workers/runtime-apis/request#incomingrequestcfproperties
    const colo = request.cf.colo
    const zone = coloToZone[colo] ?? ZONE.EUROPE
    const pathWithQuery = url.pathname + url.search

    const fallbackUrls = zoneFallbackUrls[zone] || [WORKER_URL.EUROPE]
    let pendingOnPrem = null
    let onPremConfirmations = 0
    let successfulFallbacks = 0
    let fallbackFailure = false
    // After first on-prem hit, confirm with at most one more healthy worker (not the full mesh).
    let onPremConfirmPending = false

    for (let index = 0; index < fallbackUrls.length; index++) {
      const workerUrl = fallbackUrls[index]
      // Skip unhealthy workers (circuit is open)
      const healthy = await isHealthy(hostname, colo, workerUrl)
      if (!healthy) {
        fallbackFailure = true
        console.log(`Skipping ${workerUrl} (circuit open for ${colo})`)
        continue
      }

      try {
        const abortController = new AbortController()
        const timeoutId = setTimeout(() => abortController.abort(), TIMEOUT_MS)

        const response = await fetch(`${workerUrl}${pathWithQuery}`, {
          method: request.method,
          headers: request.headers,
          body: requestBody ? requestBody.slice(0) : undefined,
          signal: abortController.signal,
        })

        clearTimeout(timeoutId)

        // Check for server errors (5xx) - infrastructure problem
        if (response.status >= 500) {
          fallbackFailure = true
          console.log(`${workerUrl} returned ${response.status}, marking unhealthy`)
          await markUnhealthy(hostname, colo, workerUrl)
          continue // try fallback
        }

        // Success (2xx, 3xx, 4xx) - worker is healthy
        await markHealthy(hostname, colo, workerUrl)
        successfulFallbacks += 1
        console.log(`Request served by ${workerUrl}`)

        // Check if this is an on-prem response that should be cached
        if (appId && endpoint) {
          try {
            const responseClone = response.clone()
            const responseBody = await responseClone.json()

            if (isOnPremResponse(response.status, responseBody)) {
              onPremConfirmations += 1
              pendingOnPrem = {
                responseBody,
                status: response.status,
                headers: response.headers,
                workerUrl,
              }
              // Confirm with one extra healthy worker when available; otherwise finalize.
              if (onPremConfirmations === 1 && index < fallbackUrls.length - 1) {
                onPremConfirmPending = true
                console.log(`${workerUrl} returned on-prem for ${appId}; confirming with one fallback worker`)
                continue
              }
              // Never cache after a skipped/failed configured fallback (partial outage).
              if (fallbackFailure) {
                console.log(`On-prem seen after fallback failure for ${appId}; not caching`)
                continue
              }
              console.log(`On-prem confirmed (${onPremConfirmations}) for ${appId}`)
              return await buildOnPremResponse(hostname, appId, endpoint, method, pendingOnPrem.responseBody, pendingOnPrem.status, pendingOnPrem.headers)
            }

            // A non-on-prem response during confirm means do not cache on-prem.
            if (onPremConfirmPending) {
              console.log(`${workerUrl} disagreed on on-prem for ${appId}; serving cloud response`)
              onPremConfirmPending = false
              pendingOnPrem = null
            }

            if (isPlanUpgradeResponse(response.status, responseBody)) {
              // Cache plan-upgrade responses for a short TTL to reduce burst traffic
              setPlanUpgradeCache(hostname, appId, endpoint, method, responseBody, response.status, response.headers)

              const newHeaders = new Headers(response.headers)
              newHeaders.set('Content-Type', 'application/json')
              newHeaders.set('X-Plan-Upgrade-Cached', 'false')
              newHeaders.set('X-Plan-Upgrade-App-Id', appId)

              return new Response(JSON.stringify(responseBody), {
                status: response.status,
                headers: newHeaders,
              })
            }
          }
          catch {
            // Response is not JSON or parsing failed - skip on-prem cache check and return original response
          }
        }

        return response
      }
      catch (error) {
        // Network failure or timeout - mark unhealthy
        fallbackFailure = true
        console.log(`${workerUrl} failed: ${error.message}, marking unhealthy`)
        await markUnhealthy(hostname, colo, workerUrl)
        // continue to next fallback
      }
    }

    // If we only got on-prem responses (and maybe failed to confirm), cache when all successes agreed.
    if (pendingOnPrem && !fallbackFailure && successfulFallbacks > 0 && onPremConfirmations === successfulFallbacks) {
      console.log(`All ${onPremConfirmations}/${successfulFallbacks} successful fallback workers returned on-prem for ${appId}`)
      return await buildOnPremResponse(hostname, appId, endpoint, method, pendingOnPrem.responseBody, pendingOnPrem.status, pendingOnPrem.headers)
    }
    if (pendingOnPrem) {
      const failureLog = fallbackFailure ? '; at least one configured fallback failed or was skipped' : ''
      console.log(`Only ${onPremConfirmations}/${successfulFallbacks} successful fallback workers returned on-prem for ${appId}${failureLog}; falling back to original request`)
    }
    else {
      console.log('All workers failed, falling back to original request')
    }

    // No worker produced a usable non-on-prem response, so try the original request as last resort.
    // Body was consumed into requestBody — rebuild Request when needed.
    if (requestBody) {
      return fetch(new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: requestBody.slice(0),
      }))
    }
    return fetch(request)
  },
}
