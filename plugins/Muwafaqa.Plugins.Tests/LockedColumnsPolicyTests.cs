using System;
using System.Collections.Generic;
using Muwafaqa.Plugins.Contract;
using Xunit;
using static Muwafaqa.Plugins.Tests.GuardTestData;

namespace Muwafaqa.Plugins.Tests
{
    public class LockedColumnsPolicyTests
    {
        private static readonly string[] Kinds = { "unchanged", "changed", "null-to-value", "value-to-null" };

        // 6 locked-after-submission columns + the 2 system-written columns (frozen USD value, approval round),
        // x 4 statuses, x 4 kinds of write = 128 cells
        public static IEnumerable<object[]> Cells()
        {
            var columns = new List<string>(LockedAfterSubmission) { ContractColumns.ValueUsdFrozen, ContractColumns.ApprovalRound };
            foreach (var col in columns)
            {
                foreach (var status in Statuses)
                {
                    foreach (var kind in Kinds)
                    {
                        var frozen = col == ContractColumns.ValueUsdFrozen || col == ContractColumns.ApprovalRound;
                        var expected = kind == "unchanged" || (!frozen && status == ContractStatus.Draft);
                        yield return new object[] { col, status, kind, expected };
                    }
                }
            }
        }

        private static PolicyResult Run(string col, int status, string kind)
        {
            var v = TwoValues(col);
            switch (kind)
            {
                case "unchanged":
                    return LockedColumnsPolicy.CheckUpdate(status, Row(Col(col, v.Item1)), Row(Col(col, v.Item1)));
                case "changed":
                    return LockedColumnsPolicy.CheckUpdate(status, Row(Col(col, v.Item2)), Row(Col(col, v.Item1)));
                case "null-to-value":
                    // an image holds non-null values only, so a null column is absent from the PreImage
                    return LockedColumnsPolicy.CheckUpdate(status, Row(Col(col, v.Item1)), Row());
                case "value-to-null":
                    return LockedColumnsPolicy.CheckUpdate(status, Row(Col(col, ColumnValue.Null)), Row(Col(col, v.Item1)));
                default:
                    throw new ArgumentException(kind);
            }
        }

        [Theory]
        [MemberData(nameof(Cells))]
        public void Column_write_in_status(string column, int status, string kind, bool expectedAllowed)
        {
            Assert.Equal(expectedAllowed, Run(column, status, kind).Allowed);
        }

        [Fact]
        public void The_matrix_has_every_cell()
        {
            Assert.Equal(8 * 4 * 4, new List<object[]>(Cells()).Count);
        }

        [Fact]
        public void Null_to_null_is_unchanged_in_every_status_for_every_guarded_column()
        {
            foreach (var status in Statuses)
            {
                foreach (var col in LockedAfterSubmission)
                {
                    Assert.True(LockedColumnsPolicy.CheckUpdate(status, Row(Col(col, ColumnValue.Null)), Row()).Allowed);
                }
                Assert.True(LockedColumnsPolicy.CheckUpdate(
                    status, Row(Col(ContractColumns.ValueUsdFrozen, ColumnValue.Null)), Row()).Allowed);
            }
        }

        [Fact]
        public void Subject_is_always_editable()
        {
            var s = TwoValues(ContractColumns.Subject);
            foreach (var status in Statuses)
            {
                var r = GuardEvaluator.EvaluateUpdate(status, null, null,
                    Row(Col(ContractColumns.Subject, s.Item2)), Row(Col(ContractColumns.Subject, s.Item1)));
                Assert.True(r.Allowed);
            }
        }

        [Fact]
        public void Absent_columns_are_not_changes()
        {
            foreach (var status in Statuses)
            {
                Assert.True(LockedColumnsPolicy.CheckUpdate(
                    status, Row(), Row(Col(ContractColumns.Value, ColumnValue.FromDecimal(5m)))).Allowed);
            }
        }

        [Fact]
        public void Unknown_status_is_treated_as_locked()
        {
            var v = TwoValues(ContractColumns.Value);
            var r = LockedColumnsPolicy.CheckUpdate(
                999, Row(Col(ContractColumns.Value, v.Item2)), Row(Col(ContractColumns.Value, v.Item1)));
            Assert.False(r.Allowed);
        }

        [Fact]
        public void Empty_string_over_null_counts_as_a_change_in_a_locked_status()
        {
            // strict by decision (ADR-004): "" is not null
            var r = LockedColumnsPolicy.CheckUpdate(ContractStatus.PendingApproval,
                Row(Col(ContractColumns.Number, ColumnValue.FromText(string.Empty))), Row());
            Assert.False(r.Allowed);
        }

        [Fact]
        public void Empty_string_over_null_is_allowed_in_draft()
        {
            var r = LockedColumnsPolicy.CheckUpdate(ContractStatus.Draft,
                Row(Col(ContractColumns.Number, ColumnValue.FromText(string.Empty))), Row());
            Assert.True(r.Allowed);
        }

        // ---- Create ----
        [Fact]
        public void Create_with_a_frozen_value_is_denied_including_zero()
        {
            Assert.False(LockedColumnsPolicy.CheckCreate(Row(Col(ContractColumns.ValueUsdFrozen, ColumnValue.FromDecimal(1m)))).Allowed);
            Assert.False(LockedColumnsPolicy.CheckCreate(Row(Col(ContractColumns.ValueUsdFrozen, ColumnValue.FromDecimal(0m)))).Allowed);
        }

