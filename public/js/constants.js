/**
 * Constants — tax brackets, smart defaults, scoring thresholds
 */

export const BONUS_DEPRECIATION_PERCENT = 0.50;  // 50% of structure value can be bonus depreciated
export const RENO_BONUS_DEPRECIATION_PERCENT = 1.00;  // 100% of renovation budget can be bonus depreciated
export const TAX_RATE_FLAT = 0.30;  // Flat 30% tax rate for depreciation benefit calculation
export const LAND_VALUE_PERCENT = 0.20;  // 20% of purchase price assumed to be land

export const TAX_BRACKETS = {
    married: [
        { limit: 22000, rate: 0.10 },
        { limit: 89450, rate: 0.12 },
        { limit: 190750, rate: 0.22 },
        { limit: 364200, rate: 0.24 },
        { limit: 462500, rate: 0.32 },
        { limit: 693750, rate: 0.35 },
        { limit: Infinity, rate: 0.37 }
    ],
    single: [
        { limit: 11000, rate: 0.10 },
        { limit: 44725, rate: 0.12 },
        { limit: 95375, rate: 0.22 },
        { limit: 182100, rate: 0.24 },
        { limit: 231250, rate: 0.32 },
        { limit: 578125, rate: 0.35 },
        { limit: Infinity, rate: 0.37 }
    ],
    head: [
        { limit: 15700, rate: 0.10 },
        { limit: 59850, rate: 0.12 },
        { limit: 95350, rate: 0.22 },
        { limit: 182100, rate: 0.24 },
        { limit: 231250, rate: 0.32 },
        { limit: 578100, rate: 0.35 },
        { limit: Infinity, rate: 0.37 }
    ]
};

export const SMART_DEFAULTS = {
    hotel: {
        interestRate: 12,
        holdPeriod: 7,
        numKeys: 10,
        occupancyRate: 65,
        downPayment: 30,
        annualAppreciation: 3,
        revenueGrowth: 2,
        closingCosts: 3,
        marketCapRate: 8,
        exitCapRate: 9,
        monthlyOpex: 0,
        adrPlaceholder: '125',
        opexPlaceholder: 'Enter monthly expenses',
    },
    str: {
        interestRate: 7.5,
        holdPeriod: 5,
        numKeys: 1,
        occupancyRate: 65,
        downPayment: 20,
        annualAppreciation: 3,
        revenueGrowth: 2,
        closingCosts: 1.5,
        marketCapRate: 8,
        exitCapRate: 9,
        monthlyOpex: 0,
        adrPlaceholder: '250',
        opexPlaceholder: 'Enter monthly expenses',
    }
};
