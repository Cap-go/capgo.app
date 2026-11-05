/**
 * Networks (ASNs) of the provider infrastructure that apps with
 * `block_provider_infra_requests` refuse: Google (test labs, crawlers) and
 * Apple (App Review). The worker blocks a datacenter IP of these networks
 * (invalids_ip.ts); the snippet, which cannot look an IP up, sends every
 * request of these networks to the worker (snippetEdgeAnswer.ts).
 */
export const GOOGLE_PROVIDER_ASNS = [15169, 16591, 19527, 36040, 36492, 43515, 139070, 396982]
export const APPLE_PROVIDER_ASNS = [714, 6185]
export const PROVIDER_INFRA_ASNS = [...GOOGLE_PROVIDER_ASNS, ...APPLE_PROVIDER_ASNS]
