using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Muwafaqa.Plugins.Contract;
using Xunit;

namespace Muwafaqa.Plugins.Tests
{
    public class ApprovalChainPlannerTests
    {
        private const int DH = ApproverRole.DepartmentHead;
        private const int FM = ApproverRole.FinanceManager;
        private const int GM = ApproverRole.GeneralManager;
        private const int RO = ApproverRole.RegionalOffice;
        private const int OW = ApproverRole.Owner;
        private static readonly int[] AllRoles = { DH, FM, GM, RO, OW };

        private static decimal D(string v) { return decimal.Parse(v, CultureInfo.InvariantCulture); }

        private static MatrixRow Row(decimal min, decimal? max, int order, int role, int action = StepAction.Approve)
        {
            return new MatrixRow { Min = min, Max = max, StepOrder = order, Role = role, Action = action };
        }

        /// <summary>The structure of the fictional seed data of one type and direction: 4 bands, 1 + 2 + 3 + 5 steps.</summary>
        private static List<MatrixRow> Seed()
        {
            return new List<MatrixRow>
            {
                Row(0, 10000, 1, DH),
                Row(10000, 50000, 1, DH), Row(10000, 50000, 2, FM),
                Row(50000, 100000, 1, DH), Row(50000, 100000, 2, FM), Row(50000, 100000, 3, GM),
                Row(100000, null, 1, DH), Row(100000, null, 2, FM), Row(100000, null, 3, GM), Row(100000, null, 4, RO),
                Row(100000, null, 5, OW, StepAction.Inform),
            };
        }

        private static IReadOnlyList<PlannedStep> Plan(decimal? v, List<MatrixRow> rows = null, int[] roles = null)
        {
            return ApprovalChainPlanner.Plan(v, rows ?? Seed(), roles ?? AllRoles);
        }

        private static ChainError ErrorOf(decimal? v, List<MatrixRow> rows = null, int[] roles = null)
        {
            return Assert.Throws<ChainException>(() => Plan(v, rows, roles)).Error;
        }

        // ---- boundaries: bands are (Min, Max]
        [Theory]
        [InlineData("10000", 1)]
        [InlineData("10000.01", 2)]
        [InlineData("50000", 2)]
        [InlineData("50000.01", 3)]
        [InlineData("100000", 3)]
        [InlineData("100000.01", 5)]
        [InlineData("1", 1)]
        [InlineData("9999.99", 1)]
        [InlineData("99999999999", 5)]
        public void Boundaries_choose_the_band_by_min_exclusive_max_inclusive(string value, int expectedSteps)
        {
            Assert.Equal(expectedSteps, Plan(D(value)).Count);
        }

        [Fact]
        public void Top_band_has_five_steps_and_the_last_one_informs_the_owner()
        {
            var steps = Plan(250000m);
            Assert.Equal(new[] { 1, 2, 3, 4, 5 }, steps.Select(s => s.Order).ToArray());
            Assert.Equal(new[] { DH, FM, GM, RO, OW }, steps.Select(s => s.Role).ToArray());
            Assert.Equal(StepAction.Inform, steps[4].Action);
            Assert.All(steps.Take(4), s => Assert.Equal(StepAction.Approve, s.Action));
        }

        [Fact]
        public void First_band_has_one_step_department_head_approve()
        {
            var steps = Plan(5000m);
            Assert.Single(steps);
            Assert.Equal(DH, steps[0].Role);
            Assert.Equal(StepAction.Approve, steps[0].Action);
        }

        // ---- zero and negative
        [Theory]
        [InlineData("0")]
        [InlineData("0.00")]
        [InlineData("0.01")]
        public void Zero_and_a_cent_fall_on_the_first_band(string value)
        {
            Assert.Single(Plan(D(value)));
        }

        [Fact]
        public void Zero_with_two_bands_starting_at_zero_is_an_overlap()
        {
            var rows = Seed();
            rows.Add(Row(0, 500, 1, DH));
            Assert.Equal(ChainError.OverlappingBands, ErrorOf(0m, rows));
        }

        [Theory]
        [InlineData("-0.01")]
        [InlineData("-1")]
        [InlineData("-100000")]
        public void Negative_values_are_rejected(string value)
        {
            Assert.Equal(ChainError.ValueNegative, ErrorOf(D(value)));
        }

        [Fact]
        public void Empty_frozen_value_is_rejected()
        {
            Assert.Equal(ChainError.ValueMissing, ErrorOf(null));
        }

        [Fact]
        public void Messages_start_like_the_other_submission_messages_and_are_plain_english()
        {
            var ex = Assert.Throws<ChainException>(() => Plan(-5m));
            Assert.StartsWith("Cannot submit the contract. ", ex.Message);
            Assert.Contains("-5", ex.Message);
        }

