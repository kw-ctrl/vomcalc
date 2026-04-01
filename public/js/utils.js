/**
 * Utility functions — mortgage math, tax calc, formatters
 */

import { TAX_BRACKETS } from './constants.js';

export function calculateMortgage(principal, rate, years = 30) {
    const monthlyRate = rate / 100 / 12;
    const numPayments = years * 12;
    if (monthlyRate === 0) return principal / numPayments;
    return principal * (monthlyRate * Math.pow(1 + monthlyRate, numPayments)) /
           (Math.pow(1 + monthlyRate, numPayments) - 1);
}

export function calculateRemainingBalance(loanAmount, interestRate, monthlyMortgage, years) {
    const monthlyRate = interestRate / 100 / 12;
    const paidPayments = years * 12;
    if (monthlyRate <= 0) return Math.max(0, loanAmount - monthlyMortgage * paidPayments);
    const fv = loanAmount * Math.pow(1 + monthlyRate, paidPayments) -
        monthlyMortgage * (Math.pow(1 + monthlyRate, paidPayments) - 1) / monthlyRate;
    return Math.max(0, fv);
}

export function calculateFederalTax(income, filingStatus) {
    const brackets = TAX_BRACKETS[filingStatus] || TAX_BRACKETS.married;
    let tax = 0;
    let remaining = income;
    let previousLimit = 0;
    for (const bracket of brackets) {
        if (remaining <= 0) break;
        const taxableAtBracket = Math.min(remaining, bracket.limit - previousLimit);
        tax += taxableAtBracket * bracket.rate;
        remaining -= taxableAtBracket;
        previousLimit = bracket.limit;
    }
    return tax;
}

export function formatCurrency(amount) {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0
    }).format(amount);
}

export function formatPercent(value) {
    if (!isFinite(value) || isNaN(value)) return 'N/A';
    return value.toFixed(1) + '%';
}
