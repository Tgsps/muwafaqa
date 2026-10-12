namespace Muwafaqa.Plugins.Contract
{
    /// <summary>Logical names of mwf_contract columns used by the plug-ins (read from the solution source, src/Entities/mwf_Contract/Entity.xml).</summary>
    internal static class ContractColumns
    {
        public const string EntityName = "mwf_contract";

        public const string Subject = "mwf_name";                    // Contract Subject, String
        public const string Number = "mwf_contractnumber";           // Contract Number, String
        public const string Type = "mwf_contracttype";               // Contract Type, OptionSet
        public const string Direction = "mwf_direction";             // Contract Direction, OptionSet
        public const string Counterparty = "mwf_counterpartyid";     // Counterparty, Lookup (mwf_counterparty)
        public const string Value = "mwf_value";                     // Value, Money
        public const string Currency = "transactioncurrencyid";      // Currency, Lookup (transactioncurrency)
        public const string ValueUsdFrozen = "mwf_valueusdfrozen";   // Value (USD, Frozen), Decimal
        public const string StatusCode = "statuscode";               // Status Reason
        public const string StateCode = "statecode";                 // Status

        public const string PreImageName = "pre";
    }
}
