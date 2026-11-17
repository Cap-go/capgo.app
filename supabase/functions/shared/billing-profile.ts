// Tax ID types supported by the pinned 2026-03-25.dahlia API. Stripe validates each value.
export const BILLING_TAX_ID_TYPES = [
  'ad_nrt',
  'ae_trn',
  'al_tin',
  'am_tin',
  'ao_tin',
  'ar_cuit',
  'au_abn',
  'au_arn',
  'aw_tin',
  'az_tin',
  'ba_tin',
  'bb_tin',
  'bd_bin',
  'bf_ifu',
  'bg_uic',
  'bh_vat',
  'bj_ifu',
  'bo_tin',
  'br_cnpj',
  'br_cpf',
  'bs_tin',
  'by_tin',
  'ca_bn',
  'ca_gst_hst',
  'ca_pst_bc',
  'ca_pst_mb',
  'ca_pst_sk',
  'ca_qst',
  'cd_nif',
  'ch_uid',
  'ch_vat',
  'cl_tin',
  'cm_niu',
  'cn_tin',
  'co_nit',
  'cr_tin',
  'cv_nif',
  'de_stn',
  'do_rcn',
  'ec_ruc',
  'eg_tin',
  'es_cif',
  'et_tin',
  'eu_oss_vat',
  'eu_vat',
  'gb_vat',
  'ge_vat',
  'gn_nif',
  'hk_br',
  'hr_oib',
  'hu_tin',
  'id_npwp',
  'il_vat',
  'in_gst',
  'is_vat',
  'jp_cn',
  'jp_rn',
  'jp_trn',
  'ke_pin',
  'kg_tin',
  'kh_tin',
  'kr_brn',
  'kz_bin',
  'la_tin',
  'li_uid',
  'li_vat',
  'lk_vat',
  'ma_vat',
  'md_vat',
  'me_pib',
  'mk_vat',
  'mr_nif',
  'mx_rfc',
  'my_frp',
  'my_itn',
  'my_sst',
  'ng_tin',
  'no_vat',
  'no_voec',
  'np_pan',
  'nz_gst',
  'om_vat',
  'pe_ruc',
  'ph_tin',
  'pl_nip',
  'ro_tin',
  'rs_pib',
  'ru_inn',
  'ru_kpp',
  'sa_vat',
  'sg_gst',
  'sg_uen',
  'si_tin',
  'sn_ninea',
  'sr_fin',
  'sv_nit',
  'th_vat',
  'tj_tin',
  'tr_tin',
  'tw_vat',
  'tz_vat',
  'ua_vat',
  'ug_tin',
  'us_ein',
  'uy_ruc',
  'uz_tin',
  'uz_vat',
  've_rif',
  'vn_tin',
  'za_vat',
  'zm_tin',
  'zw_tin',
] as const

export interface BillingAddress {
  line1: string
  line2: string
  city: string
  state: string
  postal_code: string
  country: string
}

export interface BillingDetails {
  name: string
  email: string
  phone: string
  address: BillingAddress
}

export interface BillingTaxId {
  id: string
  type: string
  value: string
  status: 'pending' | 'unavailable' | 'unverified' | 'verified'
}

export interface BillingProfile extends BillingDetails {
  currency: string | null
  taxIds: BillingTaxId[]
}

// ISO 3166-1 alpha-2 country codes for billing addresses.
export const BILLING_COUNTRIES = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ')

export interface BillingCurrencyState {
  regionalDiscountEligible: boolean
  currency: string | null
  currencies: string[]
  subscriptionId: string | null
  endsAt: string | null
  pendingCurrency: string | null
}

export interface BillingCurrencyPreview {
  currency: string
  amount: number
  interval: 'month' | 'year'
  subscriptionId: string
  quoteId: string
}
