using Muwafaqa.Plugins.Contract;
using Xunit;

namespace Muwafaqa.Plugins.Tests
{
    public class UsdValueCalculatorTests
    {
        // Placeholder rates used in the project (units of the currency per 1 TRY). Fictional, not market rates.
        private const decimal UsdRate = 0.020408163265m;
        private const decimal KwdRate = 0.006666666667m;
        private const decimal AedRate = 0.076923076923m;

        private static CurrencyRate Usd(decimal? rate = UsdRate) => new CurrencyRate("USD", rate);

        [Fact]
        public void Usd_contract_in_usd_returns_the_same_value()
        {
            var result = UsdValueCalculator.Compute(1000m, Usd(), Usd());
            Assert.Equal(1000.00m, result);
        }

        [Fact]
        public void Base_currency_contract_rate_one_gives_expected_usd()
        {
            // 49000 TRY * 0.020408163265 = 999.999999985, which rounds to 1000.00.
            var result = UsdValueCalculator.Compute(49000m, new CurrencyRate("TRY", 1m), Usd());
            Assert.Equal(1000.00m, result);
        }

        [Fact]
        public void Aed_contract_converts_through_the_base_currency()
        {
            // 367250 * 0.020408163265 / 0.076923076923 = 97433.673...
            var result = UsdValueCalculator.Compute(367250m, new CurrencyRate("AED", AedRate), Usd());
            Assert.Equal(97433.67m, result);
        }

        [Fact]
        public void Kwd_three_decimal_value_is_converted_and_rounded_to_two_decimals()
        {
            // 6500.255 * 0.020408163265 / 0.006666666667 = 19898.739...
            var result = UsdValueCalculator.Compute(6500.255m, new CurrencyRate("KWD", KwdRate), Usd());
            Assert.Equal(19898.74m, result);
        }

        [Theory]
        [InlineData("1.005", "1.01")]
        [InlineData("1.004", "1.00")]
        [InlineData("2.675", "2.68")]
        [InlineData("0.005", "0.01")]
        [InlineData("0.004", "0.00")]
        public void Rounding_is_half_away_from_zero_at_two_decimals(string value, string expected)
        {
            var one = new CurrencyRate("XXX", 1m);
            var result = UsdValueCalculator.Compute(decimal.Parse(value, System.Globalization.CultureInfo.InvariantCulture), one, new CurrencyRate("USD", 1m));
            Assert.Equal(decimal.Parse(expected, System.Globalization.CultureInfo.InvariantCulture), result);
        }

        [Fact]
        public void Zero_value_returns_zero()
        {
            var result = UsdValueCalculator.Compute(0m, new CurrencyRate("KWD", KwdRate), Usd());
            Assert.Equal(0.00m, result);
        }

        [Fact]
        public void Missing_usd_currency_throws()
        {
            var ex = Assert.Throws<UsdValueException>(() => UsdValueCalculator.Compute(1000m, Usd(), null));
            Assert.Equal(UsdValueError.UsdCurrencyMissing, ex.Error);
        }

        [Theory]
        [InlineData("0")]
        [InlineData("-0.5")]
        public void Contract_rate_zero_or_negative_throws(string rate)
        {
            var bad = new CurrencyRate("KWD", decimal.Parse(rate, System.Globalization.CultureInfo.InvariantCulture));
            var ex = Assert.Throws<UsdValueException>(() => UsdValueCalculator.Compute(1000m, bad, Usd()));
            Assert.Equal(UsdValueError.ContractRateInvalid, ex.Error);
        }

        [Fact]
        public void Contract_rate_null_throws()
        {
            var ex = Assert.Throws<UsdValueException>(() => UsdValueCalculator.Compute(1000m, new CurrencyRate("KWD", null), Usd()));
            Assert.Equal(UsdValueError.ContractRateInvalid, ex.Error);
        }

        [Theory]
        [InlineData("0")]
        [InlineData("-1")]
        public void Usd_rate_zero_or_negative_throws(string rate)
        {
            var bad = new CurrencyRate("USD", decimal.Parse(rate, System.Globalization.CultureInfo.InvariantCulture));
            var ex = Assert.Throws<UsdValueException>(() => UsdValueCalculator.Compute(1000m, Usd(), bad));
            Assert.Equal(UsdValueError.UsdRateInvalid, ex.Error);
        }

        [Fact]
        public void Usd_rate_null_throws()
        {
            var ex = Assert.Throws<UsdValueException>(() => UsdValueCalculator.Compute(1000m, Usd(), new CurrencyRate("USD", null)));
            Assert.Equal(UsdValueError.UsdRateInvalid, ex.Error);
        }

        [Fact]
        public void Null_value_throws()
        {
            var ex = Assert.Throws<UsdValueException>(() => UsdValueCalculator.Compute(null, Usd(), Usd()));
            Assert.Equal(UsdValueError.ValueMissing, ex.Error);
        }

        [Fact]
        public void Negative_value_throws()
        {
            var ex = Assert.Throws<UsdValueException>(() => UsdValueCalculator.Compute(-1m, Usd(), Usd()));
            Assert.Equal(UsdValueError.ValueNegative, ex.Error);
        }

        [Fact]
        public void Null_currency_throws()
        {
            var ex = Assert.Throws<UsdValueException>(() => UsdValueCalculator.Compute(1000m, null, Usd()));
            Assert.Equal(UsdValueError.ContractCurrencyMissing, ex.Error);
        }
    }
}
