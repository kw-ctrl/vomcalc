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
 * The vendor directory — CPAs, cost segregation, designers, lenders, insurance, management,
 * legal, branding. Mirrored from Kassidy's own "Preferred Vendors" sheet, plus the firms his
 * Gmail shows he actually spoke to (Tarantino CPA), plus national cost-seg firms verified live
 * on the open web. `benefit` carries a member credit ONLY where one is actually written down.
 *
 * Nothing here is invented: a vendor with no verified public site has no `url` (better an
 * absent link than a wrong one — Tavola Group's old link resolved to an unrelated Canadian
 * consultancy, so it was dropped).
 */
export const partnerGroups = [
  {
    group: 'CPAs & tax strategists',
    note: 'Who to call before you close, not after. Cost segregation, bonus depreciation, entity structure.',
    items: [
      { name: 'Karlton Dennis — Tax Alchemy', what: 'Tax strategist; the STR loophole, forecasting, planning, trusts.', location: 'Nationwide', url: 'https://karltondennis.com/', consult: 'https://www.taxalchemy.com/consultation-survey', note: 'Author of “The Short-Term Rental Rule”.' },
      { name: 'The CPA Dude (Tony)', what: 'Tax savings system for real estate investors: entity setup, bookkeeping, planning, and discounted cost segregation studies.', location: 'Nationwide (all 50 states)', email: 'tony@thecpadude.com', url: 'https://thecpadude.com/' },
      { name: 'Tarantino CPA LLC — Charles “CJ” Tarantino, CPA, MST', what: 'Boutique firm for real estate investors (STR, LTR, multifamily, syndications): multi-entity structure, multi-state planning, cost segregation, bonus depreciation, asset protection.', location: 'Roswell, GA — serving nationally', url: 'https://tarantino-cpa.com', note: 'Kassidy has been in their intake/discovery process since 2026. CJ teaches this material on podcasts — worth a guest slot.' },
      { name: 'Tavola Group', what: 'CPA firm on the EV vendor list.', location: 'Nationwide', note: 'No verified public website — ask Seven for the introduction.' },
      { name: 'AZ Does Taxes', what: 'Kassidy’s own tax preparer for the Arizona filings.', location: 'Arizona / remote', url: 'https://azdoestaxes.com/', email: 'az@azdoestaxes.com' },
    ],
  },
  {
    group: 'Cost segregation',
    note: 'A study has to be done in the first year the property is in service — these are the national firms. EV has no referral arrangement with any of them yet; your CPA can also commission the study.',
    items: [
      { name: 'KBKG', what: 'Tax consulting firm specialising in cost segregation, R&D credits, repair-vs-capitalisation reviews, §45L and §179D. Works with owners and their CPAs.', location: 'National', url: 'https://www.kbkg.com/', note: 'Claims $11B+ in tax benefits claimed.' },
      { name: 'Madison SPECS', what: 'National cost segregation firm; engineers and CPAs nationwide. One of the oldest in the category.', location: 'HQ New Jersey — national', url: 'https://madisonspecs.com/', contact: 'info@madisonspecs.com · (888) 773-2773', note: 'Filed 5,232 studies in 2025.' },
      { name: 'Engineered Tax Services', what: 'Licensed engineering firm; cost segregation, §179D energy deductions, R&D credits, incentive reports.', location: 'National', url: 'https://www.engineeredtaxservices.com/', note: '25+ years; the largest specialty tax consulting firm in the US.' },
    ],
  },
  {
    group: 'Interior design — STR specialists',
    note: 'Designers who price against rental revenue, not taste.',
    items: [
      { name: 'Somerled Designs — Maggie Mruk', what: 'Strategy-led STR interior design and project management.', url: 'https://www.somerleddesigns.com', email: 'maggie@somerleddesigns.com', benefit: '$500 referral credit for a virtual design, $1,000 for design + project management, per paid contract. Register referrals under Escape Velocity first — first partner to refer gets the credit.' },
      { name: 'Funkit Interiors', what: 'STR design studio (co-founder Rob Abasolo of Robuilt).', url: 'https://www.funkitinteriors.com/', benefit: '$500 off your design project for the client.', contact: 'bridgette@funkitinteriors.com' },
      { name: 'Sarah Glidewell — Studio Host', what: 'Interior design plus a four-day on-site launch experience.', location: 'Michigan', url: 'https://www.studiohost.co/', note: 'Sarah has also taught raising money for STRs on an EV call.' },
      { name: 'Reclamation Studio', what: 'STR interior design.', location: 'Texas +', note: 'No verified public website — ask Seven.' },
      { name: 'Ishita Interiors', what: 'STR interior design.', location: 'South +', note: 'No verified public website — ask Seven.' },
    ],
  },
  {
    group: 'Lenders — DSCR & residential',
    note: 'For properties that don’t qualify on your W-2. Get more than one quote.',
    items: [
      { name: 'Kevin — Investor Property Loan', what: 'DSCR lender.', phone: '310-689-8172', email: 'kevin@investorpropertyloan.com' },
      { name: 'Kenny Simpson', what: 'DSCR lender, residential.', phone: '619-302-2020', email: 'kenny@simpson-team.com' },
      { name: 'Alex Bekesa', what: 'DSCR lender, residential.', phone: '(818) 606-8823' },
      { name: 'Jonathan Yoo', what: 'DSCR lender, residential.', phone: '(213) 507-9050' },
    ],
  },
  {
    group: 'Insurance',
    note: 'Insurance first, LLC second — that is the order Kassidy teaches.',
    items: [
      { name: 'Amanda Smith — Cell Brokerage', what: 'Insurance broker; STR-specific property coverage and umbrella policies.', location: 'Nationwide', email: 'amanda.smith@cellbrokerage.com', url: 'https://www.cellbrokerage.com/' },
    ],
  },
  {
    group: 'STR management & revenue',
    note: 'For when you stop self-managing — or want a second pair of eyes on your pricing.',
    items: [
      { name: 'Federico Zimerman — Blackbird Hospitality', what: 'STR management and revenue management.', location: 'Nationwide', url: 'https://blackbirdhm.com/' },
      { name: 'Billy — Elevate Homes', what: 'STR management.', location: 'San Diego', phone: '949-682-6833' },
    ],
  },
  {
    group: 'Legal & entity',
    items: [
      { name: 'Mick Harris — Tonkon Torp', what: 'Real estate attorney.', phone: '(503) 802-5765 · (503) 889-6636', email: 'mick.harris@tonkon.com' },
      { name: 'Bethany LaFlam', what: 'SEC lawyer — for raising money from investors.', location: 'Nationwide' },
    ],
  },
  {
    group: 'Branding, content & social',
    items: [
      { name: 'Weber Co', what: 'Branding.' },
      { name: 'Caro Design Studios', what: 'Branding.' },
      { name: 'Nate Vietz — Content House', what: 'Social media.' },
      { name: 'Ben Wolff — Oasi', what: 'Social media.' },
    ],
  },
];

