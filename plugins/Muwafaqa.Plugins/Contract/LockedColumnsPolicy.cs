using System.Collections.Generic;
using System.Linq;

namespace Muwafaqa.Plugins.Contract
{
    /// <summary>One column guarded by the policy.</summary>
    public sealed class GuardedColumn
    {
        public string LogicalName { get; }
        public string DisplayName { get; }
        /// <summary>
        /// True: locked in every status and written by a plug-in only (the frozen USD value, the approval round).
        /// False: locked unless the status is Draft.
        /// </summary>
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
    /// The always-locked columns are written by plug-in 1 at PreOperation (stage 20); this guard runs at PreValidation (stage 10)
    /// and only sees what the client sent, so it does not block that write.
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
            new GuardedColumn(ContractColumns.ApprovalRound, "Approval Round", true),
        };

        private static string SystemWrittenText(string displayName)
        {
            return displayName + " cannot be changed. It is written by the system when the contract is submitted.";
        }

        public static PolicyResult CheckUpdate(
            int currentStatus,
            IDictionary<string, ColumnValue> target,
            IDictionary<string, ColumnValue> preImage)
        {
            var editable = currentStatus == ContractStatus.Draft;
            var lockedNames = new List<string>();
            var systemWrittenChanged = new List<string>();

            foreach (var col in Columns)
            {
                ColumnValue t;
                if (!target.TryGetValue(col.LogicalName, out t)) continue;
                ColumnValue p;
                if (!preImage.TryGetValue(col.LogicalName, out p)) p = ColumnValue.Null;
                if (t.Equals(p)) continue;                       // identical value: no-op

                if (col.AlwaysLocked) systemWrittenChanged.Add(col.DisplayName);
                else if (!editable) lockedNames.Add(col.DisplayName);
            }

            if (lockedNames.Count == 0 && systemWrittenChanged.Count == 0) return PolicyResult.Allow;

            var parts = new List<string>();
            if (lockedNames.Count > 0)
            {
                var hint = currentStatus == ContractStatus.InForce
                    ? "An In Force contract cannot be edited."
                    : ContractStatus.IsKnown(currentStatus) ? "Return the contract to Draft first." : "The status is not one of the contract statuses.";
                parts.Add("Cannot change " + string.Join(", ", lockedNames) + " while the contract status is "
                    + ContractStatus.NameOf(currentStatus) + ". " + hint);
            }
            parts.AddRange(systemWrittenChanged.Select(SystemWrittenText));
            return PolicyResult.Deny(string.Join(" ", parts));
        }

        /// <summary>On Create only the system-written columns are guarded: any non-null value is rejected.</summary>
        public static PolicyResult CheckCreate(IDictionary<string, ColumnValue> target)
        {
            var offending = new List<string>();
            foreach (var col in Columns.Where(c => c.AlwaysLocked))
            {
                ColumnValue v;
                if (target.TryGetValue(col.LogicalName, out v) && !v.IsNull) offending.Add(col.DisplayName);
            }
            if (offending.Count == 0) return PolicyResult.Allow;
            return PolicyResult.Deny(string.Join(" ", offending.Select(SystemWrittenText)));
        }
    }
}
