using System.Collections.Generic;
using System.Linq;

namespace Muwafaqa.Plugins.Contract
{
    /// <summary>One column guarded by the policy.</summary>
    public sealed class GuardedColumn
    {
        public string LogicalName { get; }
        public string DisplayName { get; }
        /// <summary>True: locked in every status (the frozen USD value). False: locked unless the status is Draft.</summary>
        public bool AlwaysLocked { get; }

        public GuardedColumn(string logicalName, string displayName, bool alwaysLocked)
        {
            LogicalName = logicalName; DisplayName = displayName; AlwaysLocked = alwaysLocked;
        }
    }

    /// <summary>
    /// Which columns cannot be changed. Evaluated with the status the row has BEFORE the request (PreImage).
    /// A column is "changed" only if its value in the Target differs from the PreImage value.
    /// A column absent from the Target is not changed. A column absent from the PreImage is null (an image holds non-null values only).
    /// </summary>
    public static class LockedColumnsPolicy
    {
        public static readonly IReadOnlyList<GuardedColumn> Columns = new List<GuardedColumn>
        {
            new GuardedColumn(ContractColumns.Value, "Value", false),
            new GuardedColumn(ContractColumns.Currency, "Currency", false),
            new GuardedColumn(ContractColumns.Type, "Contract Type", false),
            new GuardedColumn(ContractColumns.Direction, "Contract Direction", false),
            new GuardedColumn(ContractColumns.Counterparty, "Counterparty", false),
            new GuardedColumn(ContractColumns.Number, "Contract Number", false),
            new GuardedColumn(ContractColumns.ValueUsdFrozen, "Value (USD, Frozen)", true),
        };

        private const string FrozenText = "Value (USD, Frozen) cannot be changed. It is written by the system when the contract is submitted.";

        public static PolicyResult CheckUpdate(
            int currentStatus,
            IDictionary<string, ColumnValue> target,
            IDictionary<string, ColumnValue> preImage)
        {
            var editable = currentStatus == ContractStatus.Draft;
            var lockedNames = new List<string>();
            var frozenChanged = false;

            foreach (var col in Columns)
            {
                ColumnValue t;
                if (!target.TryGetValue(col.LogicalName, out t)) continue;
                ColumnValue p;
                if (!preImage.TryGetValue(col.LogicalName, out p)) p = ColumnValue.Null;
                if (t.Equals(p)) continue;                       // identical value: no-op

                if (col.AlwaysLocked) frozenChanged = true;
                else if (!editable) lockedNames.Add(col.DisplayName);
            }

            if (lockedNames.Count == 0 && !frozenChanged) return PolicyResult.Allow;

            var parts = new List<string>();
            if (lockedNames.Count > 0)
            {
                var hint = currentStatus == ContractStatus.InForce
                    ? "An In Force contract cannot be edited."
                    : ContractStatus.IsKnown(currentStatus) ? "Return the contract to Draft first." : "The status is not one of the contract statuses.";
                parts.Add("Cannot change " + string.Join(", ", lockedNames) + " while the contract status is "
                    + ContractStatus.NameOf(currentStatus) + ". " + hint);
            }
            if (frozenChanged) parts.Add(FrozenText);
            return PolicyResult.Deny(string.Join(" ", parts));
        }

        /// <summary>On Create only the frozen column is guarded: any non-null value is rejected.</summary>
        public static PolicyResult CheckCreate(IDictionary<string, ColumnValue> target)
        {
            ColumnValue v;
            if (target.TryGetValue(ContractColumns.ValueUsdFrozen, out v) && !v.IsNull)
            {
                return PolicyResult.Deny(FrozenText);
            }
            return PolicyResult.Allow;
        }
    }
}
