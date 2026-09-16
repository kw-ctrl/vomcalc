/**
 * The member library: resource links and the partner / affiliate directory.
 *
 * RULE: every entry here is a real destination. Drive ids were read off Kassidy's actual
 * Drive (ESCAPE VELOCITY/RESOURCES and EV Community Resources), the vendor details come from
 * his own "Preferred Vendors" sheet, and the affiliate entries carry the exact terms that are
 * written down. Nothing is padded with placeholders or invented codes.
 *
 * Served only through /api/members/resources, behind the member cookie.
 */

const drive = (id) => `https://drive.google.com/file/d/${id}/view`;
const folder = (id) => `https://drive.google.com/drive/folders/${id}`;

export const resources = [
  {
    group: 'Start here',
    note: 'The five foundations, plus the solo episode on consistency.',
    items: [
      { title: '1 — 5 Daily Non Negotiables', kind: 'video', url: drive('125kNo2yPmQGFcBZ-6gAyPSTvhC8UAE1Y') },
      { title: '2 — How to Buy Property', kind: 'video', url: drive('1PRgxWi07tp6EOet3TWH3vkU4WisTRJ-M') },
      { title: '3 — Goal Reward Matrix', kind: 'video', url: drive('1RhQpyf784CR4p9vo4VY1ZmeoUcXdtTZH') },
      { title: '4 — Velocity of Money', kind: 'video', url: drive('1zz-WtYcyNZR2OH0eZvzQHnswRSMj06G1') },
      { title: 'Consistency — Solo EV Community Episode', kind: 'video', url: drive('1D4VRCMcl5siGlIcfYjsN_go3ed94AIuy') },
      { title: 'The whole Start Here folder', kind: 'folder', url: folder('1Q52aRjUjgYC4G10DevDm5HbUAZ-gfJUr') },
    ],
  },
  {
    group: 'Tools and calculators',
    note: 'Underwrite every deal in the VOM calculator — that is the worksheet for the courses.',
    items: [
      { title: 'VOM Underwriting Calculator', kind: 'tool', url: 'https://www.vomcalc.com/app', note: 'Velocity Score, buy box, return attribution, improvement levers.' },
      { title: 'ADU underwriting tool', kind: 'tool', url: 'https://www.vomcalc.com/adu.html' },
      { title: 'Airbnb Property Evaluator (sheet)', kind: 'file', url: drive('1icEo42vbLtEsuEqoVmU8iepnpuFgLBn0') },
      { title: 'Calculators folder', kind: 'folder', url: folder('1a4wcruJas-dtdjqAP0i8rx1DtEBmCk-n') },
      { title: 'DealOS', kind: 'tool', url: 'https://deaos.vercel.app', note: 'Deal pipeline and sourcing workspace.' },
    ],
  },
  {
    group: 'Call library',
    note: 'Every recorded call and transcript. The courses link straight into these at the right minute.',
    items: [
      { title: 'EV weekly call recordings', kind: 'folder', url: folder('1SoOp1hymGlxLGjJ8mtu4_Hi0SQ8Qpj9n') },
      { title: 'Office Hours recordings', kind: 'folder', url: folder('1Ouoi0S21YJWsdu9MCoo8NgKR3XLtpYdZ') },
      { title: 'All recorded calls', kind: 'folder', url: folder('1TigpZZD1oaYsuVFnY6kwvSEYYEJwLDMc') },
      { title: 'Call transcripts (all)', kind: 'folder', url: folder('1mnKHhVV1j4EHIjzaSJ3umsfjTQJnOqvo') },
      { title: 'Call transcripts', kind: 'folder', url: folder('1x75t1C1qwCb0PtgEUm_LBRfTo5Yt6CP1') },
      { title: 'EV Community Calls — 40 Week Curriculum', kind: 'doc', url: drive('1nI2fvPpuB46FtfYUNJOq3R2WDRkpcPirq6Hy_0O3ySA') },
      { title: 'EV Wins', kind: 'folder', url: folder('14wijU3W2fWuu26p7D4nVEvUCKZu9gx1E') },
      { title: 'EV Community Wins', kind: 'folder', url: folder('1a8smxQBkTKcEsIeBdmYYpi9O4c0ECIAK') },
    ],
  },
  {
    group: 'Deal documents and templates',
    note: 'What to send, what to ask, what to sign.',
    items: [
      { title: 'Top 10 Questions to Ask a Realtor', kind: 'doc', url: drive('1pxkSzh9fk0XZNScY8wzm0E61eC9xfleCq5GT0Jj0PL8') },
      { title: 'Preferred Vendors (CPA, lenders, designers, PMs)', kind: 'file', url: drive('1OYJVAIRb7yfCX8Iqx0cd1Wdc4wOatbtpjrM8NlweBsc') },
      { title: 'Non-Recourse Lenders (Mar 2025)', kind: 'file', url: drive('1HhV_twhGue1_OGlaw-JQq6oxnAwBvYdV') },
      { title: 'Investor Commitment LOI', kind: 'file', url: drive('1NhAPBaYfN2RvEcbqnelkSGGmdMBMEn41') },
      { title: 'LOI example', kind: 'file', url: drive('1PNyORJZn-V_hGO3a5SdotSMez5_rLexo') },
      { title: 'LOI example — Kassidy, Orcas Island', kind: 'file', url: drive('1WIDSQEfg0Kpo5p_pbmBEEdEPBDAASB-z') },
      { title: 'Brian Pate — provided resources', kind: 'folder', url: folder('19069iVSBJLFWNuVMlPcMUpmfypXrHqLz') },
      { title: 'Guest WiFi email capture — free vs paid', kind: 'file', url: drive('1LOfGq-QWBVefi4qSLAIH_4P9D-LiNpTS21G37mL6yJw') },
      { title: 'Vendors, lenders & templates folder', kind: 'folder', url: folder('16HEqApfgf0xPp6YHLMeJtyen7lajV_jV') },
    ],
  },
  {
    group: 'Tax and legal',
    note: 'The paperwork behind the tax course.',
    items: [
      { title: '1031 exchange guide (PDF)', kind: 'file', url: drive('1vkWQxKesDD-p_wajeaQ7ItiDGT06IhQZ') },
      { title: 'EV Community Resources folder', kind: 'folder', url: folder('1EbLEEnX_qQx3Q5reTA-48uPV2vMBcnKN') },
      { title: 'Escape Velocity Offer v4', kind: 'doc', url: drive('1qnsis03K7AQ7ZKOqqYiasFLZqIU3LQZtwb453thQnA') },
      { title: 'ESCAPE VELOCITY — full resources folder', kind: 'folder', url: folder('1sdqzJSfFMllcwR8P7sWLZg1zUqtkKyp4') },
    ],
  },
];

