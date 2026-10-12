using System;

namespace Muwafaqa.Plugins.Contract
{
    /// <summary>Reasons the USD value cannot be computed. Used by tests and mapped to a user-facing message.</summary>
    public enum UsdValueError
    {
        ValueMissing,
        ValueNegative,
        ContractCurrencyMissing,
        ContractRateInvalid,
        UsdCurrencyMissing,
        UsdCurrencyAmbiguous,
        UsdRateInvalid
    }

    /// <summary>Raised by the pure calculation. The plug-in shell converts it to an InvalidPluginExecutionException.</summary>
    public sealed class UsdValueException : Exception
    {
        public UsdValueError Error { get; }

        public UsdValueException(UsdValueError error, string message) : base(message)
        {
            Error = error;
        }
    }

    /// <summary>A currency and its current exchange rate (units of this currency per 1 base-currency unit).</summary>
    public sealed class CurrencyRate
    {
        public string IsoCode { get; }
        public decimal? Rate { get; }

        public CurrencyRate(string isoCode, decimal? rate)
        {
            IsoCode = isoCode;
            Rate = rate;
        }
    }

    /// <summary>Pure calculation. No Dataverse types, so it can be unit tested without an environment.</summary>
    public static class UsdValueCalculator
    {
        public const int Decimals = 2;

        /// <summary>
        /// USD = value / rate(contract currency) * rate(USD), rounded to 2 decimals, away from zero.
        /// The multiplication is done first to keep the intermediate decimal exact where possible;
        /// the result is mathematically the same as the specified formula.
        /// </summary>
        public static decimal Compute(decimal? value, CurrencyRate contractCurrency, CurrencyRate usdCurrency)
        {
            if (value == null)
            {
                throw new UsdValueException(UsdValueError.ValueMissing,
                    "The contract has no Value, so its USD value cannot be frozen.");
            }
            if (value.Value < 0m)
            {
                throw new UsdValueException(UsdValueError.ValueNegative,
                    "The contract Value is negative, so its USD value cannot be frozen.");
            }
            if (contractCurrency == null)
            {
                throw new UsdValueException(UsdValueError.ContractCurrencyMissing,
                    "The contract has no currency, so its USD value cannot be frozen.");
            }
            if (usdCurrency == null)
            {
                throw new UsdValueException(UsdValueError.UsdCurrencyMissing,
                    "The active USD currency record (ISO code USD) was not found, so the USD value cannot be frozen.");
            }
            if (contractCurrency.Rate == null || contractCurrency.Rate.Value <= 0m)
            {
                throw new UsdValueException(UsdValueError.ContractRateInvalid,
                    "The exchange rate of currency " + contractCurrency.IsoCode + " is missing or not greater than zero.");
            }
            if (usdCurrency.Rate == null || usdCurrency.Rate.Value <= 0m)
            {
                throw new UsdValueException(UsdValueError.UsdRateInvalid,
                    "The exchange rate of currency USD is missing or not greater than zero.");
            }

            var usd = value.Value * usdCurrency.Rate.Value / contractCurrency.Rate.Value;
            return Math.Round(usd, Decimals, MidpointRounding.AwayFromZero);
        }
    }
}
