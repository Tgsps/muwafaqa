using System;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace Muwafaqa.Plugins.Contract
{
    /// <summary>
    /// When a contract ENTERS Pending Approval, writes mwf_valueusdfrozen on the Target.
    /// Registered on Create and Update of mwf_contract, PreOperation (20), synchronous.
    /// Update step: filtering attribute statuscode, PreImage "pre" with statuscode, mwf_value, transactioncurrencyid.
    /// On the same condition it also sets mwf_approvalround = current value (retrieved, never the client value) + 1.
    /// </summary>
    public class FreezeUsdValueOnSubmission : PluginBase
    {
        private const int PreOperationStage = 20;
        private const int SynchronousMode = 0;

        public FreezeUsdValueOnSubmission(string unsecureConfiguration, string secureConfiguration)
            : base(typeof(FreezeUsdValueOnSubmission))
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

            if (!string.Equals(context.PrimaryEntityName, ContractColumns.EntityName, StringComparison.Ordinal))
            {
                return;
            }
            if (context.Stage != PreOperationStage || context.Mode != SynchronousMode)
            {
                // A write to the Target is only persisted in a synchronous PreOperation step.
                throw new InvalidPluginExecutionException(
                    "FreezeUsdValueOnSubmission must be registered as a synchronous PreOperation step.");
            }

            var target = context.InputParameters.Contains("Target")
                ? context.InputParameters["Target"] as Entity
                : null;
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

            if (context.MessageName == "Update" && targetStatus == SubmissionDetector.PendingApproval && pre == null)
            {
                throw new InvalidPluginExecutionException(
                    "FreezeUsdValueOnSubmission needs a PreImage named '" + ContractColumns.PreImageName + "' on Update.");
            }

            if (!SubmissionDetector.EntersPendingApproval(context.MessageName, targetStatus, StatusOf(pre)))
            {
                trace.Trace("Not entering Pending Approval. Nothing to do.");
                return;
            }

            // On Update the Target holds only changed columns, so fall back to the PreImage.
            var value = Effective<Money>(target, pre, ContractColumns.Value)?.Value;
            var currencyRef = Effective<EntityReference>(target, pre, ContractColumns.Currency);

            try
            {
                // System user (null) for reading the reference table only; see ADR-003.
                var reader = localPluginContext.OrgSvcFactory.CreateOrganizationService(null);

                CurrencyRate contractCurrency = currencyRef == null
                    ? null
                    : CurrencyRateReader.ReadById(reader, currencyRef.Id);
                CurrencyRate usd = CurrencyRateReader.ReadActiveUsd(reader);

                var result = UsdValueCalculator.Compute(value, contractCurrency, usd);

                // Approval round: the CURRENT value comes from the stored row (never from the client Target); a Create has none.
                int? currentRound = null;
                if (context.MessageName == "Update")
                {
                    var stored = reader.Retrieve(ContractColumns.EntityName, context.PrimaryEntityId, new ColumnSet(ContractColumns.ApprovalRound));
                    currentRound = stored.GetAttributeValue<int?>(ContractColumns.ApprovalRound);
                }
                var round = ApprovalRound.Next(currentRound);

                target[ContractColumns.ValueUsdFrozen] = result;
                target[ContractColumns.ApprovalRound] = round;
                trace.Trace("USD value frozen from currency " + (contractCurrency?.IsoCode ?? "n/a") + "; approval round " + round + ".");
            }
            catch (UsdValueException ex)
            {
                trace.Trace("USD value not frozen: " + ex.Error);
                throw new InvalidPluginExecutionException("Cannot submit the contract. " + ex.Message, ex);
            }
        }

        private static int? StatusOf(Entity entity)
        {
            return entity == null
                ? (int?)null
                : entity.GetAttributeValue<OptionSetValue>(ContractColumns.StatusCode)?.Value;
        }

        private static T Effective<T>(Entity target, Entity pre, string column) where T : class
        {
            if (target.Contains(column))
            {
                return target.GetAttributeValue<T>(column);
            }
            return pre?.GetAttributeValue<T>(column);
        }
    }
}