/**
 * The vendor directory — mirrored from Kassidy's "Preferred Vendors" sheet. These are
 * businesses the community already works with; several give EV members a referral credit.
 */
export const partners = [
  { category: 'CPA', name: 'The CPA Dude (Tony)', location: 'Nationwide', email: 'tony@thecpadude.com', note: 'STR-focused CPA.' },
  { category: 'CPA', name: 'Tavola Group', location: 'Nationwide' },
  { category: 'CPA', name: 'Karlton Dennis', location: 'Nationwide', note: 'STR loophole, forecasting, planning, trusts.' },
  { category: 'Insurance', name: 'Amanda Smith — Cell Brokerage', location: 'Nationwide', email: 'amanda.smith@cellbrokerage.com', note: 'STR-specific property insurance and umbrellas.' },
  { category: 'DSCR lender', name: 'Kevin', location: 'Nationwide', phone: '310-689-8172', email: 'kevin@investorpropertyloan.com' },
  { category: 'DSCR lender', name: 'Kenny Simpson', location: 'Nationwide', phone: '619-302-2020', email: 'kenny@simpson-team.com' },
  { category: 'DSCR lender', name: 'Alex Bekesa', location: 'Nationwide', phone: '(818) 606-8823' },
  { category: 'DSCR lender', name: 'Jonathan Yoo', location: 'Nationwide', phone: '(213) 507-9050' },
  { category: 'Interior design', name: 'Somerled Designs — Maggie Mruk', location: 'Nationwide', email: 'maggie@somerleddesigns.com', url: 'https://www.somerleddesigns.com', note: '$500 virtual design / $1,000 design+PM referral credit per paid contract, paid monthly on paid-in-full. Register the referral under Escape Velocity first.' },
  { category: 'Interior design', name: 'Funkit Interiors', location: 'Texas+' },
  { category: 'Interior design', name: 'Reclamation Studio', location: 'Texas+' },
  { category: 'Interior design', name: 'Sarah Glidewell', location: 'Michigan' },
  { category: 'Interior design', name: 'Ishita Interiors', location: 'South+' },
  { category: 'STR management', name: 'Federico Zimerman — Blackbird Hospitality', location: 'Nationwide', url: 'https://blackbirdhm.com/', note: 'Also does revenue management.' },
  { category: 'STR management', name: 'Billy — Elevate Homes', location: 'San Diego', phone: '949-682-6833' },
  { category: 'Legal', name: 'Mick Harris — Tonkon Torp', location: 'Real estate attorney', phone: '(503) 802-5765 direct · (503) 889-6636 cell', email: 'mick.harris@tonkon.com' },
  { category: 'Legal', name: 'Bethany LaFlam', location: 'SEC lawyer' },
  { category: 'Branding', name: 'Weber Co' },
  { category: 'Branding', name: 'Caro Design Studios' },
  { category: 'Social', name: 'Nate Vietz — Content House' },
  { category: 'Social', name: 'Ben Wolff — Oasi' },
];

/**
 * Affiliate / partner programs. `status` is honest about where each one actually is —
 * "live" only where the referral route is written down and reachable today.
 */
export const affiliatePrograms = [
  {
    name: 'Somerled Designs',
    what: 'Interior design and project management for short-term rentals.',
    terms: '$500 referral credit for a virtual design, $1,000 for design + project management, per paid contract. Paid monthly on paid-in-full. Register the referral under Escape Velocity — first partner to refer gets the credit.',
    url: 'https://form.jotform.com/252193985491065?howDid=Referral&typeA19=Escape%20Velocity',
    status: 'live',
  },
  {
    name: 'PriceLabs',
    what: 'Dynamic pricing / revenue management.',
    terms: 'Ambassador program pays 10% commission plus partner benefits. EV is signed up as an affiliate partner.',
    url: 'https://hello.pricelabs.co/ambassadors/',
    status: 'program — EV referral link to be attached here',
  },
  {
    name: 'Hospitable',
    what: 'STR PMS, messaging automation and the direct-booking site.',
    terms: 'Hosts get a referral credit through Hospitable’s referral program.',
    url: 'https://hospitable.com',
    status: 'program — EV referral link to be attached here',
  },
  {
    name: 'Turno',
    what: 'Cleaning and turnover scheduling for STRs.',
    terms: 'Payouts are routed to the Oxbow account.',
    url: 'https://turno.com',
    status: 'program — EV referral link to be attached here',
  },
  {
    name: 'Relay',
    what: 'Business banking — one account per LLC.',
    terms: 'Partner payouts are routed to the RelayFi Oxbow account.',
    url: 'https://relayfi.com',
    status: 'program — EV referral link to be attached here',
  },
];
