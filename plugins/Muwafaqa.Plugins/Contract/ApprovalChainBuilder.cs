using System;
using System.Collections.Generic;
using System.Globalization;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace Muwafaqa.Plugins.Contract
{
    /// <summary>Logical names of the approval chain tables (ADR-007).</summary>
    internal static class ChainColumns
    {
        public const string MatrixEntity = "mwf_approvalmatrix";
        public const string MatrixType = "mwf_contracttype";
        public const string MatrixDirection = "mwf_contractdirection";
        public const string MatrixMin = "mwf_minvalueusd";
        public const string MatrixMax = "mwf_maxvalueusd";
        public const string MatrixStepOrder = "mwf_steporder";
        public const string MatrixRole = "mwf_approverrole";
        public const string MatrixAction = "mwf_actiontype";

        public const string AssignmentEntity = "mwf_approverassignment";
        public const string AssignmentRole = "mwf_approverrole";
        public const string AssignmentUser = "mwf_user";

        public const string StepEntity = "mwf_approvalstep";
        public const string StepName = "mwf_name";
        public const string StepContract = "mwf_contract";
        public const string StepRound = "mwf_approvalround";
        public const string StepOrder = "mwf_steporder";
        public const string StepRole = "mwf_approverrole";
        public const string StepAction = "mwf_actiontype";
        public const string StepDecision = "mwf_decision";
        public const string StepOriginalApprover = "mwf_originalapprover";
    }

    /// <summary>
    /// Builds the approval chain when a contract is really submitted (ADR-007). Registered on Update of mwf_contract,
    /// PostOperation (40), synchronous, filtering attribute statuscode, PreImage "pre" with statuscode only.
    ///
    /// It works only on a real submission (previous status not Pending Approval, new status Pending Approval), the same definition as
    /// FreezeUsdValueOnSubmission, which has already written the frozen USD value and the approval round in PreOperation of the same
    /// operation. Everything runs under the SYSTEM user and inside the database transaction of the contract update: an exception
    /// (InvalidPluginExecutionException) rolls the whole transaction back, so the contract stays in its previous status (Microsoft Learn,
    /// Event Framework: "An exception thrown by your code at any synchronous stage within the database transaction causes the entire
    /// transaction to roll back").
    ///
    /// Steps: read the contract, read the active matrix rows of its type and direction and the active assignments, let the pure
    /// ApprovalChainPlanner choose the band and validate the chain, cancel the open steps of older rounds, create one step per row.
    /// If steps of the current round already exist (the platform can call an Update step twice in some cases) it does nothing.
    /// </summary>
    public class ApprovalChainBuilder : PluginBase
    {
        private const int PostOperationStage = 40;
        private const int SynchronousMode = 0;

        public ApprovalChainBuilder(string unsecureConfiguration, string secureConfiguration)
            : base(typeof(ApprovalChainBuilder))
        {
        }

        protected override void ExecuteDataversePlugin(ILocalPluginContext localPluginContext)
        {
            if (localPluginContext == null)
            {
                throw new ArgumentNullException(nameof(localPluginContext));
            }

            var context = localPluginContext.PluginExecutionContext;
            var trace = localPluginContext.TracingService;

            if (!string.Equals(context.PrimaryEntityName, ContractColumns.EntityName, StringComparison.Ordinal)
                || !string.Equals(context.MessageName, "Update", StringComparison.Ordinal))
            {
                return;
            }
            if (context.Stage != PostOperationStage || context.Mode != SynchronousMode)
            {
                // Only a synchronous step inside the transaction can roll the submission back.
                throw new InvalidPluginExecutionException(
                    "ApprovalChainBuilder must be registered as a synchronous PostOperation step.");
            }

            var target = context.InputParameters.Contains("Target") ? context.InputParameters["Target"] as Entity : null;
            if (target == null)
            {
                return;
            }

            var targetStatus = StatusOf(target);
            Entity pre = null;
            if (context.PreEntityImages.Contains(ContractColumns.PreImageName))
            {
                pre = context.PreEntityImages[ContractColumns.PreImageName];
            }
            if (targetStatus == SubmissionDetector.PendingApproval && pre == null)
            {
                throw new InvalidPluginExecutionException(
                    "ApprovalChainBuilder needs a PreImage named '" + ContractColumns.PreImageName + "' on Update.");
            }
            if (!SubmissionDetector.EntersPendingApproval("Update", targetStatus, StatusOf(pre)))
            {
                trace.Trace("Not a real submission. Nothing to do.");
                return;
            }

            try
            {
                var svc = localPluginContext.OrgSvcFactory.CreateOrganizationService(null);   // SYSTEM: no user needs a privilege on the chain tables
                var contractId = context.PrimaryEntityId;

                var contract = svc.Retrieve(ContractColumns.EntityName, contractId, new ColumnSet(
                    ContractColumns.Number, ContractColumns.Type, ContractColumns.Direction, ContractColumns.ValueUsdFrozen, ContractColumns.ApprovalRound));
                var type = contract.GetAttributeValue<OptionSetValue>(ContractColumns.Type)?.Value;
                var direction = contract.GetAttributeValue<OptionSetValue>(ContractColumns.Direction)?.Value;
                var round = contract.GetAttributeValue<int?>(ContractColumns.ApprovalRound);
                if (!type.HasValue || !direction.HasValue)
                {
                    throw new ChainException(ChainError.NoMatrixRows, "Cannot submit the contract. The contract type or direction is empty, so the approval chain cannot be chosen.");
                }
                if (!round.HasValue || round.Value < 1)
                {
                    throw new InvalidPluginExecutionException("Cannot submit the contract. The approval round was not set, so the approval chain cannot be built.");
                }

                // Already built for this round (a repeated call of the same operation): nothing to add, and nothing to cancel.
                var existing = new QueryExpression(ChainColumns.StepEntity) { ColumnSet = new ColumnSet(false), TopCount = 1 };
                existing.Criteria.AddCondition(ChainColumns.StepContract, ConditionOperator.Equal, contractId);
                existing.Criteria.AddCondition(ChainColumns.StepRound, ConditionOperator.Equal, round.Value);
                if (svc.RetrieveMultiple(existing).Entities.Count > 0)
                {
                    trace.Trace("Steps of round " + round.Value + " already exist. Nothing to do.");
                    return;
                }

                var rows = ReadMatrix(svc, type.Value, direction.Value);
                var users = ReadAssignments(svc);
                var plan = ApprovalChainPlanner.Plan(
                    contract.GetAttributeValue<decimal?>(ContractColumns.ValueUsdFrozen), rows, new List<int>(users.Keys));

                var cancelled = CancelOpenStepsOfOlderRounds(svc, contractId, round.Value);

                var number = contract.GetAttributeValue<string>(ContractColumns.Number) ?? "(no number)";
                foreach (var step in plan)
                {
                    var e = new Entity(ChainColumns.StepEntity);
                    e[ChainColumns.StepName] = number + " R" + round.Value.ToString(CultureInfo.InvariantCulture)
                        + " S" + step.Order.ToString(CultureInfo.InvariantCulture) + " " + ApproverRole.NameOf(step.Role);
                    e[ChainColumns.StepContract] = new EntityReference(ContractColumns.EntityName, contractId);
                    e[ChainColumns.StepRound] = round.Value;
                    e[ChainColumns.StepOrder] = step.Order;
                    e[ChainColumns.StepRole] = new OptionSetValue(step.Role);
                    e[ChainColumns.StepAction] = new OptionSetValue(step.Action);
                    e[ChainColumns.StepDecision] = new OptionSetValue(StepDecision.Pending);
                    e[ChainColumns.StepOriginalApprover] = users[step.Role];
                    svc.Create(e);
                }
                trace.Trace("Chain built: round " + round.Value + ", " + plan.Count + " step(s); " + cancelled + " open step(s) of older rounds cancelled.");
            }
            catch (ChainException ex)
            {
                trace.Trace("Chain not built: " + ex.Error);
                throw new InvalidPluginExecutionException(ex.Message, ex);
            }
        }

        private static List<MatrixRow> ReadMatrix(IOrganizationService svc, int type, int direction)
        {
            var q = new QueryExpression(ChainColumns.MatrixEntity)
            {
                ColumnSet = new ColumnSet(ChainColumns.MatrixMin, ChainColumns.MatrixMax, ChainColumns.MatrixStepOrder, ChainColumns.MatrixRole, ChainColumns.MatrixAction),
            };
            q.Criteria.AddCondition("statecode", ConditionOperator.Equal, 0);
            q.Criteria.AddCondition(ChainColumns.MatrixType, ConditionOperator.Equal, type);
            q.Criteria.AddCondition(ChainColumns.MatrixDirection, ConditionOperator.Equal, direction);
            var rows = new List<MatrixRow>();
            foreach (var e in RetrieveAll(svc, q))
            {
                rows.Add(new MatrixRow
                {
                    Min = e.GetAttributeValue<decimal?>(ChainColumns.MatrixMin),
                    Max = e.GetAttributeValue<decimal?>(ChainColumns.MatrixMax),
                    StepOrder = e.GetAttributeValue<int?>(ChainColumns.MatrixStepOrder),
                    Role = e.GetAttributeValue<OptionSetValue>(ChainColumns.MatrixRole)?.Value,
                    Action = e.GetAttributeValue<OptionSetValue>(ChainColumns.MatrixAction)?.Value,
                });
            }
            return rows;
        }

        /// <summary>Role value to the user of its ACTIVE assignment row. A row without a user is treated as no assignment.</summary>
        private static Dictionary<int, EntityReference> ReadAssignments(IOrganizationService svc)
        {
            var q = new QueryExpression(ChainColumns.AssignmentEntity) { ColumnSet = new ColumnSet(ChainColumns.AssignmentRole, ChainColumns.AssignmentUser) };
            q.Criteria.AddCondition("statecode", ConditionOperator.Equal, 0);
            var users = new Dictionary<int, EntityReference>();
            foreach (var e in RetrieveAll(svc, q))
            {
                var role = e.GetAttributeValue<OptionSetValue>(ChainColumns.AssignmentRole)?.Value;
                var user = e.GetAttributeValue<EntityReference>(ChainColumns.AssignmentUser);
                if (role.HasValue && user != null)
                {
                    users[role.Value] = user;
                }
            }
            return users;
        }

        /// <summary>Sets Cancelled on the steps of older rounds that are still Pending or Waiting. Nothing is deleted.</summary>
        private static int CancelOpenStepsOfOlderRounds(IOrganizationService svc, Guid contractId, int round)
        {
            var q = new QueryExpression(ChainColumns.StepEntity) { ColumnSet = new ColumnSet(ChainColumns.StepDecision) };
            q.Criteria.AddCondition(ChainColumns.StepContract, ConditionOperator.Equal, contractId);
            q.Criteria.AddCondition(ChainColumns.StepRound, ConditionOperator.LessThan, round);
            q.Criteria.AddCondition(ChainColumns.StepDecision, ConditionOperator.In, StepDecision.Pending, StepDecision.Waiting);
            var n = 0;
            foreach (var old in RetrieveAll(svc, q))
            {
                var u = new Entity(ChainColumns.StepEntity, old.Id);
                u[ChainColumns.StepDecision] = new OptionSetValue(StepDecision.Cancelled);
                svc.Update(u);
                n++;
            }
            return n;
        }

        private static List<Entity> RetrieveAll(IOrganizationService svc, QueryExpression q)
        {
            var all = new List<Entity>();
            q.PageInfo = new PagingInfo { PageNumber = 1, Count = 500 };
            while (true)
            {
                var page = svc.RetrieveMultiple(q);
                all.AddRange(page.Entities);
                if (!page.MoreRecords)
                {
                    return all;
                }
                q.PageInfo.PageNumber++;
                q.PageInfo.PagingCookie = page.PagingCookie;
            }
        }

        private static int? StatusOf(Entity entity)
        {
            return entity == null
                ? (int?)null
                : entity.GetAttributeValue<OptionSetValue>(ContractColumns.StatusCode)?.Value;
        }
    }
}