        // ---- gaps and overlaps
        [Fact]
        public void A_gap_between_bands_rejects_a_value_inside_the_gap_only()
        {
            var rows = new List<MatrixRow> { Row(0, 10000, 1, DH), Row(20000, null, 1, DH) };
            Assert.Equal(ChainError.NoBand, ErrorOf(15000m, rows));
            Assert.Equal(ChainError.NoBand, ErrorOf(D("10000.01"), rows));
            Assert.Equal(ChainError.NoBand, ErrorOf(20000m, rows));   // Min is exclusive
            Assert.Single(Plan(10000m, rows));
            Assert.Single(Plan(D("20000.01"), rows));
        }

        [Fact]
        public void A_value_above_a_closed_last_band_has_no_band()
        {
            var rows = new List<MatrixRow> { Row(0, 10000, 1, DH) };
            Assert.Equal(ChainError.NoBand, ErrorOf(D("10000.01"), rows));
        }

        [Fact]
        public void Overlapping_bands_reject_a_value_in_the_overlap_only()
        {
            var rows = new List<MatrixRow> { Row(0, 10000, 1, DH), Row(5000, 20000, 1, DH) };
            Assert.Equal(ChainError.OverlappingBands, ErrorOf(7000m, rows));
            Assert.Equal(ChainError.OverlappingBands, ErrorOf(10000m, rows));
            Assert.Single(Plan(3000m, rows));
            Assert.Single(Plan(15000m, rows));
        }

        [Fact]
        public void No_rows_is_rejected()
        {
            Assert.Equal(ChainError.NoMatrixRows, ErrorOf(100m, new List<MatrixRow>()));
        }

        // ---- step orders
        [Theory]
        [InlineData(1, 3)]      // gap
        [InlineData(1, 1)]      // duplicate
        [InlineData(2, 3)]      // does not start at 1
        [InlineData(0, 1)]      // starts at 0
        public void Step_orders_must_be_1_to_n(int first, int second)
        {
            var rows = new List<MatrixRow> { Row(0, null, first, DH), Row(0, null, second, FM) };
            Assert.Equal(ChainError.StepOrderNotContiguous, ErrorOf(10m, rows));
        }

        [Fact]
        public void Rows_in_any_order_come_out_sorted_by_step_order()
        {
            var rows = Seed();
            rows.Reverse();
            Assert.Equal(new[] { 1, 2, 3, 4, 5 }, Plan(500000m, rows).Select(s => s.Order).ToArray());
        }

        // ---- no Approve step
        [Fact]
        public void A_chain_with_only_inform_steps_is_rejected()
        {
            var rows = new List<MatrixRow> { Row(0, null, 1, OW, StepAction.Inform), Row(0, null, 2, DH, StepAction.Inform) };
            Assert.Equal(ChainError.NoApproveStep, ErrorOf(10m, rows));
        }

        [Fact]
        public void An_inform_step_after_an_approve_step_is_accepted()
        {
            var rows = new List<MatrixRow> { Row(0, null, 1, DH), Row(0, null, 2, OW, StepAction.Inform) };
            Assert.Equal(2, Plan(10m, rows).Count);
        }

        // ---- assignments
        [Fact]
        public void A_role_without_an_active_assignment_is_rejected_and_named()
        {
            var ex = Assert.Throws<ChainException>(() => Plan(250000m, null, new[] { DH, FM, GM, RO }));   // Owner missing
            Assert.Equal(ChainError.MissingAssignment, ex.Error);
            Assert.Contains("Owner", ex.Message);
            Assert.DoesNotContain("Finance Manager", ex.Message);
        }

        [Fact]
        public void Only_the_roles_of_the_chosen_band_need_an_assignment()
        {
            Assert.Single(Plan(5000m, null, new[] { DH }));
        }

        [Fact]
        public void All_missing_roles_are_named()
        {
            var ex = Assert.Throws<ChainException>(() => Plan(75000m, null, new int[0]));
            Assert.Contains("Department Head", ex.Message);
            Assert.Contains("Finance Manager", ex.Message);
            Assert.Contains("General Manager", ex.Message);
        }

        // ---- invalid rows
        [Fact]
        public void An_incomplete_row_is_rejected()
        {
            var rows = Seed();
            rows[0].Role = null;
            Assert.Equal(ChainError.InvalidRow, ErrorOf(5000m, rows));
        }

        [Fact]
        public void A_band_with_max_not_above_min_is_rejected()
        {
            var rows = Seed();
            rows.Add(Row(200000, 200000, 1, DH));
            Assert.Equal(ChainError.InvalidRow, ErrorOf(5000m, rows));
        }

        [Fact]
        public void An_unknown_action_is_rejected()
        {
            var rows = Seed();
            rows[0].Action = 5;
            Assert.Equal(ChainError.InvalidRow, ErrorOf(5000m, rows));
        }

        [Fact]
        public void Role_names()
        {
            Assert.Equal("Department Head", ApproverRole.NameOf(DH));
            Assert.Equal("Owner", ApproverRole.NameOf(OW));
            Assert.Equal("role 7", ApproverRole.NameOf(7));
        }
    }
}
