using System;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace Muwafaqa.Plugins.Contract
{
    /// <summary>Reads the CURRENT exchange rates from the transactioncurrency table.</summary>
    internal static class CurrencyRateReader
    {
        private const string Table = "transactioncurrency";
        private const string RateColumn = "exchangerate";
        private const string IsoColumn = "isocurrencycode";
        private const string StateColumn = "statecode";

        public static CurrencyRate ReadById(IOrganizationService service, Guid currencyId)
        {
            var row = service.Retrieve(Table, currencyId, new ColumnSet(RateColumn, IsoColumn));
            return new CurrencyRate(
                row.GetAttributeValue<string>(IsoColumn),
                row.GetAttributeValue<decimal?>(RateColumn));
        }

        /// <summary>Returns the single active USD record, or null if there is none. Throws if there is more than one.</summary>
        public static CurrencyRate ReadActiveUsd(IOrganizationService service)
        {
            var query = new QueryExpression(Table)
            {
                ColumnSet = new ColumnSet(RateColumn, IsoColumn),
                TopCount = 2
            };
            query.Criteria.AddCondition(IsoColumn, ConditionOperator.Equal, "USD");
            query.Criteria.AddCondition(StateColumn, ConditionOperator.Equal, 0);

            var rows = service.RetrieveMultiple(query).Entities;
            if (rows.Count == 0)
            {
                return null;
            }
            if (rows.Count > 1)
            {
                throw new UsdValueException(UsdValueError.UsdCurrencyAmbiguous,
                    "More than one active currency record with ISO code USD exists, so the USD rate is ambiguous.");
            }
            return new CurrencyRate(
                rows[0].GetAttributeValue<string>(IsoColumn),
                rows[0].GetAttributeValue<decimal?>(RateColumn));
        }
    }
}
