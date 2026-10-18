using System;
using System.Collections.Generic;
using Muwafaqa.Plugins.Contract;

namespace Muwafaqa.Plugins.Tests
{
    /// <summary>Shared sample values for the guard tests. No Dataverse types.</summary>
    internal static class GuardTestData
    {
        public static readonly int[] Statuses =
        {
            ContractStatus.Draft, ContractStatus.PendingApproval, ContractStatus.InForce, ContractStatus.Rejected
        };

        /// <summary>Editable in Draft, locked in the other statuses.</summary>
        public static readonly string[] LockedAfterSubmission =
        {
            ContractColumns.Value, ContractColumns.Currency, ContractColumns.Direction, ContractColumns.Counterparty
        };

        /// <summary>Written by plug-ins only: a client may not set them on Create or change them on Update (ADR-006 adds the number).</summary>
        public static readonly string[] SystemWritten =
        {
            ContractColumns.Number, ContractColumns.ValueUsdFrozen, ContractColumns.ApprovalRound
        };

        /// <summary>A Create row as a client sends it: the Contract Type is required (ADR-006).</summary>
        public static IDictionary<string, ColumnValue> ValidCreateRow(params Tuple<string, ColumnValue>[] more)
        {
            var d = new Dictionary<string, ColumnValue> { [ContractColumns.Type] = ColumnValue.FromInt(867640000) };
            foreach (var c in more) d[c.Item1] = c.Item2;
            return d;
        }

        public static readonly Guid IdA = new Guid("00000000-0000-0000-0000-00000000000a");
        public static readonly Guid IdB = new Guid("00000000-0000-0000-0000-00000000000b");

        /// <summary>Two different values of the kind the column holds.</summary>
        public static Tuple<ColumnValue, ColumnValue> TwoValues(string logicalName)
        {
            switch (logicalName)
            {
                case ContractColumns.Value:
                case ContractColumns.ValueUsdFrozen:
                    return Tuple.Create(ColumnValue.FromDecimal(1000m), ColumnValue.FromDecimal(2000m));
                case ContractColumns.Currency:
                    return Tuple.Create(
                        ColumnValue.FromReference("transactioncurrency", IdA),
                        ColumnValue.FromReference("transactioncurrency", IdB));
                case ContractColumns.Counterparty:
                    return Tuple.Create(
                        ColumnValue.FromReference("mwf_counterparty", IdA),
                        ColumnValue.FromReference("mwf_counterparty", IdB));
                case ContractColumns.Type:
                case ContractColumns.Direction:
                    return Tuple.Create(ColumnValue.FromInt(867640000), ColumnValue.FromInt(867640001));
                case ContractColumns.ApprovalRound:
                    return Tuple.Create(ColumnValue.FromInt(1), ColumnValue.FromInt(2));
                case ContractColumns.Number:
                case ContractColumns.Subject:
                    return Tuple.Create(ColumnValue.FromText("C-0001"), ColumnValue.FromText("C-0002"));
                default:
                    throw new ArgumentException(logicalName);
            }
        }

        public static IDictionary<string, ColumnValue> Row(params Tuple<string, ColumnValue>[] cols)
        {
            var d = new Dictionary<string, ColumnValue>();
            foreach (var c in cols) d[c.Item1] = c.Item2;
            return d;
        }

        public static Tuple<string, ColumnValue> Col(string name, ColumnValue value)
        {
            return Tuple.Create(name, value);
        }
    }
}
