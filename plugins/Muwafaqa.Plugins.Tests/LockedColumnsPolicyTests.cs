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

        // 4 locked-after-draft columns + 3 system-written columns (contract number, frozen USD value, approval round)
        // + 1 set-once column (contract type), x 4 statuses, x 4 kinds of write = 128 cells
        public static IEnumerable<object[]> Cells()
        {
            var columns = new List<string>(LockedAfterSubmission);
            columns.AddRange(SystemWritten);
            columns.Add(ContractColumns.Type);
            foreach (var col in columns)
            {
                foreach (var status in Statuses)
                {
                    foreach (var kind in Kinds)
                    {
                        var editableInDraft = Array.IndexOf(LockedAfterSubmission, col) >= 0;
                        // the approval round is rejected whenever it is in the Target, even unchanged (SystemOnly, ADR-005)
                        var expected = col == ContractColumns.ApprovalRound
                            ? false
                            : kind == "unchanged" || (editableInDraft && status == ContractStatus.Draft);
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
                var every = new List<string>(LockedAfterSubmission);
                every.AddRange(SystemWritten);
                every.Remove(ContractColumns.ApprovalRound);   // SystemOnly: even a null in the Target is rejected (own test below)
                every.Add(ContractColumns.Type);
                foreach (var col in every)
                {
                    Assert.True(LockedColumnsPolicy.CheckUpdate(status, Row(Col(col, ColumnValue.Null)), Row()).Allowed);
                }
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
        public void Empty_string_over_null_is_denied_for_the_contract_number_in_every_status()
        {
            // the number is system-written (ADR-006): any change is rejected, in Draft too
            foreach (var status in Statuses)
            {
                var r = LockedColumnsPolicy.CheckUpdate(status,
                    Row(Col(ContractColumns.Number, ColumnValue.FromText(string.Empty))), Row());
                Assert.False(r.Allowed);
            }
        }

        // ---- Create ----
        [Fact]
        public void Create_with_a_frozen_value_is_denied_including_zero()
        {
            Assert.False(LockedColumnsPolicy.CheckCreate(ValidCreateRow(Col(ContractColumns.ValueUsdFrozen, ColumnValue.FromDecimal(1m)))).Allowed);
            Assert.False(LockedColumnsPolicy.CheckCreate(ValidCreateRow(Col(ContractColumns.ValueUsdFrozen, ColumnValue.FromDecimal(0m)))).Allowed);
        }

        [Fact]
        public void Create_with_an_approval_round_is_denied_including_zero()
        {
            var one = LockedColumnsPolicy.CheckCreate(ValidCreateRow(Col(ContractColumns.ApprovalRound, ColumnValue.FromInt(1))));
            var zero = LockedColumnsPolicy.CheckCreate(ValidCreateRow(Col(ContractColumns.ApprovalRound, ColumnValue.FromInt(0))));
            Assert.False(one.Allowed);
            Assert.False(zero.Allowed);
            Assert.StartsWith("Approval Round cannot be changed.", one.Message);
        }

        [Fact]
        public void Create_with_approval_round_null_or_absent_is_allowed()
        {
            Assert.True(LockedColumnsPolicy.CheckCreate(ValidCreateRow(Col(ContractColumns.ApprovalRound, ColumnValue.Null))).Allowed);
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
        public void Update_writing_an_EQUAL_approval_round_is_rejected_in_every_status()
        {
            var v = TwoValues(ContractColumns.ApprovalRound);
            foreach (var status in Statuses)
            {
                var r = LockedColumnsPolicy.CheckUpdate(status,
                    Row(Col(ContractColumns.ApprovalRound, v.Item1)), Row(Col(ContractColumns.ApprovalRound, v.Item1)));
                Assert.False(r.Allowed);
                Assert.StartsWith("Approval Round cannot be changed. It is written by the system when the contract is submitted.", r.Message);
            }
        }

        [Fact]
        public void Update_writing_an_EQUAL_approval_round_is_rejected_even_without_a_PreImage_value()
        {
            // the PreImage has no approval round column (9 columns): the decision must not depend on it
            foreach (var status in Statuses)
            {
                Assert.False(LockedColumnsPolicy.CheckUpdate(status,
                    Row(Col(ContractColumns.ApprovalRound, ColumnValue.FromInt(2))), Row()).Allowed);
            }
        }

        [Fact]
        public void Update_writing_null_to_the_approval_round_is_rejected()
        {
            foreach (var status in Statuses)
            {
                Assert.False(LockedColumnsPolicy.CheckUpdate(status,
                    Row(Col(ContractColumns.ApprovalRound, ColumnValue.Null)), Row()).Allowed);
            }
        }

        [Fact]
        public void Update_without_the_approval_round_in_the_Target_is_not_rejected()
        {
            // absent = not sent by the client (this is every normal save, and plug-in 1's own write is invisible to the guard)
            foreach (var status in Statuses)
            {
                var s = TwoValues(ContractColumns.Subject);
                Assert.True(GuardEvaluator.EvaluateUpdate(status, null, null,
                    Row(Col(ContractColumns.Subject, s.Item2)), Row(Col(ContractColumns.ApprovalRound, ColumnValue.FromInt(2)))).Allowed);
            }
        }

        [Fact]
        public void Update_writing_an_EQUAL_frozen_value_is_still_a_no_op()
        {
            var v = TwoValues(ContractColumns.ValueUsdFrozen);
            foreach (var status in Statuses)
            {
                Assert.True(LockedColumnsPolicy.CheckUpdate(status,
                    Row(Col(ContractColumns.ValueUsdFrozen, v.Item1)), Row(Col(ContractColumns.ValueUsdFrozen, v.Item1))).Allowed);
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
            Assert.True(LockedColumnsPolicy.CheckCreate(ValidCreateRow(Col(ContractColumns.ValueUsdFrozen, ColumnValue.Null))).Allowed);
            Assert.True(LockedColumnsPolicy.CheckCreate(ValidCreateRow()).Allowed);
        }

        [Fact]
        public void Create_may_set_every_other_guarded_column()
        {
            var cols = new List<Tuple<string, ColumnValue>>();
            foreach (var c in LockedAfterSubmission) cols.Add(Col(c, TwoValues(c).Item1));
            Assert.True(LockedColumnsPolicy.CheckCreate(ValidCreateRow(cols.ToArray())).Allowed);
        }

        // ---- messages ----
        [Fact]
        public void Locked_message_lists_the_display_names_and_the_status()
        {
            var v = TwoValues(ContractColumns.Value);
            var t = TwoValues(ContractColumns.Direction);
            var r = LockedColumnsPolicy.CheckUpdate(ContractStatus.PendingApproval,
                Row(Col(ContractColumns.Value, v.Item2), Col(ContractColumns.Direction, t.Item2)),
                Row(Col(ContractColumns.Value, v.Item1), Col(ContractColumns.Direction, t.Item1)));
            Assert.Equal(
                "Cannot change Value, Contract Direction while the contract status is Pending Approval. Return the contract to Draft first.",
                r.Message);
        }

        [Fact]
        public void In_force_message_says_the_contract_cannot_be_edited()
        {
            var v = TwoValues(ContractColumns.Value);
            var r = LockedColumnsPolicy.CheckUpdate(ContractStatus.InForce,
                Row(Col(ContractColumns.Value, v.Item2)), Row(Col(ContractColumns.Value, v.Item1)));
            Assert.Equal(
                "Cannot change Value while the contract status is In Force. An In Force contract cannot be edited.",
                r.Message);
        }

        // ---- ADR-006: contract number (system-written) and contract type (set once) ----
        [Fact]
        public void Create_with_a_contract_number_is_denied()
        {
            var r = LockedColumnsPolicy.CheckCreate(ValidCreateRow(Col(ContractColumns.Number, ColumnValue.FromText("MNT-0001"))));
            Assert.False(r.Allowed);
            Assert.Equal("Contract Number is generated by the system; leave it empty.", r.Message);
        }

        [Fact]
        public void Create_with_a_frozen_value_or_round_keeps_the_submitted_by_system_text()
        {
            var r = LockedColumnsPolicy.CheckCreate(ValidCreateRow(Col(ContractColumns.ValueUsdFrozen, ColumnValue.FromDecimal(1m))));
            Assert.Equal("Value (USD, Frozen) cannot be changed. It is written by the system when the contract is submitted.", r.Message);
        }

        [Fact]
        public void Create_with_an_empty_or_null_contract_number_counts_as_not_supplied()
        {
            Assert.True(LockedColumnsPolicy.CheckCreate(ValidCreateRow(Col(ContractColumns.Number, ColumnValue.FromText(string.Empty)))).Allowed);
            Assert.True(LockedColumnsPolicy.CheckCreate(ValidCreateRow(Col(ContractColumns.Number, ColumnValue.Null))).Allowed);
            Assert.True(LockedColumnsPolicy.CheckCreate(ValidCreateRow()).Allowed);
        }

        [Fact]
        public void Create_without_a_contract_type_is_denied_when_absent_or_null()
        {
            var absent = LockedColumnsPolicy.CheckCreate(Row());
            var nul = LockedColumnsPolicy.CheckCreate(Row(Col(ContractColumns.Type, ColumnValue.Null)));
            Assert.False(absent.Allowed);
            Assert.False(nul.Allowed);
            Assert.Equal("Contract Type is required. The contract number is built from it.", absent.Message);
        }

        [Fact]
        public void Create_with_a_contract_type_is_allowed()
        {
            Assert.True(LockedColumnsPolicy.CheckCreate(Row(Col(ContractColumns.Type, ColumnValue.FromInt(867640003)))).Allowed);
        }

        [Fact]
        public void Update_changing_the_contract_type_is_denied_in_every_status_including_draft()
        {
            var v = TwoValues(ContractColumns.Type);
            foreach (var status in Statuses)
            {
                var r = LockedColumnsPolicy.CheckUpdate(status,
                    Row(Col(ContractColumns.Type, v.Item2)), Row(Col(ContractColumns.Type, v.Item1)));
                Assert.False(r.Allowed);
                Assert.StartsWith("Contract Type cannot be changed after the contract is created.", r.Message);
                Assert.Contains("Delete the Draft contract and create a new one", r.Message);
            }
        }

        [Fact]
        public void Update_changing_the_contract_number_is_denied_in_every_status_including_draft()
        {
            var v = TwoValues(ContractColumns.Number);
            foreach (var status in Statuses)
            {
                var r = LockedColumnsPolicy.CheckUpdate(status,
                    Row(Col(ContractColumns.Number, v.Item2)), Row(Col(ContractColumns.Number, v.Item1)));
                Assert.False(r.Allowed);
                Assert.StartsWith("Contract Number cannot be changed. It is generated by the system when the contract is created.", r.Message);
            }
        }

        [Fact]
        public void Update_writing_the_same_type_or_number_is_a_no_op_in_every_status()
        {
            foreach (var status in Statuses)
            {
                foreach (var col in new[] { ContractColumns.Type, ContractColumns.Number })
                {
                    var v = TwoValues(col);
                    Assert.True(LockedColumnsPolicy.CheckUpdate(status, Row(Col(col, v.Item1)), Row(Col(col, v.Item1))).Allowed);
                }
            }
        }

        [Fact]
        public void A_legacy_number_stays_and_another_column_can_still_be_edited_in_draft()
        {
            var s = TwoValues(ContractColumns.Subject);
            var r = GuardEvaluator.EvaluateUpdate(ContractStatus.Draft, null, null,
                Row(Col(ContractColumns.Subject, s.Item2)), Row(Col(ContractColumns.Number, ColumnValue.FromText("TEST-CT-0001"))));
            Assert.True(r.Allowed);
        }

        [Fact]
        public void The_system_written_and_set_once_columns_are_the_expected_ones()
        {
            var systemWritten = new List<string>();
            var setOnce = new List<string>();
            var systemOnly = new List<string>();
            foreach (var c in LockedColumnsPolicy.Columns)
            {
                if (c.Lock == ColumnLock.SystemOnly) systemOnly.Add(c.LogicalName);
                if (c.Lock == ColumnLock.SystemWritten) systemWritten.Add(c.LogicalName);
                if (c.Lock == ColumnLock.SetOnce) setOnce.Add(c.LogicalName);
            }
            Assert.Equal(new[] { ContractColumns.Number, ContractColumns.ValueUsdFrozen }, systemWritten);
            Assert.Equal(new[] { ContractColumns.ApprovalRound }, systemOnly);
            Assert.Equal(new[] { ContractColumns.Type }, setOnce);
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