/**
 * Affiliate / partner programs. Terms below are the published terms (verified September 2026,
 * each link goes to the program page that states them). `status` says exactly where each one is:
 *   live    — the EV referral route exists and works today
 *   open    — a public program you can join and get your own tracked link
 *   gated   — a partner programme with qualifying requirements
 */
export const affiliatePrograms = [
  {
    name: 'Somerled Designs',
    what: 'Interior design and project management for short-term rentals.',
    terms: '$500 referral credit for a virtual design, $1,000 for design + project management, per paid contract. Paid monthly on paid-in-full. Register the referral under Escape Velocity — first partner to refer gets the credit.',
    url: 'https://form.jotform.com/252193985491065?howDid=Referral&typeA19=Escape%20Velocity',
    status: 'live',
    action: 'Register the referral',
  },
  {
    name: 'Hospitable',
    what: 'STR PMS — messaging automation, and the direct-booking site.',
    terms: '$200 flat per qualified referral, no cap, no payout minimum; free-plan referrals count. The referred host gets 25% off for 3 months. Their older page still advertises 25% of the first 3 months — worth confirming which applies.',
    url: 'https://affiliates.hospitable.com/',
    status: 'open',
    action: 'Join the programme',
  },
  {
    name: 'Turno',
    what: 'Cleaning and turnover scheduling.',
    terms: '$150 one-time after the referred host completes 2 marketplace turnovers — or 20% of their subscription fee monthly for up to a year. 90-day cookie, PayPal within 3 business days.',
    url: 'https://affiliates.turno.com/',
    status: 'open',
    action: 'Join the programme',
  },
  {
    name: 'PriceLabs',
    what: 'Dynamic pricing and revenue management.',
    terms: '10% commission on the first 12 invoices of each referral (Dynamic Pricing, not Market Dashboard). Commissions are paid as PriceLabs credit and cashed out only above a $50 balance. New customers only. Their ambassador terms also allow paid content under a Statement of Work.',
    url: 'https://hello.pricelabs.co/ambassadors/',
    status: 'open',
    action: 'Apply as ambassador',
  },
  {
    name: 'Funkit Interiors',
    what: 'STR design studio.',
    terms: '$500 flat per referred project, paid once the client books, signs and completes. The client gets $500 off. Co-founded by Rob Abasolo (Robuilt).',
    url: 'https://hi.funkitinteriors.com/registration',
    status: 'open',
    action: 'Get your referral link',
  },
  {
    name: 'Lodgify',
    what: 'Channel manager and PMS.',
    terms: 'Up to 30% recurring commission for up to 12 months (20% / 25% / 30% by volume tier). Subscription must stay active 40 days; $200 minimum payout; paid ads are not allowed.',
    url: 'https://www.lodgify.com/affiliates',
    status: 'open',
    action: 'Join the programme',
  },
  {
    name: 'Relay',
    what: 'Business banking — one account per LLC.',
    terms: '$50–$300 per client onboarded, plus revenue share for 12 months on their revenue. Partner payouts are routed to the Relay account, and the agreement carries an exclusivity clause on similar finance partners.',
    url: 'https://relayfi.com/advisor-partner-program/',
    status: 'gated',
    action: 'Partner programme details',
  },
  {
    name: 'AirROI',
    what: 'STR market data — the data source behind the VOM calculator.',
    terms: 'No commission programme. Their Preferred Partner tier is API credits (up to 50% off), priority support and co-marketing, for partners who link back to them.',
    url: 'https://www.airroi.com/api/pricing',
    status: 'gated',
    action: 'Partner details',
  },
];
