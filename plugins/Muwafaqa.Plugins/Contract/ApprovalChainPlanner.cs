using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace Muwafaqa.Plugins.Contract
{
    /// <summary>Approver role values of the ApprovalMatrix, the Approval Step and the Approver Assignment tables (ADR-007).</summary>
    public static class ApproverRole
    {
        public const int DepartmentHead = 867640000;
        public const int FinanceManager = 867640001;
        public const int GeneralManager = 867640002;
        public const int RegionalOffice = 867640003;
        public const int Owner = 867640004;

        public static string NameOf(int role)
        {
            switch (role)
            {
                case DepartmentHead: return "Department Head";
                case FinanceManager: return "Finance Manager";
                case GeneralManager: return "General Manager";
                case RegionalOffice: return "Regional Office";
                case Owner: return "Owner";
                default: return "role " + role.ToString(CultureInfo.InvariantCulture);
            }
        }
    }

    /// <summary>Action type values (ApprovalMatrix and Approval Step).</summary>
    public static class StepAction
    {
        public const int Approve = 867640000;
        public const int Inform = 867640001;
    }

    /// <summary>Decision values of an Approval Step.</summary>
    public static class StepDecision
    {
        public const int Pending = 867640000;
        public const int Waiting = 867640001;
        public const int Approved = 867640002;
        public const int Rejected = 867640003;
        public const int Informed = 867640004;
        public const int Cancelled = 867640005;
    }

    /// <summary>One active ApprovalMatrix row of the contract type and direction, as read from Dataverse (nulls kept so they can be rejected).</summary>
    public sealed class MatrixRow
    {
        public decimal? Min { get; set; }
        public decimal? Max { get; set; }
        public int? StepOrder { get; set; }
        public int? Role { get; set; }
        public int? Action { get; set; }
    }

    /// <summary>One step of the chain to create.</summary>
    public sealed class PlannedStep
    {
        public int Order { get; set; }
        public int Role { get; set; }
        public int Action { get; set; }
    }

    public enum ChainError
    {
        ValueMissing,
        ValueNegative,
        NoMatrixRows,
        InvalidRow,
        NoBand,
        OverlappingBands,
        StepOrderNotContiguous,
        NoApproveStep,
        MissingAssignment,
    }

    public sealed class ChainException : Exception
    {
        public ChainError Error { get; }

        public ChainException(ChainError error, string message) : base(message)
        {
            Error = error;
        }
    }

    /// <summary>
    /// Pure decision of ADR-007: which band of the ApprovalMatrix covers the frozen USD value, and is its chain valid.
    /// Bands are (Min, Max]: Min exclusive, Max inclusive, an empty Max has no upper limit. A value of exactly 0 falls on the band whose Min is 0.
    /// Fails closed: anything unexpected throws a ChainException whose message is shown to the user.
    /// No Dataverse types are used, so it is unit tested on its own.
    /// </summary>
    public static class ApprovalChainPlanner
    {
        private const string Prefix = "Cannot submit the contract. ";

        public static bool Covers(decimal value, decimal min, decimal? max)
        {
            var aboveMin = value > min || (value == 0m && min == 0m);
            return aboveMin && (!max.HasValue || value <= max.Value);
        }

        /// <param name="valueUsd">The frozen USD value of the contract.</param>
        /// <param name="rows">The ACTIVE matrix rows of the contract type and direction.</param>
        /// <param name="rolesWithActiveAssignment">Roles that have an active Approver Assignment row.</param>
        /// <returns>The steps of the chain, ordered 1..n.</returns>
        public static IReadOnlyList<PlannedStep> Plan(decimal? valueUsd, IEnumerable<MatrixRow> rows, ICollection<int> rolesWithActiveAssignment)
        {
            if (!valueUsd.HasValue)
            {
                throw new ChainException(ChainError.ValueMissing, Prefix + "The frozen USD value is empty, so the approval chain cannot be chosen.");
            }
            var value = valueUsd.Value;
            if (value < 0m)
            {
                throw new ChainException(ChainError.ValueNegative, Prefix + "The value is negative (" + Format(value) + " USD); no approval band covers it.");
            }

            var all = (rows ?? Enumerable.Empty<MatrixRow>()).ToList();
            if (all.Count == 0)
            {
                throw new ChainException(ChainError.NoMatrixRows, Prefix + "The ApprovalMatrix has no active rows for this contract type and direction.");
            }
            foreach (var r in all)
            {
                if (!r.Min.HasValue || !r.StepOrder.HasValue || !r.Role.HasValue || !r.Action.HasValue
                    || (r.Max.HasValue && r.Max.Value <= r.Min.Value)
                    || (r.Action.Value != StepAction.Approve && r.Action.Value != StepAction.Inform))
                {
                    throw new ChainException(ChainError.InvalidRow,
                        Prefix + "An active ApprovalMatrix row is incomplete or not valid (Min, step order, role and action are required, and Max must be greater than Min).");
                }
            }

            var bands = all
                .Where(r => Covers(value, r.Min.Value, r.Max))
                .GroupBy(r => new { r.Min, r.Max })
                .ToList();
            if (bands.Count == 0)
            {
                throw new ChainException(ChainError.NoBand, Prefix + "No approval band of the ApprovalMatrix covers the value " + Format(value) + " USD for this contract type and direction.");
            }
            if (bands.Count > 1)
            {
                throw new ChainException(ChainError.OverlappingBands, Prefix + "More than one approval band covers the value " + Format(value) + " USD (the bands overlap). Fix the ApprovalMatrix.");
            }

            var steps = bands[0].OrderBy(r => r.StepOrder.Value).ToList();
            for (var i = 0; i < steps.Count; i++)
            {
                if (steps[i].StepOrder.Value != i + 1)
                {
                    throw new ChainException(ChainError.StepOrderNotContiguous,
                        Prefix + "The step orders of the approval band are not 1 to " + steps.Count.ToString(CultureInfo.InvariantCulture) + " without gaps or duplicates.");
                }
            }
            if (!steps.Any(s => s.Action.Value == StepAction.Approve))
            {
                throw new ChainException(ChainError.NoApproveStep, Prefix + "The approval chain has no Approve step (only Inform steps).");
            }

            var assigned = rolesWithActiveAssignment ?? new List<int>();
            var missing = steps.Select(s => s.Role.Value).Distinct().Where(role => !assigned.Contains(role)).ToList();
            if (missing.Count > 0)
            {
                throw new ChainException(ChainError.MissingAssignment,
                    Prefix + "No active Approver Assignment for: " + string.Join(", ", missing.Select(ApproverRole.NameOf)) + ".");
            }

            return steps.Select(s => new PlannedStep { Order = s.StepOrder.Value, Role = s.Role.Value, Action = s.Action.Value }).ToList();
        }

        private static string Format(decimal value)
        {
            return value.ToString("0.##", CultureInfo.InvariantCulture);
        }
    }
}
