using Muwafaqa.Plugins.Contract;
using Xunit;

namespace Muwafaqa.Plugins.Tests
{
    public class ColumnValueTests
    {
        [Fact]
        public void Decimals_compare_by_value_not_by_scale()
        {
            Assert.Equal(ColumnValue.FromDecimal(1000m), ColumnValue.FromDecimal(1000.00m));
            Assert.NotEqual(ColumnValue.FromDecimal(1000m), ColumnValue.FromDecimal(1000.01m));
        }

        [Fact]
        public void References_compare_by_id_and_logical_name()
        {
            var a = ColumnValue.FromReference("mwf_counterparty", GuardTestData.IdA);
            Assert.Equal(a, ColumnValue.FromReference("MWF_COUNTERPARTY", GuardTestData.IdA));
            Assert.NotEqual(a, ColumnValue.FromReference("mwf_counterparty", GuardTestData.IdB));
            Assert.NotEqual(a, ColumnValue.FromReference("account", GuardTestData.IdA));
        }

        [Fact]
        public void Option_values_compare_by_value()
        {
            Assert.Equal(ColumnValue.FromInt(867640000), ColumnValue.FromInt(867640000));
            Assert.NotEqual(ColumnValue.FromInt(867640000), ColumnValue.FromInt(867640001));
        }

        [Fact]
        public void Strings_compare_ordinally()
        {
            Assert.Equal(ColumnValue.FromText("abc"), ColumnValue.FromText("abc"));
            Assert.NotEqual(ColumnValue.FromText("abc"), ColumnValue.FromText("ABC"));
        }

        [Fact]
        public void Empty_string_and_null_are_different_strict_by_decision()
        {
            // Documents the decision (ADR-004): "" is NOT the same as null. To be checked on the server later.
            Assert.NotEqual(ColumnValue.FromText(string.Empty), ColumnValue.Null);
            Assert.Equal(ColumnValue.FromText(null), ColumnValue.Null);
        }

        [Fact]
        public void Null_equals_null_and_nothing_else()
        {
            Assert.Equal(ColumnValue.Null, ColumnValue.Null);
            Assert.NotEqual(ColumnValue.Null, ColumnValue.FromDecimal(0m));
            Assert.NotEqual(ColumnValue.Null, ColumnValue.FromInt(0));
        }

        [Fact]
        public void Different_kinds_are_never_equal()
        {
            Assert.NotEqual(ColumnValue.FromDecimal(1m), ColumnValue.FromInt(1));
            Assert.NotEqual(ColumnValue.FromText("1"), ColumnValue.FromInt(1));
        }
    }
}