        [Fact]
        public void Create_with_an_approval_round_is_denied_including_zero()
        {
            var one = LockedColumnsPolicy.CheckCreate(Row(Col(ContractColumns.ApprovalRound, ColumnValue.FromInt(1))));
            var zero = LockedColumnsPolicy.CheckCreate(Row(Col(ContractColumns.ApprovalRound, ColumnValue.FromInt(0))));
            Assert.False(one.Allowed);
            Assert.False(zero.Allowed);
            Assert.StartsWith("Approval Round cannot be changed.", one.Message);
        }

        [Fact]
        public void Create_with_approval_round_null_or_absent_is_allowed()
        {
            Assert.True(LockedColumnsPolicy.CheckCreate(Row(Col(ContractColumns.ApprovalRound, ColumnValue.Null))).Allowed);
        }

        [Fact]
        public void Update_changing_the_approval_round_names_the_column_in_every_status()
        {
            var v = TwoValues(ContractColumns.ApprovalRound);
            foreach (var status in Statuses)
            {
                var r = LockedColumnsPolicy.CheckUpdate(status,
                    Row(Col(ContractColumns.ApprovalRound, v.Item2)), Row(Col(ContractColumns.ApprovalRound, v.Item1)));
                Assert.False(r.Allowed);
                Assert.StartsWith("Approval Round cannot be changed.", r.Message);
            }
        }

        [Fact]
        public void Update_writing_the_same_approval_round_is_a_no_op()
        {
            var v = TwoValues(ContractColumns.ApprovalRound);
            foreach (var status in Statuses)
            {
                Assert.True(LockedColumnsPolicy.CheckUpdate(status,
                    Row(Col(ContractColumns.ApprovalRound, v.Item1)), Row(Col(ContractColumns.ApprovalRound, v.Item1))).Allowed);
            }
        }

        [Fact]
        public void Frozen_and_round_changed_together_name_both()
        {
            var f = TwoValues(ContractColumns.ValueUsdFrozen);
            var n = TwoValues(ContractColumns.ApprovalRound);
            var r = LockedColumnsPolicy.CheckUpdate(ContractStatus.Draft,
                Row(Col(ContractColumns.ValueUsdFrozen, f.Item2), Col(ContractColumns.ApprovalRound, n.Item2)),
                Row(Col(ContractColumns.ValueUsdFrozen, f.Item1), Col(ContractColumns.ApprovalRound, n.Item1)));
            Assert.False(r.Allowed);
            Assert.Contains("Value (USD, Frozen) cannot be changed.", r.Message);
            Assert.Contains("Approval Round cannot be changed.", r.Message);
        }

        [Fact]
        public void Create_with_frozen_null_or_absent_is_allowed()
        {
            Assert.True(LockedColumnsPolicy.CheckCreate(Row(Col(ContractColumns.ValueUsdFrozen, ColumnValue.Null))).Allowed);
            Assert.True(LockedColumnsPolicy.CheckCreate(Row()).Allowed);
        }

        [Fact]
        public void Create_may_set_every_other_guarded_column()
        {
            var cols = new List<Tuple<string, ColumnValue>>();
            foreach (var c in LockedAfterSubmission) cols.Add(Col(c, TwoValues(c).Item1));
            Assert.True(LockedColumnsPolicy.CheckCreate(Row(cols.ToArray())).Allowed);
        }

        // ---- messages ----
        [Fact]
        public void Locked_message_lists_the_display_names_and_the_status()
        {
            var v = TwoValues(ContractColumns.Value);
            var t = TwoValues(ContractColumns.Type);
            var r = LockedColumnsPolicy.CheckUpdate(ContractStatus.PendingApproval,
                Row(Col(ContractColumns.Value, v.Item2), Col(ContractColumns.Type, t.Item2)),
                Row(Col(ContractColumns.Value, v.Item1), Col(ContractColumns.Type, t.Item1)));
            Assert.Equal(
                "Cannot change Value, Contract Type while the contract status is Pending Approval. Return the contract to Draft first.",
                r.Message);
        }

        [Fact]
        public void In_force_message_says_the_contract_cannot_be_edited()
        {
            var v = TwoValues(ContractColumns.Number);
            var r = LockedColumnsPolicy.CheckUpdate(ContractStatus.InForce,
                Row(Col(ContractColumns.Number, v.Item2)), Row(Col(ContractColumns.Number, v.Item1)));
            Assert.Equal(
                "Cannot change Contract Number while the contract status is In Force. An In Force contract cannot be edited.",
                r.Message);
        }

        [Fact]
        public void Frozen_message_is_separate_and_names_the_column()
        {
            var v = TwoValues(ContractColumns.ValueUsdFrozen);
            var r = LockedColumnsPolicy.CheckUpdate(ContractStatus.Draft,
                Row(Col(ContractColumns.ValueUsdFrozen, v.Item2)), Row(Col(ContractColumns.ValueUsdFrozen, v.Item1)));
            Assert.False(r.Allowed);
            Assert.StartsWith("Value (USD, Frozen) cannot be changed.", r.Message);
        }
    }
}
