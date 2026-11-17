import type { ServingRegion } from './servingRegions.ts'

// Same ingress colo groupings as the plugin load balancer. Unknown colos fail closed for block mode.
const COLO_REGIONS: Record<string, ServingRegion> = {
      AAE: 'AF', // Annaba, Algeria
      ABJ: 'AF', // Abidjan, Ivory Coast
      ABQ: 'NA', // Albuquerque, USA
      ACC: 'AF', // Accra, Ghana
      ACX: 'HK', // Xingyi, China
      ADB: 'EU', // Izmir, Turkey
      ADD: 'AF', // Addis Ababa, Ethiopia
      ADL: 'OC', // Adelaide, Australia
      AGR: 'AS_INDIA', // Agra, India
      AIP: 'AS_INDIA', // Jalandhar, India
      AKL: 'OC', // Auckland, New Zealand
      AKX: 'AS_INDIA', // Aktobe, Kazakhstan
      ALA: 'AS_INDIA', // Almaty, Kazakhstan
      ALG: 'AF', // Algiers, Algeria
      AMD: 'AS_INDIA', // Ahmedabad, India
      AMM: 'ME', // Amman, Jordan
      AMS: 'EU', // Amsterdam, Netherlands
      ANC: 'NA', // Anchorage, USA
      ARI: 'SA', // Arica, Chile
      ARN: 'EU', // Stockholm, Sweden
      ARU: 'SA', // Aracatuba, Brazil
      ASK: 'AF', // Yamoussoukro, Ivory Coast
      ASU: 'SA', // Asunción, Paraguay
      ATH: 'EU', // Athens, Greece
      ATL: 'NA', // Atlanta, USA
      AUS: 'NA', // Austin, USA
      AVA: 'HK', // Anshun, China
      BAH: 'ME', // Manama, Bahrain
      BAQ: 'SA', // Barranquilla, Colombia
      BBI: 'AS_INDIA', // Bhubaneswar, India
      BCN: 'EU', // Barcelona, Spain
      BDQ: 'AS_INDIA', // Jamnagar (Vadodara airport code), India
      BEG: 'EU', // Belgrade, Serbia
      BEL: 'SA', // Belém, Brazil
      BEY: 'ME', // Beirut, Lebanon
      BGI: 'NA', // Bridgetown, Barbados
      BGR: 'NA', // Bangor, USA
      BGW: 'ME', // Baghdad, Iraq
      BHY: 'HK', // Beihai, China
      BKK: 'HK', // Bangkok, Thailand
      BLR: 'AS_INDIA', // Bangalore, India
      BNA: 'NA', // Nashville, USA
      BNE: 'OC', // Brisbane, Australia
      BNU: 'SA', // Blumenau, Brazil
      BOD: 'EU', // Bordeaux, France
      BOG: 'SA', // Bogota, Colombia
      BOM: 'AS_INDIA', // Mumbai, India
      BOS: 'NA', // Boston, USA
      BRU: 'EU', // Brussels, Belgium
      BSB: 'SA', // Brasilia, Brazil
      BSR: 'ME', // Basra, Iraq
      BTS: 'EU', // Bratislava, Slovakia
      BUD: 'EU', // Budapest, Hungary
      BUF: 'NA', // Buffalo, USA
      BWN: 'HK', // Bandar Seri Begawan, Brunei
      CAI: 'AF', // Cairo, Egypt
      CAN: 'HK', // Guangzhou, China
      CAW: 'SA', // Campos dos Goytacazes, Brazil
      CBR: 'OC', // Canberra, Australia
      CCP: 'SA', // Concepción, Chile
      CCU: 'AS_INDIA', // Kolkata, India
      CDG: 'EU', // Paris, France
      CEB: 'HK', // Cebu, Philippines
      CFC: 'SA', // Cacador, Brazil
      CGB: 'SA', // Cuiaba, Brazil
      CGD: 'HK', // Changde, China
      CGK: 'HK', // Jakarta, Indonesia
      CGO: 'HK', // Zhengzhou, China
      CGP: 'AS_INDIA', // Chittagong, Bangladesh
      CGY: 'HK', // Cagayan de Oro, Philippines
      CHC: 'OC', // Christchurch, New Zealand
      CJB: 'AS_INDIA', // Coimbatore, India
      CKG: 'HK', // Chongqing, China
      CLE: 'NA', // Cleveland, USA
      CLO: 'SA', // Cali, Colombia
      CLT: 'NA', // Charlotte, USA
      CMB: 'AS_INDIA', // Colombo, Sri Lanka
      CMH: 'NA', // Columbus, USA
      CNF: 'SA', // Belo Horizonte, Brazil
      CNN: 'AS_INDIA', // Kannur, India
      CNX: 'HK', // Chiang Mai, Thailand
      COK: 'AS_INDIA', // Kochi, India
      COR: 'SA', // Córdoba, Argentina
      CPH: 'EU', // Copenhagen, Denmark
      CPT: 'AF', // Cape Town, South Africa
      CRK: 'HK', // Tarlac City (Clark), Philippines
      CSX: 'HK', // Changsha, China
      CTS: 'AS_JAPAN', // Sapporo, Japan
      CTU: 'HK', // Chengdu, China
      CVG: 'NA', // Cincinnati, USA
      CWB: 'SA', // Curitiba, Brazil
      CZL: 'AF', // Constantine, Algeria
      CZX: 'HK', // Changzhou, China
      DAC: 'AS_INDIA', // Dhaka, Bangladesh
      DAD: 'HK', // Da Nang, Vietnam
      DAR: 'AF', // Dar es Salaam, Tanzania
      DEL: 'AS_INDIA', // New Delhi, India
      DEN: 'NA', // Denver, USA
      DFW: 'NA', // Dallas, USA
      DKR: 'AF', // Dakar, Senegal
      DLA: 'AF', // Douala, Cameroon
      DLC: 'HK', // Dalian, China
      DME: 'EU', // Moscow, Russia
      DMM: 'ME', // Dammam, Saudi Arabia
      DOH: 'ME', // Doha, Qatar
      DPS: 'HK', // Denpasar (Bali), Indonesia
      DTW: 'NA', // Detroit, USA
      DUB: 'EU', // Dublin, Ireland
      DUR: 'AF', // Durban, South Africa
      DUS: 'EU', // Düsseldorf, Germany
      DXB: 'ME', // Dubai, UAE
      DYU: 'AS_INDIA', // Dushanbe, Tajikistan
      EBB: 'AF', // Kampala, Uganda
      EBL: 'ME', // Erbil, Iraq
      EVN: 'AS_INDIA', // Yerevan, Armenia
      EWR: 'NA', // Newark, USA
      EZE: 'SA', // Buenos Aires, Argentina
      FCO: 'EU', // Rome, Italy
      FIH: 'AF', // Kinshasa, DR Congo
      FLN: 'SA', // Florianopolis, Brazil
      FOC: 'HK', // Fuzhou, China
      FOR: 'SA', // Fortaleza, Brazil
      FRA: 'EU', // Frankfurt, Germany
      FRU: 'AS_INDIA', // Bishkek, Kyrgyzstan
      FSD: 'NA', // Sioux Falls, USA
      FUK: 'AS_JAPAN', // Fukuoka, Japan
      FUO: 'HK', // Foshan, China
      GBE: 'AF', // Gaborone, Botswana
      GDL: 'NA', // Guadalajara, Mexico
      GEO: 'SA', // Georgetown, Guyana
      GIG: 'SA', // Rio de Janeiro, Brazil
      GND: 'SA', // St. George's, Grenada
      GOT: 'EU', // Gothenburg, Sweden
      GRU: 'SA', // São Paulo, Brazil
      GUA: 'NA', // Guatemala City, Guatemala
      GUM: 'AS_INDIA', // Hagatna, Guam
      GVA: 'EU', // Geneva, Switzerland
      GYD: 'AS_INDIA', // Baku, Azerbaijan
      GYE: 'SA', // Guayaquil, Ecuador
      GYN: 'SA', // Goiania, Brazil
      HAK: 'HK', // Chengmai (Haikou), China
      HAM: 'EU', // Hamburg, Germany
      HAN: 'HK', // Hanoi, Vietnam
      HBA: 'OC', // Hobart, Australia
      HEL: 'EU', // Helsinki, Finland
      HFA: 'ME', // Haifa, Israel
      HGH: 'HK', // Shaoxing (Hangzhou), China
      HKG: 'HK', // Hong Kong
      HNL: 'NA', // Honolulu, USA
      HRE: 'AF', // Harare, Zimbabwe
      HYD: 'AS_INDIA', // Hyderabad, India
      HYN: 'HK', // Taizhou, China
      IAD: 'NA', // Ashburn (Washington DC), USA
      IAH: 'NA', // Houston, USA
      ICN: 'AS_JAPAN', // Seoul, South Korea (North Asia -> Japan)
      IND: 'NA', // Indianapolis, USA
      ISB: 'AS_INDIA', // Islamabad, Pakistan
      IST: 'EU', // Istanbul, Turkey
      ISU: 'ME', // Sulaymaniyah, Iraq
      ITJ: 'SA', // Itajai, Brazil
      IXC: 'AS_INDIA', // Chandigarh, India
      JAX: 'NA', // Jacksonville, USA
      JDO: 'SA', // Juazeiro do Norte, Brazil
      JED: 'ME', // Jeddah, Saudi Arabia
      JHB: 'HK', // Johor Bahru, Malaysia
      JIB: 'AF', // Djibouti
      JNB: 'AF', // Johannesburg, South Africa
      JOG: 'HK', // Yogyakarta, Indonesia
      JOI: 'SA', // Joinville, Brazil
      JRG: 'AS_INDIA', // Sambalpur, India
      JXG: 'HK', // Jiaxing, China
      KBP: 'EU', // Kyiv, Ukraine
      KCH: 'HK', // Kuching, Malaysia
      KEF: 'EU', // Reykjavík, Iceland
      KGL: 'AF', // Kigali, Rwanda
      KHH: 'AS_JAPAN', // Kaohsiung City, Taiwan (North Asia -> Japan)
      KHI: 'AS_INDIA', // Karachi, Pakistan
      KHN: 'HK', // Nanchang, China
      KIN: 'NA', // Kingston, Jamaica
      KIV: 'EU', // Chișinău, Moldova
      KIX: 'AS_JAPAN', // Osaka, Japan
      KJA: 'AS_INDIA', // Krasnoyarsk, Russia
      KMG: 'HK', // Kunming, China
      KNU: 'AS_INDIA', // Kanpur, India
      KOJ: 'AS_JAPAN', // Kagoshima, Japan
      KTM: 'AS_INDIA', // Kathmandu, Nepal
      KUL: 'HK', // Kuala Lumpur, Malaysia
      KWE: 'HK', // Guiyang, China
      KWI: 'ME', // Kuwait City, Kuwait
      LAD: 'AF', // Luanda, Angola
      LAS: 'NA', // Las Vegas, USA
      LAX: 'NA', // Los Angeles, USA
      LCA: 'EU', // Nicosia, Cyprus
      LED: 'EU', // Saint Petersburg, Russia
      LHE: 'AS_INDIA', // Lahore, Pakistan
      LHR: 'EU', // London, UK
      LHW: 'HK', // Lanzhou, China
      LIM: 'SA', // Lima, Peru
      LIS: 'EU', // Lisbon, Portugal
      LJU: 'EU', // Ljubljana, Slovenia
      LLK: 'AS_INDIA', // Astara, Azerbaijan
      LLW: 'AF', // Lilongwe, Malawi
      LOS: 'AF', // Lagos, Nigeria
      LPB: 'SA', // La Paz, Bolivia
      LUH: 'AS_INDIA', // Ludhiana, India
      LUN: 'AF', // Lusaka, Zambia
      LUX: 'EU', // Luxembourg City, Luxembourg
      LYA: 'HK', // Luoyang, China
      LYS: 'EU', // Lyon, France
      MAA: 'AS_INDIA', // Chennai, India
      MAD: 'EU', // Madrid, Spain
      MAN: 'EU', // Manchester, UK
      MAO: 'SA', // Manaus, Brazil
      MBA: 'AF', // Mombasa, Kenya
      MCI: 'NA', // Kansas City, USA
      MCT: 'ME', // Muscat, Oman
      MDE: 'SA', // Medellín, Colombia
      MEL: 'OC', // Melbourne, Australia
      MEM: 'NA', // Memphis, USA
      MEX: 'NA', // Mexico City, Mexico
      MFM: 'HK', // Macau
      MIA: 'NA', // Miami, USA
      MLA: 'EU', // Santa Venera, Malta
      MLE: 'AS_INDIA', // Male, Maldives
      MLG: 'HK', // Malang, Indonesia
      MNL: 'HK', // Manila, Philippines
      MPM: 'AF', // Maputo, Mozambique
      MRS: 'EU', // Marseille, France
      MRU: 'AF', // Port Louis, Mauritius
      MSP: 'NA', // Minneapolis, USA
      MSQ: 'EU', // Minsk, Belarus
      MUC: 'EU', // Munich, Germany
      MXP: 'EU', // Milan, Italy
      NAG: 'AS_INDIA', // Nagpur, India
      NBO: 'AF', // Nairobi, Kenya
      NGO: 'AS_JAPAN', // Nagoya, Japan
      NJF: 'ME', // Najaf, Iraq
      NNG: 'HK', // Nanning, China
      NOU: 'OC', // Noumea, New Caledonia
      NQN: 'SA', // Neuquen, Argentina
      NQZ: 'AS_INDIA', // Astana, Kazakhstan
      NRT: 'AS_JAPAN', // Tokyo Narita, Japan
      NVT: 'SA', // Timbo (Navegantes), Brazil
      OKA: 'AS_JAPAN', // Naha (Okinawa), Japan
      OKC: 'NA', // Oklahoma City, USA
      OMA: 'NA', // Omaha, USA
      ORD: 'NA', // Chicago, USA
      ORF: 'NA', // Norfolk, USA
      ORN: 'AF', // Oran, Algeria
      OSL: 'EU', // Oslo, Norway
      OTP: 'EU', // Bucharest, Romania
      OUA: 'AF', // Ouagadougou, Burkina Faso
      PAT: 'AS_INDIA', // Patna, India
      PBH: 'AS_INDIA', // Thimphu, Bhutan
      PBM: 'SA', // Paramaribo, Suriname
      PDX: 'NA', // Portland, USA
      PER: 'OC', // Perth, Australia
      PHL: 'NA', // Philadelphia, USA
      PHX: 'NA', // Phoenix, USA
      PIT: 'NA', // Pittsburgh, USA
      PKX: 'HK', // Langfang (Beijing), China
      PMO: 'EU', // Palermo, Italy
      PMW: 'SA', // Palmas, Brazil
      PNH: 'HK', // Phnom Penh, Cambodia
      PNQ: 'AS_INDIA', // Pune, India
      POA: 'SA', // Porto Alegre, Brazil
      POS: 'SA', // Port of Spain, Trinidad
      PPT: 'OC', // Tahiti, French Polynesia
      PRG: 'EU', // Prague, Czech Republic
      PTY: 'SA', // Panama City, Panama
      QRO: 'NA', // Queretaro, Mexico
      QWJ: 'SA', // Americana, Brazil
      RAO: 'SA', // Ribeirao Preto, Brazil
      RDU: 'NA', // Durham (Raleigh), USA
      REC: 'SA', // Recife, Brazil
      RIC: 'NA', // Richmond, USA
      RIX: 'EU', // Riga, Latvia
      RUH: 'ME', // Riyadh, Saudi Arabia
      RUN: 'AF', // Saint-Denis, Réunion
      SAN: 'NA', // San Diego, USA
      SAP: 'SA', // San Pedro Sula, Honduras
      SAT: 'NA', // San Antonio, USA
      SCL: 'SA', // Santiago, Chile
      SDJ: 'AS_JAPAN', // Sendai, Japan
      SDQ: 'NA', // Santo Domingo, Dominican Republic
      SEA: 'NA', // Seattle, USA
      SFO: 'NA', // San Francisco, USA
      SGN: 'HK', // Ho Chi Minh City, Vietnam
      SHA: 'HK', // Shanghai, China
      SIN: 'HK', // Singapore
      SJC: 'NA', // San Jose, USA
      SJK: 'SA', // São José dos Campos, Brazil
      SJO: 'SA', // San José, Costa Rica
      SJP: 'SA', // São José do Rio Preto, Brazil
      SJU: 'NA', // San Juan, Puerto Rico
      SJW: 'HK', // Shijiazhuang, China
      SKG: 'EU', // Thessaloniki, Greece
      SKP: 'EU', // Skopje, North Macedonia
      SLC: 'NA', // Salt Lake City, USA
      SMF: 'NA', // Sacramento, USA
      SOD: 'SA', // Sorocaba, Brazil
      SOF: 'EU', // Sofia, Bulgaria
      SSA: 'SA', // Salvador, Brazil
      STI: 'NA', // Santiago de los Caballeros, Dominican Republic
      STL: 'NA', // St. Louis, USA
      STR: 'EU', // Stuttgart, Germany
      SUV: 'OC', // Suva, Fiji
      SYD: 'OC', // Sydney, Australia
      SZX: 'HK', // Shenzhen, China
      TAO: 'HK', // Qingdao, China
      TBS: 'EU', // Tbilisi, Georgia
      TEN: 'HK', // Tongren, China
      TGU: 'SA', // Tegucigalpa, Honduras
      TIA: 'EU', // Tirana, Albania
      TLH: 'NA', // Tallahassee, USA
      TLL: 'EU', // Tallinn, Estonia
      TLV: 'ME', // Tel Aviv, Israel
      TNA: 'HK', // Zibo (Jinan), China
      TNR: 'AF', // Antananarivo, Madagascar
      TPA: 'NA', // Tampa, USA
      TPE: 'AS_JAPAN', // Taipei, Taiwan (North Asia -> Japan)
      TUN: 'AF', // Tunis, Tunisia
      TXL: 'EU', // Berlin, Germany
      TYN: 'HK', // Yangquan (Taiyuan), China
      UDI: 'SA', // Uberlandia, Brazil
      UDR: 'AS_INDIA', // Udaipur, India
      UIO: 'SA', // Quito, Ecuador
      ULN: 'AS_JAPAN', // Ulaanbaatar, Mongolia (North Asia -> Japan)
      URT: 'HK', // Surat Thani, Thailand
      VCP: 'SA', // Campinas, Brazil
      VIE: 'EU', // Vienna, Austria
      VIX: 'SA', // Vitoria, Brazil
      VNO: 'EU', // Vilnius, Lithuania
      VTE: 'HK', // Vientiane, Laos
      WAW: 'EU', // Warsaw, Poland
      WDH: 'AF', // Windhoek, Namibia
      WLG: 'OC', // Wellington, New Zealand
      WRO: 'EU', // Wroclaw, Poland
      XAP: 'SA', // Chapeco, Brazil
      XFN: 'HK', // Xiangyang, China
      XIY: 'HK', // Baoji (Xi'an), China
      XNH: 'ME', // Nasiriyah, Iraq
      XNN: 'HK', // Xining, China
      YHZ: 'NA', // Halifax, Canada
      YOW: 'NA', // Ottawa, Canada
      YUL: 'NA', // Montréal, Canada
      YVR: 'NA', // Vancouver, Canada
      YWG: 'NA', // Winnipeg, Canada
      YXE: 'NA', // Saskatoon, Canada
      YYC: 'NA', // Calgary, Canada
      YYZ: 'NA', // Toronto, Canada
      ZAG: 'EU', // Zagreb, Croatia
      ZDM: 'ME', // Ramallah, Palestine
      ZRH: 'EU', // Zurich, Switzerland
    }

export function trustedIngressRegion(colo: unknown): ServingRegion | undefined {
  return typeof colo === 'string' ? COLO_REGIONS[colo] : undefined
}
